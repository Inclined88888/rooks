"""Approval gaps closed after design record 0004 (section 3, items 3 and 4).

1. schedule_task creates work that runs by itself until turned off, so it needs the owner's yes even in a clean chat.
2. The app's own MCP server ran skill scripts for any client holding the tools key with nobody asked. It now holds the
   call in Needs you, like every other surface, and runs it once on yes.
"""

import asyncio

from conftest import SCRIPT, events, tool_call


def test_a_new_schedule_needs_a_yes_even_in_a_clean_chat(client):
    from app import db

    SCRIPT[:] = [tool_call("schedule_task", {"name": "gap-daily", "cron": "0 6 * * *", "prompt": "Summarise my day"}, "s"),
                 {"role": "assistant", "content": "I need your OK to set that up."}]
    ev = events(client.post("/api/assistant/chat", json={"message": "Set up my morning summary for 6am"}))
    held = [e for e in ev if e["type"] == "approval_required"]
    assert [h["tool"] for h in held] == ["schedule_task"]
    assert "runs by itself" in held[0]["reason"]
    assert not db.one("SELECT 1 AS x FROM schedules WHERE name = 'gap-daily'")  # nothing yet
    assert client.post(f"/api/approvals/{held[0]['id']}", json={"approve": True}).json()["status"] == "done"
    assert db.one("SELECT enabled FROM schedules WHERE name = 'gap-daily'")["enabled"] == 1
    assert client.post(f"/api/approvals/{held[0]['id']}", json={"approve": True}).status_code == 409
    db.run("DELETE FROM schedules WHERE name = 'gap-daily'")
    # The owner's own sentence ("every morning at 6 ...") is still saved straight away by the front door: that is the
    # owner asking, not an agent deciding, and no third party text can reach it.


def test_the_mcp_server_cannot_run_skill_code_without_the_owner(client, monkeypatch):
    from app import db, mcp_server, skills_hub

    ran = []
    monkeypatch.setattr(skills_hub, "run_script", lambda name, script, args=None: ran.append((name, script, args)) or
                        {"ok": True, "stdout": "converted", "violations": []})
    out = asyncio.run(mcp_server.run_skill_script("pdf-tools", "scripts/convert.py", ["my file.pdf", "--fast"]))
    assert ran == []  # not run
    assert out["status"] == "waiting" and out["request"] and "Needs you" in out["message"]
    again = asyncio.run(mcp_server.run_skill_script("pdf-tools", "scripts/convert.py", ["my file.pdf", "--fast"]))
    assert again["request"] == out["request"] and ran == []  # asked once, however often the client calls
    waiting = {i["id"]: i for i in client.get("/api/needs-you").json()}
    assert f"a:{out['request']}" in waiting and waiting[f"a:{out['request']}"]["tool"] == "run_skill_script"

    assert client.post(f"/api/needs-you/a:{out['request']}/approve").json()["status"] == "done"
    assert ran == [("pdf-tools", "scripts/convert.py", ["my file.pdf", "--fast"])]  # once, arguments intact
    assert client.post(f"/api/needs-you/a:{out['request']}/approve").status_code == 409
    row = db.one("SELECT channel FROM actions WHERE id = ?", out["request"])
    assert row["channel"] == "mcp"  # the run log says where the request came from


def test_the_mcp_server_says_no_when_the_owner_says_no(client, monkeypatch):
    from app import mcp_server, skills_hub

    ran = []
    monkeypatch.setattr(skills_hub, "run_script", lambda *a, **k: ran.append(a) or {"ok": True})
    out = asyncio.run(mcp_server.run_skill_script("pdf-tools", "scripts/wipe.py", []))
    assert client.post(f"/api/needs-you/a:{out['request']}/deny").json()["status"] == "denied"
    assert ran == []


