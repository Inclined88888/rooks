"""Text moods and the link the terminal uses to reach the same Rooks."""

from rooks_code.talk import link_from, mood_line


def test_moods_are_plain_words():
    assert mood_line("writing") == "(thinking)"
    assert mood_line("tool_call") == "(working)"
    assert mood_line("approval_required") == "(needs you)"
    assert mood_line("message") == "(done)"
    assert mood_line("nope") == ""


def test_link_prefers_an_explicit_server(monkeypatch):
    monkeypatch.delenv("WORKBENCH_URL", raising=False)
    monkeypatch.delenv("WORKBENCH_API_KEY", raising=False)
    monkeypatch.setattr("rooks_code.talk.config.app_link", lambda: {})
    assert link_from("http://127.0.0.1:9", "secret") == {"url": "http://127.0.0.1:9", "key": "secret"}
    assert link_from(None, None) is None


class _Stream:
    def __init__(self, events):
        import json

        self.lines = [f"data: {json.dumps(e)}\n".encode() for e in events]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def __iter__(self):
        return iter(self.lines)


def test_talk_says_a_restart_and_a_compacted_chat_and_asks_like_the_app(monkeypatch, capsys):
    from rooks_code import talk

    events = [{"type": "resumed", "reason": "restart", "at": "x"}, {"type": "compacted", "dropped_rows": 3},
              {"type": "approval_required", "id": 5, "tool": "send_email", "reason": "Sending needs your OK."},
              {"type": "message", "content": "Done."}]
    monkeypatch.setattr(talk.urllib.request, "urlopen", lambda req, timeout=None: _Stream(events))
    assert talk.turn({"url": "http://127.0.0.1:9", "key": "k"}, "hi", None, tty=False) == 2
    out = capsys.readouterr().out
    assert "Picked up after a restart" in out and "Earlier parts of this chat were summarised to fit" in out
    assert "Needs your OK" in out and "send_email" not in out and "Done." in out
