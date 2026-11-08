"""The rooks terminal reaches the Workroom with its own key (design 0003, section 6, Terminal).

/room, /needs and /jobs in the terminal call /api/room, /api/needs-you and /api/jobs. The terminal holds either the
Terminal access token (Settings > Terminal access) or the app.json bridge key, so exactly those routes accept them;
nothing else widens: the same keys still get 401 on every other /api route.
"""

import hashlib
import json

import pytest

BRIDGE_KEY = "terminal-bridge-key-0123456789abcdef"
CLI_TOKEN = "terminal-cli-token-0123456789abcdefgh"
TERMINAL = {"X-Workbench-Channel": "rooks-code"}


@pytest.fixture()
def room_home(client, tmp_path, monkeypatch):
    from app import config, room

    monkeypatch.setenv("ROOKS_TRY_HOME", str(tmp_path / "try"))
    monkeypatch.setenv("ROOKS_TRY_DRIVER", "shell")
    monkeypatch.delenv("ROOKS_TRY_OFFLINE", raising=False)
    monkeypatch.setattr(config, "TRY_URL", "")
    monkeypatch.setattr(config, "TRY_API_KEY", "")
    room.reset()
    yield tmp_path / "try"
    room.reset()


@pytest.fixture()
def keys(client, monkeypatch):
    from app import config, db

    monkeypatch.setattr(config, "BROWSER_API_KEY", BRIDGE_KEY)
    monkeypatch.setattr(config, "DESK_API_KEY", "")
    monkeypatch.setattr(config, "BROWSER_URL", "")
    monkeypatch.setattr(config, "DESK_URL", "")
    old = db.get_setting("cli_token_hash", "")
    db.set_setting("cli_token_hash", hashlib.sha256(CLI_TOKEN.encode()).hexdigest())
    yield
    db.set_setting("cli_token_hash", old or "")


def _anon(client):
    from fastapi.testclient import TestClient

    return TestClient(client.app)


def _as(token: str, write: bool = False) -> dict:
    h = {"Authorization": f"Bearer {token}", **TERMINAL}
    if write:
        h["X-Workbench"] = "1"
    return h


CREDS = [pytest.param(CLI_TOKEN, id="cli-token"), pytest.param(BRIDGE_KEY, id="bridge-key")]


@pytest.mark.parametrize("token", CREDS)
def test_terminal_key_reads_room_needs_and_jobs(client, keys, room_home, token):
    anon = _anon(client)
    for path in ("/api/room/status", "/api/needs-you", "/api/jobs"):
        r = anon.get(path, headers=_as(token))
        assert r.status_code == 200, (path, r.status_code, r.text)
    assert isinstance(anon.get("/api/needs-you", headers=_as(token)).json(), list)
    assert "running" in anon.get("/api/jobs", headers=_as(token)).json()


@pytest.mark.parametrize("token", [pytest.param(CLI_TOKEN, id="cli-token")])
def test_terminal_key_starts_runs_and_stops_the_room(client, keys, room_home, token):
    anon = _anon(client)
    assert anon.post("/api/room/up", headers=_as(token, True)).json()["running"] is True
    out = anon.post("/api/room/run", json={"command": "echo hi-from-terminal"}, headers=_as(token, True))
    assert out.status_code == 200 and "hi-from-terminal" in out.json()["stdout"], out.text
    assert anon.post("/api/room/down", headers=_as(token, True)).json()["running"] is False


@pytest.mark.parametrize("token", [pytest.param(CLI_TOKEN, id="cli-token")])
def test_terminal_key_answers_needs_you(client, keys, token):
    from app import actions, assistant

    cid = assistant.new_conversation("web")
    aid = actions.add("tool_call", "held", trace={"conversation_id": cid, "channel": "web"}, tool="remember",
                      effect="persistent", payload=json.dumps({"content": "x"}), args=json.dumps({"content": "x"}), detail="t")
    anon = _anon(client)
    r = anon.post(f"/api/needs-you/a:{aid}/deny", headers=_as(token, True))
    assert r.status_code == 200 and r.json()["status"] == "denied", r.text


@pytest.mark.parametrize("token", CREDS)
def test_writes_still_need_the_workbench_header(client, keys, room_home, token):
    anon = _anon(client)
    h = _as(token)
    assert anon.post("/api/room/up", headers=h).status_code == 403
    assert anon.post("/api/needs-you/a:1/deny", headers=h).status_code == 403


@pytest.mark.parametrize("token", CREDS)
def test_nothing_else_widens(client, keys, room_home, token):
    """Design 0006 widens the terminal's reach on purpose, to exactly: the Room's terminals (list, open, tail, send,
    close), its files, and save a point, start over and hand off; design 0007 adds opening a page in the Room's browser,
    its tabs and a page's text. Everything else stays the person's."""
    anon = _anon(client)
    for path in ("/api/settings", "/api/room/screenshot", "/api/jobs/notices", "/api/presence", "/api/automations",
                 "/api/room/browser", "/api/room/browser/frame", "/api/room/browser/shot"):
        assert anon.get(path, headers=_as(token)).status_code == 401, path
    for path in ("/api/room/click", "/api/room/type", "/api/room/key", "/api/jobs",
                 "/api/room/terminals/abcd1234/take"):
        r = anon.post(path, json={"prompt": "x", "command": "id", "owner": "person"}, headers=_as(token, True))
        assert r.status_code == 401, (path, r.status_code)
    r = anon.patch("/api/room/terminals/abcd1234", json={"name": "x"}, headers=_as(token, True))
    assert r.status_code == 401  # a name is the person's to give
    from app import main

    widened = sorted((m, r.path) for r in main.app.routes if getattr(r, "path", "").startswith("/api/room")
                     for m in (getattr(r, "methods", None) or set()) - {"HEAD"}
                     if any(getattr(d.call, "__name__", "") == "require_user_or_terminal" for d in r.dependant.dependencies))
    assert widened == sorted([
        ("GET", "/api/room/status"), ("POST", "/api/room/up"), ("POST", "/api/room/down"), ("POST", "/api/room/run"),
        ("POST", "/api/room/checkpoint"), ("POST", "/api/room/reset"), ("POST", "/api/room/handoff"),
        ("GET", "/api/room/files"), ("GET", "/api/room/terminals"), ("POST", "/api/room/terminals"),
        ("GET", "/api/room/terminals/{tid}/tail"), ("POST", "/api/room/terminals/{tid}/send"),
        ("DELETE", "/api/room/terminals/{tid}"),
        # design 0007, 1.6: /room browse, /room tabs, /room page (a bridge key still only reads)
        ("POST", "/api/room/browser/open"), ("GET", "/api/room/browser/tabs"), ("GET", "/api/room/browser/page")]), widened