def test_the_tools_key_cannot_answer_a_held_request(client, monkeypatch):
    """The MCP server's client holds TOOLS_API_KEY. If that key also opened the account, the same program could say yes
    to its own held request. It is not a login (surfaces.bearer_ok), so the answer must come from a person."""
    import os

    from fastapi.testclient import TestClient

    from app import main, mcp_server, skills_hub

    ran = []
    monkeypatch.setattr(skills_hub, "run_script", lambda *a, **k: ran.append(a) or {"ok": True})
    out = asyncio.run(mcp_server.run_skill_script("pdf-tools", "scripts/self-approve.py", []))
    bot = TestClient(main.app, headers={"X-Workbench": "1", "Authorization": f"Bearer {os.environ['TOOLS_API_KEY']}"})
    assert bot.post(f"/api/needs-you/a:{out['request']}/approve").status_code == 401
    assert bot.post(f"/api/approvals/{out['request']}", json={"approve": True}).status_code == 401
    assert ran == []
    assert client.post(f"/api/needs-you/a:{out['request']}/deny").json()["status"] == "denied"


def test_an_approved_step_of_a_coworker_runs_as_that_coworker(client):
    """A coworker's run holds delegate_task (untrusted content was in play). The owner's yes used to run the step as
    nobody, so the agent-only tool came back "Unknown tool". It runs as the coworker and the task is queued."""
    import json

    from app import assistant, db

    boss = client.post("/api/company/agents", json={"name": "Gap boss", "title": "Lead"}).json()
    rep = client.post("/api/company/agents", json={"name": "Gap report", "title": "Analyst"}).json()
    # The app's company worker (company.loop, every 10 s) runs any queued task of an active coworker as a full turn.
    # Left queued, this one ran during the next test files, took their scripted replies and saved a user message of its
    # own (test_assistant, test_attachments failed about one run in three). A paused report still gets the task queued,
    # which is what this test checks, and the worker never runs it.
    db.run("UPDATE agents SET reports_to = ?, status = 'paused', paused_reason = 'test' WHERE id = ?", boss["id"], rep["id"])
    try:
        boss_row = db.one("SELECT * FROM agents WHERE id = ?", boss["id"])
        conv = assistant.new_conversation("agent", "Gap boss: plan", "gap-task", boss["id"])
        ctx = assistant.Ctx(channel="agent", conversation_id=conv, agent=boss_row, tainted=True)
        ok, out = asyncio.run(assistant.run_tool("delegate_task", json.dumps({"agent_name": "Gap report", "title": "Count the beans",
                                                                               "description": "all of them"}), ctx))
        assert not ok and ctx.receipts[-1]["outcome"] == "held", out
        aid = ctx.receipts[-1]["action_id"]
        r = client.post(f"/api/needs-you/a:{aid}/approve").json()
        assert r["status"] == "done" and "Unknown tool" not in (r.get("result") or ""), r
        assert db.one("SELECT 1 AS x FROM agent_tasks WHERE title = 'Count the beans' AND agent_id = ?", rep["id"])
    finally:
        db.run("DELETE FROM agent_tasks WHERE agent_id IN (?, ?)", boss["id"], rep["id"])
        db.run("DELETE FROM agents WHERE id IN (?, ?)", rep["id"], boss["id"])


def test_turning_a_proposed_job_on_from_the_automations_page_answers_its_card(client):
    """PATCH /api/schedules used to switch a setup's job on with no check; it goes through the card, so a job whose
    connection is missing stays off with a plain reason."""
    setup = client.post("/api/starters/apply", json={"profession": "business"}).json()
    try:
        page = client.get("/api/starters/business").json()
        job = next(j for j in page["schedules"] if j["state"] == "waiting" and j["missing"])
        r = client.patch(f"/api/schedules/{job['schedule_id']}", json={"enabled": True})
        assert r.status_code == 409, r.text
        assert "Connect" in r.json()["detail"]
        assert client.get("/api/schedules").json()  # still listed
        from app import db
        assert db.one("SELECT enabled FROM schedules WHERE id = ?", job["schedule_id"])["enabled"] == 0
        assert any(i["id"] == f"s:{job['schedule_id']}" for i in client.get("/api/needs-you").json())  # card still there
    finally:
        client.delete("/api/starters/business")
    assert setup

