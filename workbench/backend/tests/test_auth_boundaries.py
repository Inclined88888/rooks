"""Who may sign in, approve and act: PR #10 (native Ask) and PR #11 (read only bridge key) together.

Rule: a background agent (a coding job, the browser or desk helper, anything holding a shared app key) must never
approve its own requests or get the person's full access. The native window signs in with a key only it is given.
Every check goes through the real routes and dependencies; nothing here stubs authorisation.
"""

from __future__ import annotations

import json
import secrets

import pytest
from fastapi.testclient import TestClient

BROWSER = "browser-helper-key-0123456789abcdef"   # app.json; the browser and desk helpers; the terminal
DESK = "desk-helper-key-0123456789abcdef0123"
CODING = "coding-job-key-0123456789abcdef0123"
NATIVE = "native-window-key-0123456789abcdef01"
TOOLS = "tools-key-0123456789abcdef0123456789"
W = {"X-Workbench": "1"}


@pytest.fixture()
def keys(client, monkeypatch):
    from app import config, security

    for name, value in (("BROWSER_API_KEY", BROWSER), ("DESK_API_KEY", DESK), ("CODING_BRIDGE_KEY", CODING),
                        ("NATIVE_SIGNIN_KEY", NATIVE), ("TOOLS_API_KEY", TOOLS)):
        monkeypatch.setattr(config, name, value, raising=False)
    monkeypatch.setattr(security, "_attempts", {})  # wrong keys below must not throttle other tests
    yield


def anon(client) -> TestClient:
    return TestClient(client.app)  # no session cookie


def bearer(key: str, channel: str = "rooks-code", write: bool = False) -> dict:
    h = {"Authorization": f"Bearer {key}", "X-Workbench-Channel": channel}
    return {**h, **W} if write else h


def held_action(tool: str = "remember") -> int:
    from app import actions, assistant

    cid = assistant.new_conversation("web")
    return actions.add("tool_call", "held", trace={"conversation_id": cid, "channel": "web"}, tool=tool,
                       effect="persistent", payload=json.dumps({"content": "x"}), args=json.dumps({"content": "x"}),
                       detail="t")


SHARED = [pytest.param(BROWSER, id="browser-key"), pytest.param(DESK, id="desk-key"),
          pytest.param(CODING, id="coding-job-key")]


# ---- privilege escalation: a shared key is never a sign in -------------------------------------------------------
@pytest.mark.parametrize("key", SHARED)
def test_a_shared_key_never_mints_a_session(client, keys, key):
    r = anon(client).post("/api/desktop/local-session", headers={"Authorization": f"Bearer {key}", **W})
    assert r.status_code == 401 and "wb_session" not in r.headers.get("set-cookie", "")


@pytest.mark.parametrize("key", SHARED)
def test_a_shared_key_never_opens_the_account(client, keys, key):
    a = anon(client)
    for path in ("/api/conversations", "/api/settings", "/api/approvals", "/api/memories"):
        assert a.get(path, headers={"Authorization": f"Bearer {key}"}).status_code == 401, path


# ---- approval bypass: no shared key answers anything -------------------------------------------------------------
@pytest.mark.parametrize("key", SHARED)
def test_a_shared_key_cannot_approve_anywhere(client, keys, key):
    a = anon(client)
    aid = held_action()
    for method, path, body in (("POST", f"/api/needs-you/a:{aid}/approve", {}),
                               ("POST", f"/api/approvals/{aid}", {"approve": True}),
                               ("POST", f"/api/voice/approvals/{aid}", {"utterance": "yes"}),
                               ("POST", "/api/room/up", {}), ("POST", "/api/room/run", {"command": "id"})):
        r = a.request(method, path, json=body, headers=bearer(key, write=True))
        assert r.status_code in (401, 403), (path, r.status_code)
    from app import actions
    assert actions.approval(aid)["status"] == "pending"


