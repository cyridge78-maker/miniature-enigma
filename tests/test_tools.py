import json

from it_tech_agent import tools


def test_all_tools_have_schemas():
    names = {t.name for t in tools.ALL_TOOLS}
    assert "run_command" in names
    for t in tools.ALL_TOOLS:
        d = t.to_dict()
        assert d["description"]
        assert d["input_schema"]["type"] == "object"


def test_system_info_and_disk():
    info = json.loads(tools.get_system_info.call({}))
    assert info["cpu_count_logical"] >= 1
    assert isinstance(json.loads(tools.check_disk_usage.call({})), list)


def test_top_processes_respects_limit():
    rows = json.loads(tools.list_top_processes.call({"sort_by": "memory", "limit": 3}))
    assert len(rows) <= 3


def test_read_log_tail_and_grep(tmp_path):
    log = tmp_path / "app.log"
    log.write_text("".join(f"line {i} {'ERROR' if i % 2 else 'ok'}\n" for i in range(10)))
    assert tools.read_log.call({"path": str(log), "lines": 2}) == "line 8 ok\nline 9 ERROR\n"
    out = tools.read_log.call({"path": str(log), "grep": "error"})
    assert out.count("ERROR") == 5 and "ok" not in out
    assert tools.read_log.call({"path": str(tmp_path / "missing")}).startswith("Error")


def test_run_command_requires_approval(monkeypatch):
    seen = []
    monkeypatch.setattr(tools, "confirm", lambda c: seen.append(c) or False)
    assert "declined" in tools.run_command.call({"command": "echo hi"})
    assert seen == ["echo hi"]

    monkeypatch.setattr(tools, "confirm", lambda c: True)
    out = tools.run_command.call({"command": "echo hi"})
    assert "exit_code: 0" in out and "hi" in out
