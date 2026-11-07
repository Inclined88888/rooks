"""Needs you (design 0003, section 8): one inbox for everything waiting on the person, each item answered in the
system it came from, exactly once."""

import json
import socket
import threading
import time

import pytest
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from conftest import SCRIPT, _port, events, tool_call
from memfacts import drop, exact

HELPER_KEY = "n" * 32
SEEN: dict[str, list] = {"desk": [], "browser": [], "auth": []}
STATE = {"desk_pending": True, "browser_pending": True}

# Two helpers on one server: the desk at /desk, the browser at /browser (the proxies take any base address).
helpers = FastAPI()
desk = FastAPI()
browser = FastAPI()
helpers.mount("/desk", desk)
helpers.mount("/browser", browser)


def _auth(req: Request) -> bool:
    SEEN["auth"].append(req.headers.get("authorization"))
    return req.headers.get("authorization") == f"Bearer {HELPER_KEY}"


@desk.get("/api/jobs")
def desk_jobs(req: Request):
    if not _auth(req):
        return JSONResponse({"detail": "Invalid or missing bearer token"}, 401)
    return [{"id": "j9", "goal": "Fill the timesheet", "status": "waiting", "source": "workbench", "created_at": 1.0, "updated_at": 2.0},
            {"id": "j8", "goal": "Earlier job", "status": "done", "source": "workbench", "created_at": 0.5, "updated_at": 0.9}]


@desk.get("/api/jobs/j9")
def desk_job(req: Request):
    pending = [{"id": "ap1", "category": "shell", "action": "run", "summary": "Run the command `git push`", "detail": "In Terminal",
                "screenshot": "", "job": "j9", "answer": None, "asked_at": 1_700_000_000.0, "step": 3}] if STATE["desk_pending"] else []
    return {"id": "j9", "goal": "Fill the timesheet", "status": "waiting", "steps": [], "approvals": pending, "pending_approvals": pending}


@desk.post("/api/jobs/{jid}/approvals/{aid}")
async def desk_answer(jid: str, aid: str, req: Request):
    if (jid, aid) != ("j9", "ap1"):
        return JSONResponse({"detail": "Not found"}, 404)
    SEEN["desk"].append((aid, await req.json()))
    STATE["desk_pending"] = False
    return {"ok": True, "approval": aid, "approve": True}


@browser.get("/api/jobs")
def browser_jobs(req: Request):
    if not _auth(req):
        return JSONResponse({"detail": "Invalid or missing bearer token"}, 401)
    return [{"id": "b3", "goal": "Order the toner", "status": "running", "source": "workbench", "created_at": 3.0, "updated_at": 4.0}]


@browser.get("/api/jobs/b3")
def browser_job():
    pending = [{"id": "ap2", "category": "purchase", "label": "A purchase", "action": "click", "description": "Place the order",
                "url": "https://shop.example/checkout", "job": "b3", "answer": None, "asked_at": 1_700_000_100.0}] if STATE["browser_pending"] else []
    return {"id": "b3", "goal": "Order the toner", "status": "running", "steps": [], "approvals": pending, "pending_approvals": pending}


@browser.post("/api/jobs/b3/approvals/{aid}")
async def browser_answer(aid: str, req: Request):
    SEEN["browser"].append((aid, await req.json()))
    STATE["browser_pending"] = False
    return {"ok": True, "approval": aid, "approve": False}


@pytest.fixture(scope="module")
def helper_url():
    port = _port()
    server = uvicorn.Server(uvicorn.Config(helpers, host="127.0.0.1", port=port, log_level="error"))
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
            break
        except OSError:
            time.sleep(0.1)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True


@pytest.fixture
def helpers_on(client, helper_url, monkeypatch):
    from app import config

    monkeypatch.setattr(config, "DESK_URL", f"{helper_url}/desk")
    monkeypatch.setattr(config, "DESK_API_KEY", HELPER_KEY)
    monkeypatch.setattr(config, "BROWSER_URL", f"{helper_url}/browser")
    monkeypatch.setattr(config, "BROWSER_API_KEY", HELPER_KEY)
    for v in SEEN.values():
        v.clear()
    STATE.update(desk_pending=True, browser_pending=True)
    return helper_url