def test_a_coding_job_cannot_answer_its_own_terminal_prompt(client, keys):
    """The terminal records the person's y/n with the app.json key; a coding job holds its own key and may not."""
    a = anon(client)
    cid = a.post("/v1/rooks/conversation", json={"session": "job"}, headers=bearer(CODING)).json()["conversation_id"]
    aid = a.post("/v1/rooks/approvals", headers=bearer(CODING), json={
        "conversation_id": cid, "tool": "run_command", "effect": "command", "summary": "rm", "preview": "rm -rf x"}).json()["id"]
    r = a.post(f"/v1/rooks/approvals/{aid}", headers=bearer(CODING), json={"approve": True})
    assert r.status_code == 403
    assert a.get(f"/v1/rooks/approvals/{aid}", headers=bearer(CODING)).json()["status"] == "pending"
    # The person's interactive terminal (app.json key) still records the answer it was given.
    assert a.post(f"/v1/rooks/approvals/{aid}", headers=bearer(BROWSER), json={"approve": False}).status_code == 200


def test_a_coding_job_reads_nothing_in_the_workroom(client, keys):
    a = anon(client)
    for path in ("/api/needs-you", "/api/room/status", "/api/jobs"):
        assert a.get(path, headers=bearer(CODING)).status_code == 401, path


# ---- credential reuse: each key is its own -------------------------------------------------------------------------
def test_the_coding_job_key_is_never_the_shared_app_key(client, keys):
    from app import cli_agents

    key = cli_agents.coding_bridge_key()
    assert key == CODING and key not in (BROWSER, DESK, NATIVE, TOOLS)


def test_the_coding_job_key_is_generated_on_its_own_when_none_is_set(client, keys, monkeypatch):
    from app import cli_agents, config

    monkeypatch.setattr(config, "CODING_BRIDGE_KEY", "")
    key = cli_agents.coding_bridge_key()
    assert len(key) >= 32 and key not in (BROWSER, DESK, NATIVE, TOOLS)


def test_the_native_key_is_not_a_bearer(client, keys):
    a = anon(client)
    for path in ("/api/conversations", "/api/settings", "/api/needs-you"):
        assert a.get(path, headers={"Authorization": f"Bearer {NATIVE}", "X-Workbench-Channel": "rooks-code"}).status_code == 401, path
    assert a.get("/v1/models", headers={"Authorization": f"Bearer {NATIVE}"}).status_code == 401


def test_a_terminal_token_cannot_mint_a_window_session(client, keys):
    import hashlib

    from app import db

    db.set_setting("cli_token_hash", hashlib.sha256(b"wb_terminal-token-123456789").hexdigest())
    r = anon(client).post("/api/desktop/local-session", headers={"Authorization": "Bearer wb_terminal-token-123456789", **W})
    assert r.status_code == 401


# ---- background job access: what a job's process is handed --------------------------------------------------------
APP_SECRETS = ("APP_SECRET", "TOOLS_API_KEY", "BROWSER_API_KEY", "DESK_API_KEY", "NATIVE_SIGNIN_KEY",
               "WORKBENCH_DESKTOP_TOKEN", "CODING_BRIDGE_KEY", "TRY_API_KEY", "ROOKS_TRY_API_KEY")


@pytest.fixture()
def sidecar_env(monkeypatch):
    """The desktop sidecar's own environment, where these secrets live."""
    for name in APP_SECRETS:
        monkeypatch.setenv(name, f"secret-{name.lower()}-0123456789")
    monkeypatch.setenv("WORKBENCH_API_KEY", secrets.token_hex(12))


@pytest.mark.parametrize("agent", ["rooks", "claude", "codex"])
def test_a_coding_job_is_handed_no_app_secret(client, keys, sidecar_env, agent):
    from app import cli_agents

    env = cli_agents.rooks_env() if agent == "rooks" else cli_agents.child_env(agent)
    leaked = [n for n in APP_SECRETS if n in env]
    assert not leaked, leaked
    if agent == "rooks":
        assert env["WORKBENCH_API_KEY"] == CODING
    else:
        assert "WORKBENCH_API_KEY" not in env


