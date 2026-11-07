"""The presence strip (design 0003, section 8): what the assistant is doing right now, read from state the app
already keeps. Cheap, honest, cached for a second; secrets and addresses never reach the status line."""

import asyncio
import json
import threading
import time

from conftest import SCRIPT, events, tool_call

GATE = threading.Event()  # while set, a patched tool or model call hangs, so presence can be read mid-turn
KEYS = {"name", "mood", "doing", "doing_tool", "doing_args", "where", "watching", "needs_you", "running", "updated_at"}


def _presence(client) -> dict:
    r = client.get("/api/presence", params={"fresh": "true"})
    assert r.status_code == 200, r.text
    return r.json()


def _wait(client, ready, timeout: float = 8.0) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        p = _presence(client)
        if ready(p) or time.monotonic() > deadline:
            return p
        time.sleep(0.05)


def _settle(client) -> None:
    """Leftovers from earlier tests (undecided approvals, active jobs) are not this file's subject: clear them."""
    from app import actions, assistant, db, jobs

    assert not any(not t.done() for t in assistant.TURNS.values())
    jobs.ensure()
    for j in db.all(f"SELECT id FROM jobs WHERE status IN ({','.join('?' * len(jobs.ACTIVE))})", *jobs.ACTIVE):
        try:
            jobs.stop(j["id"])
        except Exception:  # noqa: BLE001 - already finished in between
            pass
    for a in actions.pending():
        try:
            actions.decide(a["id"], False, "test")
        except Exception:  # noqa: BLE001 - decided in between
            pass
    db.run("UPDATE actions SET outcome = 'interrupted' WHERE kind = 'turn' AND outcome = 'running'")


def _run_in_thread(client, message: str) -> tuple[threading.Thread, dict]:
    body: dict = {}

    def run():
        with client.stream("POST", "/api/assistant/chat", json={"message": message}) as r:
            body["text"] = r.read().decode()

    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t, body


def _hang(real):
    """A tool body that waits for the gate, then does the real thing (same signature: the loop filters arguments by it)."""
    import inspect

    async def slow(**kw):
        while GATE.is_set():
            await asyncio.sleep(0.02)
        return real(**kw)

    slow.__signature__ = inspect.signature(real)
    return slow


def test_idle_shape_is_the_contract_and_the_name_is_the_setting(client, monkeypatch):
    from app import db, presence

    _settle(client)
    monkeypatch.setattr(presence, "DONE_S", 0)  # a turn an earlier test just finished must not read as "done" here
    p = _presence(client)
    assert set(p) == KEYS
    assert p["name"] == "Atlas" and p["mood"] == "idle"
    assert p["doing"] is None and p["doing_tool"] is None and p["doing_args"] is None and p["where"] is None
    assert p["needs_you"] == 0 and p["running"] == {"turns": 0, "jobs": 0}
    assert isinstance(p["watching"], list) and set(p["watching"]) <= {"mail", "calendar", "jobs", "room"}
    assert p["updated_at"].endswith("+00:00") and "T" in p["updated_at"]

    db.set_setting("assistant_name", "Juno")
    try:
        assert _presence(client)["name"] == "Juno"
    finally:
        db.set_setting("assistant_name", "Atlas")


def test_the_answer_is_cached_for_a_second(client):
    from app import db

    _settle(client)
    first = client.get("/api/presence").json()
    db.set_setting("assistant_name", "Mira")
    try:
        assert client.get("/api/presence").json()["name"] == first["name"]  # within the second: the cached answer
        assert _presence(client)["name"] == "Mira"  # fresh=true rebuilds it
    finally:
        db.set_setting("assistant_name", "Atlas")
    assert _presence(client)["name"] == "Atlas"


def test_watching_follows_mail_calendar_and_jobs(client):
    from app import db, jobs

    _settle(client)
    had_mail = bool(db.one("SELECT 1 FROM mail_accounts LIMIT 1"))
    had_calendar = bool(db.one("SELECT 1 FROM calendars WHERE enabled = 1 LIMIT 1"))
    base = _presence(client)["watching"]
    assert ("mail" in base) == had_mail and ("calendar" in base) == had_calendar and "jobs" not in base

    mid = db.run("INSERT INTO mail_accounts(name, email, imap_host, smtp_host, username, password_enc) VALUES (?, ?, ?, ?, ?, ?)",
                 "Work", "me@example.com", "imap.example.com", "smtp.example.com", "me", "")
    cal = db.run("INSERT INTO calendars(name, kind, color, enabled) VALUES ('Presence test', 'ics', '#000000', 1)")
    jobs.ensure()
    jid = db.run("INSERT INTO jobs(kind, title, prompt, status, created_at, updated_at) VALUES ('browser', 'Fill the timesheet', 'x', 'running', ?, ?)",
                 db.now(), db.now())
    try:
        p = _presence(client)
        assert p["watching"] == ["mail", "calendar", "jobs"]
        # a running job is what the assistant is doing when no turn is in flight; a browser job means the browser
        assert p["mood"] == "working" and p["running"] == {"turns": 0, "jobs": 1}
        assert p["doing"] == "Fill the timesheet" and p["where"] == "browser" and p["doing_tool"] is None
    finally:
        db.run("DELETE FROM jobs WHERE id = ?", jid)
        db.run("DELETE FROM calendars WHERE id = ?", cal)
        db.run("DELETE FROM mail_accounts WHERE id = ?", mid)
    assert "jobs" not in _presence(client)["watching"]


