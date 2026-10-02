"""Interactive command-line interface: ``python -m it_tech_agent``."""

from __future__ import annotations

import argparse

import anthropic

from . import tools
from .agent import MODEL, ITTechAgent


def main() -> None:
    parser = argparse.ArgumentParser(description="Chat with an IT support agent about this machine.")
    parser.add_argument("question", nargs="*", help="Ask one question and exit (omit for interactive mode).")
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--effort", default="high", choices=["low", "medium", "high", "xhigh", "max"])
    parser.add_argument("--yes", action="store_true", help="Auto-approve run_command (use with care).")
    args = parser.parse_args()

    if args.yes:
        tools.confirm = lambda command: (print(f"\n$ {command}"), True)[1]

    agent = ITTechAgent(model=args.model, effort=args.effort)
    show = lambda text: print(f"\n{text}")

    if args.question:
        agent.ask(" ".join(args.question), on_text=show)
        return

    print("IT Tech Agent - describe your problem. Commands: /reset, /quit")
    while True:
        try:
            user_input = input("\nyou> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not user_input:
            continue
        if user_input in {"/quit", "/exit"}:
            break
        if user_input == "/reset":
            agent.reset()
            print("Conversation cleared.")
            continue
        try:
            agent.ask(user_input, on_text=show)
        except anthropic.AuthenticationError:
            print("Authentication failed - set ANTHROPIC_API_KEY or run `ant auth login`.")
            break
        except anthropic.RateLimitError:
            print("Rate limited - wait a moment and try again.")
        except anthropic.APIStatusError as e:
            print(f"API error {e.status_code}: {e.message}")
        except anthropic.APIConnectionError:
            print("Could not reach the Claude API - check your network connection.")


if __name__ == "__main__":
    main()
