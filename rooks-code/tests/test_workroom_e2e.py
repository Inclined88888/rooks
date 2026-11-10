"""Against the real app: /needs, /room and /jobs work with the terminal's own key.

The Terminal access token (from Settings > Terminal access) and the app.json bridge key both reach the app's Room,
Needs you and Jobs board, and nothing else of the signed in app. A request a running rooks asks about waits in Needs
you; another terminal answers it with /needs approve, and the first one goes on and makes the change.
"""

import io
import threading
import time
from types import SimpleNamespace

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("uvicorn")

from conftest import rooks  # noqa: E402
from fakes import FakeModel  # noqa: E402
from live_app import App, app, openai_reply, setup  # noqa: E402,F401 - app is a fixture

from rooks_code import workroom  # noqa: E402
from rooks_code.cli import UI  # noqa: E402

BRIDGE = "bridge-key-from-app-json-0123456789ab"


def _agent(url, key):
    s = SimpleNamespace(provider="workbench", base_url=f"{url}/v1", api_key=key, model="default")
    return SimpleNamespace(s=s, root=".", extras=None)


def _say(fn, url, key, rest=""):
    out = io.StringIO()
    fn(_agent(url, key), UI(out=out, err=out, color=False), rest)
    return out.getvalue()


def test_needs_approve_with_the_terminal_token_lets_a_waiting_rooks_go_on(project, app):
    """A rooks run with no keyboard waits in Needs you; /needs approve 1 with the Terminal access token answers it."""
    model = FakeModel([
        openai_reply("", [("edit_file", {"path": "calc.py", "old_text": "return a - b", "new_text": "return a + b"})]),
        openai_reply("Fixed add()."),
    ])
    try:
        token = setup(app, model.url)
        said: list[str] = []

        def approve_from_another_terminal():
            for _ in range(300):
                listed = _say(workroom.needs_command, app.url, token)
                if "Needs you  ·  1" in listed:
                    said.append(listed)
                    said.append(_say(workroom.needs_command, app.url, token, "approve 1"))
                    return
                time.sleep(0.1)

        t = threading.Thread(target=approve_from_another_terminal, daemon=True)
        t.start()
        r = rooks(project, "-P", "workbench", "fix add in calc.py", stdin="",
                  env={"WORKBENCH_URL": app.url, "WORKBENCH_API_KEY": token})
        t.join(10)
        out = r.stdout + r.stderr
        assert r.returncode == 0, out
        assert len(said) == 2, (said, out)
        assert "Needs you" in said[0] and "can't" not in said[0], said[0]
        assert said[1].strip().startswith("Approved"), said[1]
        assert (project / "calc.py").read_text() == "def add(a, b):\n    return a + b\n"
        assert "Nothing needs you" in _say(workroom.needs_command, app.url, token)
    finally:
        model.close()


def test_the_app_json_bridge_key_reads_but_never_acts(tmp_path):
    """The app.json key is shared with coding jobs the app starts, so it may read the Room, Needs you and Jobs but
    never start the Room, run in it or answer Needs you: that needs the terminal's own sign in."""
    a = App(tmp_path, {"BROWSER_API_KEY": BRIDGE, "ROOKS_TRY_HOME": str(tmp_path / "room"), "ROOKS_TRY_DRIVER": "shell"})
    try:
        setup(a, "http://127.0.0.1:9/v1")
        status = _say(workroom.room_command, a.url, BRIDGE)
        assert "The Room  ·  Off" in status and "Update the app" not in status, status
        started = _say(workroom.room_command, a.url, BRIDGE, "start")
        assert "Terminal access" in started and "401" not in started, started
        assert "hello-room" not in _say(workroom.room_command, a.url, BRIDGE, "run echo hello-room")
        assert "Nothing needs you" in _say(workroom.needs_command, a.url, BRIDGE)
        out = io.StringIO()
        workroom.app_jobs(_agent(a.url, BRIDGE), UI(out=out, err=out, color=False))
        assert "In the app" in out.getvalue() and "can't" not in out.getvalue(), out.getvalue()
        # Coworkers: the key reads the lines of work, but a proposal and a team need the terminal's own sign in
        assert "construction" in _say(workroom.team_command, a.url, BRIDGE)
        for rest in ("set up construction", "create construction"):
            said = _say(workroom.team_command, a.url, BRIDGE, rest)
            assert "Terminal access" in said and "ready" not in said and "401" not in said, said
    finally:
        a.close()


def test_a_wrong_key_is_said_plainly(app, monkeypatch):
    monkeypatch.setattr("rooks_code.config.app_link", lambda: {})
    setup(app, "http://127.0.0.1:9/v1")
    for fn in (workroom.needs_command, workroom.room_command):
        text = _say(fn, app.url, "w" * 40)
        assert "401" not in text and "Not signed in" not in text and "in the app" in text, text


def test_team_sets_up_a_line_of_work_from_the_terminal(app):
    """The app's Coworkers page from the terminal (AGENTS.md: the terminal and the app must match): the lines of work,
    the team Rooks proposes for one, creating it, its jobs waiting in Needs you, and removing it again."""
    token = setup(app, "http://127.0.0.1:9/v1")
    listed = _say(workroom.team_command, app.url, token)
    assert "No coworkers yet" in listed and "construction" in listed and "Construction and trades" in listed, listed
    shown = _say(workroom.team_command, app.url, token, "set up construction")
    assert "leads the team" in shown and "/team create construction" in shown and "Needs you" in shown, shown
    assert "not in the list" in _say(workroom.team_command, app.url, token, "set up astronaut")
    made = _say(workroom.team_command, app.url, token, "create construction")
    assert "ready" in made and "/needs" in made, made
    again = _say(workroom.team_command, app.url, token)
    assert "Construction and trades" in again and "waiting for your OK" in again and "No coworkers yet" not in again, again
    needs = _say(workroom.needs_command, app.url, token)
    assert "asks to run" in needs, needs  # the same cards the app shows, answerable with /needs approve N
    assert "already set up" in _say(workroom.team_command, app.url, token, "create construction")
    removed = _say(workroom.team_command, app.url, token, "remove construction")
    assert "Removed" in removed, removed
    assert "No coworkers yet" in _say(workroom.team_command, app.url, token)
    assert "/team set up LINE" in _say(workroom.team_command, app.url, token, "dance")