def _settle(client) -> None:
    from app import actions, db, jobs

    jobs.ensure()
    for j in db.all(f"SELECT id FROM jobs WHERE status IN ({','.join('?' * len(jobs.ACTIVE))})", *jobs.ACTIVE):
        try:
            jobs.stop(j["id"])
        except Exception:  # noqa: BLE001
            pass
    for a in actions.pending():
        try:
            actions.decide(a["id"], False, "test")
        except Exception:  # noqa: BLE001
            pass


def _inbox(client) -> list[dict]:
    r = client.get("/api/needs-you")
    assert r.status_code == 200, r.text
    return r.json()


def _hold(cid: int, tool: str, args: dict, reason: str = "test") -> int:
    from app import actions

    return actions.add("tool_call", "held", trace={"conversation_id": cid, "channel": "web"}, tool=tool, effect="persistent",
                       payload=json.dumps(args), args=json.dumps(args), detail=reason)


def test_lists_held_actions_newest_first_in_the_contract_shape(client):
    _settle(client)
    SCRIPT[:] = [tool_call("send_email", {"to": "bob@example.com", "subject": "Invoice", "body": "Attached."}),
                 {"role": "assistant", "content": "Waiting for your OK."}]
    ev = events(client.post("/api/assistant/chat", json={"message": "send bob the invoice"}))
    held = next(e for e in ev if e["type"] == "approval_required")
    cid = ev[0]["conversation_id"]
    later = _hold(cid, "remember", {"content": "The user likes short answers"}, "This conversation contains untrusted web or email content.")
    try:
        items = _inbox(client)
        assert [i["id"] for i in items[:2]] == [f"a:{later}", f"a:{held['id']}"]  # newest first
        mail = items[1]
        assert set(mail) >= {"id", "kind", "title", "detail", "since", "conversation_id", "job_id", "actions"}
        assert mail["kind"] == "approval" and mail["actions"] == ["approve", "deny"] and mail["job_id"] is None
        assert mail["conversation_id"] == cid and mail["since"].endswith("+00:00")
        assert mail["title"] == "Send an email: bob@example.com" and "Invoice" in mail["detail"]
        assert mail["reason"] == "Sending email always needs your approval." and mail["tool"] == "send_email"
        assert json.loads(mail["args"])["to"] == "bob@example.com"  # the owner's card shows what will really be sent
        assert items[0]["title"] == "Remember something about you" and "short answers" in items[0]["detail"]
    finally:
        _settle(client)


def test_approve_runs_the_held_action_through_decide(client):
    from app import actions, assistant, db

    _settle(client)
    cid = assistant.new_conversation("web")
    aid = _hold(cid, "remember", {"content": "Needs you approved this fact"})
    r = client.post(f"/api/needs-you/a:{aid}/approve")
    assert r.status_code == 200, r.text
    assert r.json()["id"] == f"a:{aid}" and r.json()["status"] == "done"
    try:
        assert exact("Needs you approved this fact")
        assert actions.approval(aid)["status"] == "done"
        last = db.one("SELECT content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1", cid)
        assert last["content"].startswith(f"[I approved request #{aid}: remember.")
        assert f"a:{aid}" not in [i["id"] for i in _inbox(client)]
        assert client.post(f"/api/needs-you/a:{aid}/approve").status_code == 409  # answered once, never repeated
    finally:
        drop("Needs you approved this fact")


def test_deny_records_a_denial_and_runs_nothing(client):
    from app import actions, assistant, db

    _settle(client)
    cid = assistant.new_conversation("web")
    aid = _hold(cid, "remember", {"content": "Needs you denied this fact"})
    r = client.post(f"/api/needs-you/a:{aid}/deny")
    assert r.status_code == 200 and r.json()["status"] == "denied"
    assert not exact("Needs you denied this fact")
    assert actions.approval(aid)["status"] == "denied"
    d = db.one("SELECT outcome FROM actions WHERE kind = 'decision' AND parent_action_id = ?", aid)
    assert d and d["outcome"] == "denied"
    last = db.one("SELECT content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1", cid)
    assert last["content"].startswith(f"[I denied request #{aid}: remember.")
    assert client.post(f"/api/needs-you/a:{aid}/deny").status_code == 409


