# IT Tech Agent

An IT support agent powered by Claude. Describe a problem ("my laptop is slow",
"I can't reach the VPN", "is nginx running?") and the agent gathers diagnostics
from the machine it runs on, explains what it found, and suggests next steps.

## Tools

| Tool | What it does |
|---|---|
| `get_system_info` | OS, CPU, memory, swap, load, uptime |
| `check_disk_usage` | Space on each mounted filesystem |
| `list_top_processes` | Processes using the most CPU or memory |
| `check_network` | DNS lookup, TCP connect + latency, local interfaces |
| `check_service` | systemd / launchd / Windows service status and matching processes |
| `read_log` | Tail a log file, optionally filtered by a substring |
| `run_command` | Run a command; **you must approve each one** |

All tools except `run_command` are read-only. `run_command` runs without a
shell (no pipes or redirects) and prompts `Allow? [y/N]` before every command.

## Setup

```bash
pip install -e ".[dev]"
export ANTHROPIC_API_KEY=sk-ant-...   # or: ant auth login
```

## Usage

```bash
# Interactive session (/reset clears history, /quit exits)
python -m it_tech_agent

# One-shot question
python -m it_tech_agent "Why is my computer running slowly?"

# Options
python -m it_tech_agent --effort medium          # low | medium | high | xhigh | max
python -m it_tech_agent --yes "..."              # auto-approve commands (careful)
```

From Python:

```python
from it_tech_agent import ITTechAgent

agent = ITTechAgent()
agent.ask("Is there enough free disk space?")
```

The agent uses `claude-opus-5-5` with server-side refusal fallbacks enabled
(`fallbacks="default"`).

## Tests

```bash
pytest
```