def test_terminal_key_reaches_the_rooms_terminals_files_and_points(client, keys, room_home, monkeypatch):
    """Design 0006, 9.4: /room open, tail, send, close, files, save, back and handoff work from the rooks terminal with
    the Terminal access token; the bridge key (held by coding jobs the app starts) only reads."""
    from app import room_terminal

    monkeypatch.setenv("SHELL", "/bin/sh")
    anon = _anon(client)
    w, r = _as(CLI_TOKEN, True), _as(CLI_TOKEN)
    try:
        assert anon.post("/api/room/up", headers=w).status_code == 200
        opened = anon.post("/api/room/terminals", json={"name": "Rooks", "command": "echo reach"}, headers=w)
        assert opened.status_code == 200, opened.text
        tid = opened.json()["id"]
        assert anon.get("/api/room/terminals", headers=r).status_code == 200
        assert anon.get(f"/api/room/terminals/{tid}/tail", headers=r).status_code == 200
        assert anon.post(f"/api/room/terminals/{tid}/send", json={"text": "echo more"}, headers=w).status_code == 200
        assert anon.get("/api/room/files", headers=r).status_code == 200
        point = anon.post("/api/room/checkpoint", json={"label": "reach"}, headers=w)
        assert point.status_code == 200 and point.json()["verified"] is True, point.text
        held = anon.post("/api/room/handoff", json={"src": ".profile", "dest": "/tmp/nowhere-reach"}, headers=w)
        assert held.status_code == 200 and held.json()["held"] is True  # still waits in Needs you
        # the bridge key only reads
        b, bw = _as(BRIDGE_KEY), _as(BRIDGE_KEY, True)
        for path in ("/api/room/terminals", f"/api/room/terminals/{tid}/tail", "/api/room/files"):
            assert anon.get(path, headers=b).status_code == 200, path
        assert anon.post("/api/room/terminals", json={}, headers=bw).status_code == 401
        assert anon.post(f"/api/room/terminals/{tid}/send", json={"text": "id"}, headers=bw).status_code == 401
        assert anon.delete(f"/api/room/terminals/{tid}", headers=bw).status_code == 401
        for path in ("/api/room/checkpoint", "/api/room/reset", "/api/room/handoff"):
            assert anon.post(path, json={"label": "x", "src": "a", "dest": "b"}, headers=bw).status_code == 401, path
        assert anon.delete(f"/api/room/terminals/{tid}", headers=w).status_code == 200
        back = anon.post("/api/room/reset", json={"name": point.json()["name"]}, headers=w)
        assert back.status_code == 200 and back.json()["verified"] is True, back.text
    finally:
        from app import actions

        for a in actions.pending():
            if a["tool"] == "use_room":
                actions.decide(a["id"], False, "test")
        room_terminal.reset_for_tests(restart=False)
        anon.post("/api/room/down", headers=w)


def test_the_bridge_key_only_reads(client, keys, room_home):
    """App-started coding jobs hold the bridge key: it must never approve in Needs you or act in the Room."""
    from app import actions, assistant

    cid = assistant.new_conversation("web")
    aid = actions.add("tool_call", "held", trace={"conversation_id": cid, "channel": "web"}, tool="remember",
                      effect="persistent", payload=json.dumps({"content": "x"}), args=json.dumps({"content": "x"}), detail="t")
    anon = _anon(client)
    h = _as(BRIDGE_KEY, True)
    assert anon.post(f"/api/needs-you/a:{aid}/approve", headers=h).status_code == 401
    for path in ("/api/room/up", "/api/room/run", "/api/room/down"):
        assert anon.post(path, json={"command": "id"}, headers=h).status_code == 401, path
    assert anon.get("/api/needs-you", headers=_as(BRIDGE_KEY)).status_code == 200


def test_the_bridge_key_needs_the_terminal_channel(client, keys, room_home):
    """The browser and desk helpers share the bridge key; only the terminal's channel opens the Workroom with it."""
    anon = _anon(client)
    bare = {"Authorization": f"Bearer {BRIDGE_KEY}"}
    assert anon.get("/api/needs-you", headers=bare).status_code == 401
    assert anon.get("/api/needs-you", headers={**bare, "X-Workbench-Channel": "rooks-browser"}).status_code == 401


def test_wrong_keys_are_refused(client, keys, room_home):
    anon = _anon(client)
    for token in ("", "nope", "x" * 40):
        for path in ("/api/room/status", "/api/needs-you", "/api/jobs"):
            assert anon.get(path, headers=_as(token)).status_code == 401, (token, path)
