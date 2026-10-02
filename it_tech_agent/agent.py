"""IT tech support agent built on the Claude API tool runner."""

from __future__ import annotations

from typing import Callable

import anthropic

from .tools import ALL_TOOLS

MODEL = "claude-opus-5-5"

SYSTEM_PROMPT = """\
You are an experienced IT support technician helping a user troubleshoot the \
machine this program runs on. You have diagnostic tools for system info, disk, \
processes, network, services, and logs, plus a run_command tool the operator \
must approve.

How to work:
- Gather evidence with the read-only tools before drawing conclusions.
- Explain findings in plain language, then give clear, numbered next steps.
- Only use run_command when the dedicated tools can't answer the question, or \
to apply a fix the user agreed to. Say what a command does before running it.
- Never run destructive commands (deleting data, reformatting, killing critical \
processes, changing security settings) unless the user explicitly asked for that.
- If a problem is outside what you can diagnose from this machine (hardware \
failure, account lockouts, network gear), say so and recommend escalation.
"""


class ITTechAgent:
    """A multi-turn IT support conversation that keeps its own history."""

    def __init__(
        self,
        client: anthropic.Anthropic | None = None,
        model: str = MODEL,
        effort: str = "high",
        max_restarts: int = 5,
    ) -> None:
        self.client = client or anthropic.Anthropic()
        self.model = model
        self.effort = effort
        self.max_restarts = max_restarts
        self.messages: list[dict] = []

    def ask(self, user_input: str, on_text: Callable[[str], None] = print) -> str:
        """Send one user turn, run tools until Claude is done, and return the final text."""
        self.messages.append({"role": "user", "content": user_input})
        last = None
        for _ in range(self.max_restarts + 1):
            runner = self.client.beta.messages.tool_runner(
                model=self.model,
                max_tokens=16000,
                system=SYSTEM_PROMPT,
                tools=ALL_TOOLS,
                messages=self.messages,
                output_config={"effort": self.effort},
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
            )
            for message in runner:
                last = message
                # Mirror history: the runner keeps its own copy and doesn't expose it.
                self.messages.append({"role": "assistant", "content": message.content})
                for block in message.content:
                    if block.type == "text" and block.text.strip():
                        on_text(block.text)
                tool_response = runner.generate_tool_call_response()
                if tool_response is not None:
                    self.messages.append(tool_response)
            if last is None or last.stop_reason != "pause_turn":
                break

        if last is None:
            return ""
        if last.stop_reason == "refusal":
            return "Sorry, I can't help with that request."
        return "".join(b.text for b in last.content if b.type == "text")

    def reset(self) -> None:
        self.messages.clear()