def test_unknown_ids_are_404(client):
    assert client.get("/api/needs-you").status_code == 200  # the inbox exists; a name it does not know is 404, not 500
    for item in ("a:999999", "j:999999", "x:1", "a:abc", "nothing", "d:j9", "b:"):
        assert client.post(f"/api/needs-you/{item}/approve").status_code == 404, item
    assert client.post("/api/needs-you/a:1/maybe").status_code == 404


def test_a_job_that_asks_first_is_listed_and_routed_to_jobs(client, monkeypatch):
    from app import jobs

    _settle(client)
    j = jobs.create("chat", "Tidy the inbox", "Tidy the inbox", payload={"event_summary": "A new mail arrived"}, ask_first=True)
    item = next(i for i in _inbox(client) if i["id"] == f"j:{j['id']}")
    assert item["kind"] == "job" and item["title"] == "Tidy the inbox" and item["job_id"] == j["id"]
    assert item["detail"] == "A new mail arrived" and item["actions"] == ["approve", "deny"]

    calls = []
    monkeypatch.setattr(jobs, "approve_start", lambda jid, approve: calls.append((jid, approve)) or jobs.get(jid))
    assert client.post(f"/api/needs-you/j:{j['id']}/approve").status_code == 200
    assert calls == [(j["id"], True)]
    monkeypatch.undo()
    r = client.post(f"/api/needs-you/j:{j['id']}/deny")  # the real route: a "no" stops the job before it starts
    assert r.status_code == 200 and r.json()["job"]["status"] == "stopped"
    assert jobs.get(j["id"])["status"] == "stopped"
    assert client.post(f"/api/needs-you/j:{j['id']}/deny").status_code == 409


def test_desk_and_browser_approvals_are_listed_counted_and_answered(client, helpers_on):
    _settle(client)
    items = _inbox(client)
    by_id = {i["id"]: i for i in items}
    d, b = by_id["d:j9:ap1"], by_id["b:b3:ap2"]
    assert d["kind"] == "desktop" and d["title"] == "Run the command `git push`" and d["detail"] == "In Terminal"
    assert d["job_id"] == "j9" and d["conversation_id"] is None and d["since"].startswith("2023-11-14T22:13:20")
    assert b["kind"] == "browser" and b["title"] == "Place the order" and b["detail"] == "A purchase on shop.example"
    assert b["job_id"] == "b3" and b["since"] > d["since"]
    assert [i["id"] for i in items[:2]] == ["b:b3:ap2", "d:j9:ap1"]  # newest first across systems
    assert f"Bearer {HELPER_KEY}" in SEEN["auth"]
    assert client.get("/api/presence", params={"fresh": "true"}).json()["needs_you"] == 2

    r = client.post("/api/needs-you/d:j9:ap1/approve")
    assert r.status_code == 200 and r.json()["status"] == "approved" and SEEN["desk"] == [("ap1", {"approve": True})]
    r = client.post("/api/needs-you/b:b3:ap2/deny")
    assert r.status_code == 200 and r.json()["status"] == "denied" and SEEN["browser"] == [("ap2", {"approve": False})]
    assert not {"d:j9:ap1", "b:b3:ap2"} & {i["id"] for i in _inbox(client)}
    assert client.get("/api/presence", params={"fresh": "true"}).json()["needs_you"] == 0
    assert client.post("/api/needs-you/d:j9:zz/approve").status_code == 404


def test_helpers_that_are_off_or_unreachable_count_as_nothing(client, monkeypatch):
    from app import config

    _settle(client)
    monkeypatch.setattr(config, "DESK_URL", "http://127.0.0.1:9")  # nothing listens there
    monkeypatch.setattr(config, "DESK_API_KEY", HELPER_KEY)
    monkeypatch.setattr(config, "BROWSER_URL", "")
    assert _inbox(client) == []
    assert client.get("/api/presence", params={"fresh": "true"}).json()["needs_you"] == 0
    assert client.post("/api/needs-you/d:j9:ap1/approve").status_code == 502  # an answer cannot be lost silently


def test_needs_you_requires_sign_in(client):
    from fastapi.testclient import TestClient

    from app import main

    anon = TestClient(main.app)
    assert anon.get("/api/needs-you").status_code == 401
    assert anon.post("/api/needs-you/a:1/approve", headers={"X-Workbench": "1"}).status_code == 401
