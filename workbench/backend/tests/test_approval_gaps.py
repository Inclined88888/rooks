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
