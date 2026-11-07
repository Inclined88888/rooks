"""Against the real app: what the terminal's key can reach. The Terminal access token (the bridge key) reaches chat and
models, not the signed in /api routes, so /needs and /room say so plainly; the app's own key reaches both."""

import io
from types import SimpleNamespace

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("uvicorn")

from live_app import app, setup  # noqa: E402,F401 - app is a fixture

from rooks_code import workroom  # noqa: E402
from rooks_code.cli import UI  # noqa: E402


def _say(fn, url, key, rest=""):
    out = io.StringIO()
    s = SimpleNamespace(provider="workbench", base_url=f"{url}/v1", api_key=key, model="default")
    fn(SimpleNamespace(s=s, root=".", extras=None), UI(out=out, err=out, color=False), rest)
    return out.getvalue()


def test_the_bridge_key_cannot_read_needs_you_and_the_terminal_says_so(app, monkeypatch):
    monkeypatch.setattr("rooks_code.config.app_link", lambda: {})
    token = setup(app, "http://127.0.0.1:9/v1")
    for fn in (workroom.needs_command, workroom.room_command):
        text = _say(fn, app.url, token)
        assert "can't" in text and "in the app" in text, text
    # the app's own key (what require_user accepts as a bearer) does reach them
    assert "Nothing needs you" in _say(workroom.needs_command, app.url, "k" * 30)
    room = _say(workroom.room_command, app.url, "k" * 30)
    assert "The Room" in room and "can't" not in room, room
