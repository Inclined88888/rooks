"""AI coworkers (Teammates and Company): limits hold when a tool runs, not only in the list the model is shown, and a
company task that crashes ends with an outcome instead of staying "running" forever. Offline."""

import asyncio

import pytest

from conftest import CALLS, SCRIPT, events, tool_call


@pytest.fixture(autouse=True)
def quiet_learning(monkeypatch):
    from app.knowledge import facts

    async def nothing(*a, **k):
        return []

    monkeypatch.setattr(facts, "model_json", nothing)
    yield
    # The scripted model's log is shared by the whole suite: a later test that reads the first call with tools must
    # not find a teammate's filtered list here (test_assistant.py::test_chat_runs_tools_and_answers did).
    CALLS.clear()
    SCRIPT[:] = []


def _mate(c, **kw):
    r = c.post("/api/teammates", json=kw)
    assert r.status_code == 200, r.text
    return r.json()


def _last_outcome(tool: str) -> str:
    from app import db

    return db.one("SELECT outcome FROM actions WHERE tool = ? ORDER BY id DESC LIMIT 1", tool)["outcome"]


def test_teammate_cannot_run_a_tool_outside_its_groups(client):
    """A teammate limited to web search that names list_files anyway (made up, or told to by a page it read) gets
    "unknown tool", the same as a sub-agent naming a tool it was never offered."""
    t = _mate(client, name="Web only", tools=["web"])
    SCRIPT[:] = [tool_call("list_files", {}), {"role": "assistant", "content": "ok"}]
    CALLS.clear()
    events(client.post(f"/api/teammates/{t['id']}/chat", json={"message": "what files do I have?"}))
    assert "list_files" not in {x["function"]["name"] for x in CALLS[0]["tools"]}
    assert _last_outcome("list_files") == "unknown_tool"
    tool_msgs = [m for m in CALLS[-1]["messages"] if m["role"] == "tool"]
    assert tool_msgs and "Unknown tool" in tool_msgs[-1]["content"]


def test_group_chat_cannot_run_a_tool_that_changes_things(client):
    """In a group chat a teammate has nothing that outlives the turn or acts outside the app. Naming one anyway does
    nothing."""
    from app import db
    from app.teammates import groups

    a = _mate(client, name="Groupie")
    b = _mate(client, name="Groupie two")
    g = client.post("/api/groups", json={"members": [a["id"], b["id"]]}).json()
    before = db.one("SELECT COUNT(*) AS n FROM kn_memories")["n"]
    SCRIPT[:] = [tool_call("remember", {"content": "the user's bank PIN is 1234"}), {"role": "assistant", "content": "noted"}]
    post = groups.post(g["id"], "@Groupie remember this", background=False)
    asyncio.run(groups.run_round(g["id"], post["targets"]))
    assert _last_outcome("remember") == "unknown_tool"
    assert db.one("SELECT COUNT(*) AS n FROM kn_memories")["n"] == before


def test_teammate_send_still_becomes_a_draft(client, monkeypatch):
    """The new check must not turn a hidden send into "unknown tool": it still becomes a draft card."""
    from app import assistant

    sent = []

    async def fake_send(*a, **k):
        sent.append(a)
        return {"sent": True}

    monkeypatch.setattr(assistant, "_send_email", fake_send)
    t = _mate(client, name="Limited sender", tools=["web"])
    SCRIPT[:] = [tool_call("send_email", {"to": "x@example.com", "subject": "s", "body": "b"}),
                 {"role": "assistant", "content": "Drafted."}]
    ev = events(client.post(f"/api/teammates/{t['id']}/chat", json={"message": "email x"}))
    assert sent == [] and [e for e in ev if e["type"] == "draft"]
    assert _last_outcome("send_email") == "drafted"


def test_company_task_that_crashes_ends_failed_and_tells_the_board(client, monkeypatch):
    """If the turn raises, the task used to stay "running" forever (the worker only picks queued tasks) and was run
    again from the start on the next restart, repeating anything it had already done."""
    from app import assistant, company, db, scheduler

    async def boom(*a, **k):
        raise RuntimeError("model went away")

    delivered = []
    monkeypatch.setattr(assistant, "ask", boom)
    monkeypatch.setattr(scheduler, "deliver", lambda title, body, *a, **k: delivered.append((title, body)))
    ag = client.post("/api/company/agents", json={"name": "Crashy", "title": "Analyst"}).json()
    t = company.create_task("Summarise the quarter", agent_id=ag["id"])
    asyncio.run(company.run_task(t["id"]))
    row = db.one("SELECT status, result FROM agent_tasks WHERE id = ?", t["id"])
    assert row["status"] == "failed"
    assert row["result"] and "Traceback" not in row["result"]
    assert delivered and "failed" in delivered[-1][0]
    company.recover()  # a restart must not run it again
    assert db.one("SELECT status FROM agent_tasks WHERE id = ?", t["id"])["status"] == "failed"