def test_a_user_mcp_server_is_handed_no_app_secret(client, keys, sidecar_env, tmp_path):
    from app import mcp_client

    script = tmp_path / "dump.py"
    out = tmp_path / "env.json"
    script.write_text(
        "import json, os, sys\n"
        f"json.dump(dict(os.environ), open({str(out)!r}, 'w'))\n"
        "for line in sys.stdin:\n"
        "    m = json.loads(line)\n"
        "    if 'id' in m:\n"
        "        r = {'protocolVersion': '2025-06-18', 'capabilities': {}, 'serverInfo': {'name': 't'}} if m.get('method') == 'initialize' else {'tools': []}\n"
        "        print(json.dumps({'jsonrpc': '2.0', 'id': m['id'], 'result': r}), flush=True)\n")
    import sys

    c = mcp_client.StdioServer("t", sys.executable, [str(script)], env={"MINE": "1"}, timeout=5)
    try:
        import time
        for _ in range(50):
            if out.exists() and out.stat().st_size:
                break
            time.sleep(0.05)
    finally:
        c.close()
    env = json.loads(out.read_text())
    assert env.get("MINE") == "1"
    assert not [n for n in APP_SECRETS if n in env]


def test_the_browser_helper_gets_its_own_key_only(client, keys, sidecar_env):
    from app import local_agents

    env = local_agents.helper_env(BROWSER, {"ROOKS_BROWSER_TOKEN": BROWSER})
    assert env["WORKBENCH_API_KEY"] == BROWSER and env["ROOKS_BROWSER_TOKEN"] == BROWSER
    assert not [n for n in APP_SECRETS if n in env]


# ---- legitimate native sign in -----------------------------------------------------------------------------------
def test_the_native_window_signs_in_with_its_own_key(client, keys):
    a = anon(client)
    r = a.post("/api/desktop/local-session", headers={"Authorization": f"Bearer {NATIVE}", **W})
    assert r.status_code == 200 and "wb_session" in r.headers.get("set-cookie", "")
    assert a.get("/api/conversations").status_code == 200  # the cookie is a normal session


def test_the_tools_key_does_not_sign_the_window_in(client, keys):
    """The tools key is handed to add-ons and the Room's own server. It is not an account login anywhere, so it must
    not mint a window session either (it did on main, on loopback): only the native key does."""
    r = anon(client).post("/api/desktop/local-session", headers={"Authorization": f"Bearer {TOOLS}", **W})
    assert r.status_code == 401 and "wb_session" not in r.headers.get("set-cookie", "")


def test_no_native_key_configured_means_no_sign_in_with_an_empty_bearer(client, keys, monkeypatch):
    from app import config

    monkeypatch.setattr(config, "NATIVE_SIGNIN_KEY", "")
    a = anon(client)
    assert a.post("/api/desktop/local-session", headers={"Authorization": "Bearer ", **W}).status_code == 401
    assert a.post("/api/desktop/local-session", headers={"Authorization": f"Bearer {NATIVE}", **W}).status_code == 401


# ---- the desktop sidecar: what it writes and hands out --------------------------------------------------------------
def _sidecar():
    import importlib.util
    from pathlib import Path

    side = Path(__file__).resolve().parents[3] / "desktop" / "sidecar" / "workbench_server.py"
    spec = importlib.util.spec_from_file_location("workbench_server_auth_test", side)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_the_sidecar_strips_the_same_secrets_as_the_app():
    from app import security

    assert set(_sidecar().APP_SECRET_ENV) == set(security.APP_SECRET_ENV)


def test_the_sidecar_helpers_get_only_their_own_key(sidecar_env):
    env = _sidecar().helper_env({"ROOKS_BROWSER_TOKEN": BROWSER, "WORKBENCH_API_KEY": BROWSER})
    assert env["WORKBENCH_API_KEY"] == BROWSER
    assert not [n for n in APP_SECRETS if n in env and n not in ("WORKBENCH_API_KEY",)]


def test_the_native_key_lives_in_its_own_private_file(tmp_path, monkeypatch):
    import os
    import stat

    side = _sidecar()
    monkeypatch.setenv("AI_WORKSPACE_APP_FILE", str(tmp_path / "app.json"))
    side.write_app_link("http://127.0.0.1:9", BROWSER)
    path = side.write_native_link("http://127.0.0.1:9", NATIVE)
    assert path == tmp_path / "native.json"
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert json.loads(path.read_text())["key"] == NATIVE
    app = (tmp_path / "app.json").read_text()
    assert NATIVE not in app and json.loads(app)["key"] == BROWSER
    for fn in side._CLEANUP:
        fn()
    assert not path.exists()
