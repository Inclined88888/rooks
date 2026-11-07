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
    anon = _anon(client)
    for path in ("/api/settings", "/api/room/screenshot", "/api/jobs/notices", "/api/presence", "/api/automations"):
        assert anon.get(path, headers=_as(token)).status_code == 401, path
    for path in ("/api/room/reset", "/api/room/handoff", "/api/room/checkpoint", "/api/room/click", "/api/jobs"):
        r = anon.post(path, json={"prompt": "x", "command": "id"}, headers=_as(token, True))
        assert r.status_code == 401, (path, r.status_code)


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
