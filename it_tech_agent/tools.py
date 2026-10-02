"""Diagnostic tools exposed to the IT tech agent.

Every tool except ``run_command`` is read-only. ``run_command`` asks the
operator for confirmation before executing anything.
"""

from __future__ import annotations

import json
import platform
import shlex
import shutil
import socket
import subprocess
import time
from pathlib import Path
from typing import Callable

import psutil
from anthropic import beta_tool

MAX_OUTPUT_CHARS = 8000

# Replaced by the CLI so tests and non-interactive callers can control approval.
confirm: Callable[[str], bool] = lambda command: input(
    f"\nAgent wants to run: {command}\nAllow? [y/N] "
).strip().lower() in {"y", "yes"}


def _truncate(text: str) -> str:
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    return text[:MAX_OUTPUT_CHARS] + f"\n... [truncated {len(text) - MAX_OUTPUT_CHARS} chars]"


def _gb(n: float) -> float:
    return round(n / 1024**3, 2)


@beta_tool
def get_system_info() -> str:
    """Get OS, hostname, CPU, memory, uptime, and Python details for this machine."""
    vm = psutil.virtual_memory()
    return json.dumps(
        {
            "hostname": socket.gethostname(),
            "os": platform.platform(),
            "architecture": platform.machine(),
            "cpu_count_logical": psutil.cpu_count(),
            "cpu_percent": psutil.cpu_percent(interval=0.5),
            "load_avg": list(psutil.getloadavg()) if hasattr(psutil, "getloadavg") else None,
            "memory_total_gb": _gb(vm.total),
            "memory_used_percent": vm.percent,
            "swap_used_percent": psutil.swap_memory().percent,
            "uptime_hours": round((time.time() - psutil.boot_time()) / 3600, 1),
            "python": platform.python_version(),
        },
        indent=2,
    )


@beta_tool
def check_disk_usage() -> str:
    """List mounted filesystems with total, used, and free space."""
    rows = []
    for part in psutil.disk_partitions(all=False):
        try:
            usage = psutil.disk_usage(part.mountpoint)
        except (PermissionError, OSError):
            continue
        rows.append(
            {
                "mount": part.mountpoint,
                "device": part.device,
                "fstype": part.fstype,
                "total_gb": _gb(usage.total),
                "free_gb": _gb(usage.free),
                "used_percent": usage.percent,
            }
        )
    return json.dumps(rows, indent=2)


@beta_tool
def list_top_processes(sort_by: str = "cpu", limit: int = 15) -> str:
    """List the processes using the most CPU or memory.

    Args:
        sort_by: Either "cpu" or "memory".
        limit: Number of processes to return (1-50).
    """
    limit = max(1, min(limit, 50))
    procs = list(psutil.process_iter(["pid", "name", "username", "memory_percent"]))
    for p in procs:  # prime cpu_percent counters
        try:
            p.cpu_percent(None)
        except psutil.Error:
            pass
    time.sleep(0.5)
    rows = []
    for p in procs:
        try:
            rows.append(
                {
                    "pid": p.info["pid"],
                    "name": p.info["name"],
                    "user": p.info["username"],
                    "cpu_percent": p.cpu_percent(None),
                    "memory_percent": round(p.info["memory_percent"] or 0, 2),
                }
            )
        except psutil.Error:
            continue
    key = "memory_percent" if sort_by == "memory" else "cpu_percent"
    rows.sort(key=lambda r: r[key], reverse=True)
    return json.dumps(rows[:limit], indent=2)


@beta_tool
def check_network(host: str = "8.8.8.8", port: int = 443) -> str:
    """Check DNS resolution and TCP connectivity to a host, and list local interfaces.

    Args:
        host: Hostname or IP address to test.
        port: TCP port to connect to.
    """
    result: dict = {"host": host, "port": port}
    try:
        result["resolved"] = sorted({ai[4][0] for ai in socket.getaddrinfo(host, port)})
    except socket.gaierror as e:
        result["dns_error"] = str(e)
    start = time.monotonic()
    try:
        with socket.create_connection((host, port), timeout=5):
            result["tcp_connect"] = "ok"
            result["latency_ms"] = round((time.monotonic() - start) * 1000, 1)
    except OSError as e:
        result["tcp_connect"] = f"failed: {e}"
    result["interfaces"] = {
        name: [a.address for a in addrs if a.family in (socket.AF_INET, socket.AF_INET6)]
        for name, addrs in psutil.net_if_addrs().items()
    }
    stats = psutil.net_if_stats()
    result["interfaces_up"] = [n for n, s in stats.items() if s.isup]
    return json.dumps(result, indent=2)


@beta_tool
def check_service(name: str) -> str:
    """Report whether a system service (systemd, launchd, or Windows) or process is running.

    Args:
        name: Service or process name, e.g. "nginx" or "sshd".
    """
    system = platform.system()
    if system == "Linux" and shutil.which("systemctl"):
        cmd = ["systemctl", "status", name, "--no-pager", "--lines=20"]
    elif system == "Darwin":
        cmd = ["launchctl", "list"]
    elif system == "Windows":
        cmd = ["sc", "query", name]
    else:
        cmd = None

    output = ""
    if cmd:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        output = proc.stdout + proc.stderr
        if system == "Darwin":
            output = "\n".join(l for l in output.splitlines() if name.lower() in l.lower())
    matching = [
        {"pid": p.info["pid"], "name": p.info["name"]}
        for p in psutil.process_iter(["pid", "name"])
        if p.info["name"] and name.lower() in p.info["name"].lower()
    ]
    return _truncate(
        json.dumps({"service_output": output or "(no service manager output)", "processes": matching}, indent=2)
    )


@beta_tool
def read_log(path: str, lines: int = 100, grep: str = "") -> str:
    """Read the last lines of a log file, optionally filtering by a substring.

    Args:
        path: Path to the log file, e.g. /var/log/syslog.
        lines: Number of trailing lines to return (1-500).
        grep: Optional case-insensitive substring; only matching lines are returned.
    """
    lines = max(1, min(lines, 500))
    p = Path(path).expanduser()
    if not p.is_file():
        return f"Error: {p} is not a readable file."
    try:
        with p.open("r", errors="replace") as f:
            content = f.readlines()
    except OSError as e:
        return f"Error reading {p}: {e}"
    if grep:
        content = [l for l in content if grep.lower() in l.lower()]
    return _truncate("".join(content[-lines:]) or "(no matching lines)")


@beta_tool
def run_command(command: str, timeout_seconds: int = 30) -> str:
    """Run a shell command on this machine. The operator must approve each command.

    Use this only when the dedicated diagnostic tools are not enough, or to apply
    a fix the user has agreed to. Prefer read-only commands. The command runs
    without a shell, so pipes, redirects, and globs are not supported.

    Args:
        command: The command line to run.
        timeout_seconds: Maximum runtime before the command is killed (1-300).
    """
    if not confirm(command):
        return "The operator declined to run this command. Ask them or suggest an alternative."
    timeout_seconds = max(1, min(timeout_seconds, 300))
    try:
        proc = subprocess.run(
            command if platform.system() == "Windows" else shlex.split(command),
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            shell=platform.system() == "Windows",
        )
    except subprocess.TimeoutExpired:
        return f"Command timed out after {timeout_seconds}s."
    except (OSError, ValueError) as e:
        return f"Failed to start command: {e}"
    return _truncate(f"exit_code: {proc.returncode}\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}")


ALL_TOOLS = [
    get_system_info,
    check_disk_usage,
    list_top_processes,
    check_network,
    check_service,
    read_log,
    run_command,
]