def test_thinking_before_the_first_tool_call(client, monkeypatch):
    import app.llm as llm

    _settle(client)
    real_chat = llm.chat

    async def hanging_chat(ref, messages, tools=None, trace=None, schema=None):
        while GATE.is_set():
            await asyncio.sleep(0.02)
        return await real_chat(ref, messages, tools, trace, schema)

    monkeypatch.setattr(llm, "chat", hanging_chat)
    SCRIPT[:] = [{"role": "assistant", "content": "hello"}]
    GATE.set()
    t, body = _run_in_thread(client, "just a question")
    try:
        p = _wait(client, lambda p: p["running"]["turns"] == 1)
        assert p["mood"] == "thinking" and p["doing"] is None and p["doing_tool"] is None and p["where"] == "chat"
    finally:
        GATE.clear()
        t.join(timeout=10)
    assert not t.is_alive() and '"type": "done"' in body["text"]


def test_working_shows_the_current_step_then_done(client, monkeypatch):
    from app import assistant

    _settle(client)
    tool = assistant.TOOL_MAP["list_tasks"]
    monkeypatch.setattr(tool, "fn", _hang(tool.fn))
    SCRIPT[:] = [tool_call("list_tasks", {}), {"role": "assistant", "content": "Nothing is open."}]
    GATE.set()
    t, body = _run_in_thread(client, "what is open?")
    try:
        p = _wait(client, lambda p: p["doing_tool"] == "list_tasks")
        assert p["mood"] == "working" and p["doing"] == "Checking tasks" and p["where"] == "chat"
        assert p["doing_tool"] == "list_tasks" and p["running"]["turns"] == 1
    finally:
        GATE.clear()
        t.join(timeout=10)
    assert not t.is_alive() and '"type": "done"' in body["text"]
    p = _presence(client)
    assert p["mood"] == "done" and p["doing"] is None and p["doing_tool"] is None and p["running"]["turns"] == 0


def test_doing_args_are_redacted_and_short(client, monkeypatch):
    from app import assistant

    _settle(client)
    tool = assistant.TOOL_MAP["create_task"]
    monkeypatch.setattr(tool, "fn", _hang(tool.fn))
    title = "Pay alice@example.com with sk-proj-" + "a" * 30 + " " + "x" * 300
    SCRIPT[:] = [tool_call("create_task", {"title": title, "notes": "call +61 412 345 678"}),
                 {"role": "assistant", "content": "Added."}]
    GATE.set()
    t, _ = _run_in_thread(client, "add that task")
    try:
        p = _wait(client, lambda p: p["doing_tool"] == "create_task")
        text = json.dumps(p)
        assert "alice@example.com" not in text and "sk-proj" not in text and "412 345" not in text
        assert p["doing_args"].startswith("title: Pay <email> with <redacted:key>") and len(p["doing_args"]) <= 120
        assert p["doing"].startswith("Adding a task: Pay <email>") and len(p["doing"]) <= 90
    finally:
        GATE.clear()
        t.join(timeout=10)
    assert not t.is_alive()


def test_needs_you_counts_a_held_tool_call(client):
    _settle(client)
    SCRIPT[:] = [tool_call("send_email", {"to": "bob@example.com", "subject": "Hi", "body": "Hello"}),
                 {"role": "assistant", "content": "I need your OK to send it."}]
    ev = events(client.post("/api/assistant/chat", json={"message": "email bob"}))
    held = next(e for e in ev if e["type"] == "approval_required")
    p = _presence(client)
    assert p["needs_you"] == 1 and p["mood"] == "needs"
    assert client.post(f"/api/needs-you/a:{held['id']}/deny").status_code == 200
    p = _presence(client)
    assert p["needs_you"] == 0 and p["mood"] != "needs"


def test_presence_needs_sign_in(client):
    from fastapi.testclient import TestClient

    from app import main

    assert TestClient(main.app).get("/api/presence").status_code == 401
