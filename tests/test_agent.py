from types import SimpleNamespace as NS

from it_tech_agent.agent import ITTechAgent


class FakeRunner:
    def __init__(self, messages, tool_responses):
        self._messages = messages
        self._tool_responses = iter(tool_responses)

    def __iter__(self):
        return iter(self._messages)

    def generate_tool_call_response(self):
        return next(self._tool_responses)


def text(t):
    return NS(type="text", text=t)


def test_ask_mirrors_history_and_returns_final_text():
    tool_use = NS(type="tool_use", id="t1", name="check_disk_usage", input={})
    first = NS(content=[text("Checking disk."), tool_use], stop_reason="tool_use")
    final = NS(content=[text("Disk is fine.")], stop_reason="end_turn")
    tool_result = {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "[]"}]}
    calls = []

    def tool_runner(**kwargs):
        calls.append(kwargs)
        return FakeRunner([first, final], [tool_result, None])

    client = NS(beta=NS(messages=NS(tool_runner=tool_runner)))
    agent = ITTechAgent(client=client)
    printed = []

    assert agent.ask("Is my disk full?", on_text=printed.append) == "Disk is fine."
    assert printed == ["Checking disk.", "Disk is fine."]
    assert [m["role"] for m in agent.messages] == ["user", "assistant", "user", "assistant"]
    assert calls[0]["fallbacks"] == "default"
    assert calls[0]["model"] == "claude-opus-5-5"


def test_refusal_returns_message():
    refused = NS(content=[], stop_reason="refusal")
    client = NS(beta=NS(messages=NS(tool_runner=lambda **kw: FakeRunner([refused], [None]))))
    assert "can't help" in ITTechAgent(client=client).ask("x", on_text=lambda t: None)
