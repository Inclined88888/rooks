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
