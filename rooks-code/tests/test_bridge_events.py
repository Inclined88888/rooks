"""The terminal on the app's shared loop says what the app says: a restart, a compacted chat, and where an OK waits."""

import json

from rooks_code import agent as agent_mod
from rooks_code.agent import Agent

from test_extras import UI, FakeModel, settings


class _Stream:
    def __init__(self, events):
        self.lines = [f"data: {json.dumps(e)}\n".encode() for e in events]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def __iter__(self):
        return iter(self.lines)


def _run(tmp_path, monkeypatch, events) -> list[str]:
    ui = UI()
    ui.conversation_id = None
    a = Agent(settings(tmp_path), ui, model=FakeModel([]))
    monkeypatch.setattr(agent_mod.urllib.request, "urlopen", lambda req, timeout=None: _Stream(events))
    a.run_via_bridge("carry on")
    return [str(args[0]) for name, args in ui.out if name in ("tool_note", "notice")]


def test_the_terminal_says_the_app_restarted_and_compacted(tmp_path, monkeypatch):
    notes = _run(tmp_path, monkeypatch, [
        {"type": "resumed", "reason": "restart", "at": "2026-11-06T10:00:00"},
        {"type": "compacted", "dropped_rows": 7, "summary_words": 40},
        {"type": "message", "content": "ok"},
        {"type": "done", "outcome": "no_claim"},
    ])
    assert "Picked up after a restart" in notes, notes
    assert "Earlier parts of this chat were summarised to fit" in notes, notes


def test_a_held_step_points_at_needs_you(tmp_path, monkeypatch):
    notes = _run(tmp_path, monkeypatch, [
        {"type": "approval_required", "id": 3, "tool": "send_email", "reason": "Sending needs your OK."},
        {"type": "done", "outcome": "held"},
    ])
    held = [n for n in notes if "Needs your OK" in n]
    assert held and "Needs you" in held[0] and "Approvals" not in held[0] and "send_email" not in held[0]


def test_a_step_the_app_runs_is_said_in_plain_words(tmp_path, monkeypatch):
    notes = _run(tmp_path, monkeypatch, [
        {"type": "tool_call", "name": "search_email", "args": '{"query": "invoice"}'},
        {"type": "message", "content": "ok"},
        {"type": "done", "outcome": "no_claim"},
    ])
    assert "Looking through mail: invoice" in notes and not any("(app)" in n for n in notes), notes
