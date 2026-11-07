"""feat/coworkers increment 1 (design record 0004): pick a line of work, get a team, connect mail, approve a job, watch it
run, get the result. The mailbox is a real IMAP server (tests/live_imap.py); the model is scripted, as everywhere else."""

import asyncio
import json

import pytest

from conftest import SCRIPT, tool_call
from live_imap import PASSWORD, USER, live_imap  # noqa: F401 - the fixture

SUBJECT = "Quote request: bathroom reno at 12 Smith St"


@pytest.fixture(autouse=True)
def first_run(client):
    """The suite shares one database, so other tests may have left mailboxes. Each test here starts as a new user with
    none: their rows are set aside and put back afterwards with the same ids. Any setup a test leaves (even a failing
    one) is removed, so nothing here can leave a card waiting in Needs you for later tests."""
    from app import db, starters

    kept_drafts = db.all("SELECT * FROM mail_drafts")
    kept = db.all("SELECT * FROM mail_accounts")
    db.run("DELETE FROM mail_drafts")
    db.run("DELETE FROM mail_accounts")
    try:
        yield
    finally:
        for p in starters.catalogue():
            if p["set_up"]:
                starters.remove(p["id"])
        db.run("DELETE FROM mail_drafts")
        db.run("DELETE FROM mail_accounts")
        for table, rows in (("mail_accounts", kept), ("mail_drafts", kept_drafts)):
            for r in rows:
                db.run(f"INSERT INTO {table} ({', '.join(r)}) VALUES ({', '.join('?' * len(r))})", *r.values())


def _tool_text(msgs: list[dict], name: str) -> str:
    return "\n".join(m.get("content") or "" for m in msgs if m.get("role") == "tool" and (m.get("name") in (name, None)))


def test_proposal_is_honest_and_needs_nothing_installed(client):
    r = client.get("/api/starters").json()
    assert {"construction", "business", "personal"} <= {p["id"] for p in r["professions"]}
    p = client.post("/api/starters/proposal", json={"professions": ["construction"], "region": "Brisbane"}).json()
    team = p["professions"][0]["team"]
    assert [m["role"] for m in team].count("coordinator") == 1 and len(team) == 4
    jobs = p["professions"][0]["schedules"]
    assert all(j["missing"] == ["Connect your email first."] for j in jobs)  # no mailbox yet
    card = jobs[0]["card"]
    assert card["requester"] == "Office manager" and card["reads"] and card["changes"] and card["risks"]
    by = {i["key"]: i for i in p["integrations"]}
    assert by["mail"]["state"] == "ready" and by["procore"]["state"] == "not_built"
    assert by["servicem8"]["kind"] == "official_api" and "never a real account" in by["servicem8"]["tested"]
    assert client.post("/api/starters/proposal", json={"professions": ["astronaut"]}).status_code == 404
    assert client.post("/api/starters/proposal", json={"professions": []}).status_code == 400


def test_a_new_user_gets_a_working_construction_team(client, monkeypatch, live_imap):  # noqa: F811
    from app import db, mail, scheduler

    monkeypatch.setattr(mail, "CTX", live_imap.context())  # trust the test server's own certificate, nothing else

    # 1. Pick construction; rename one coworker; keep one job, drop nothing yet
    r = client.post("/api/starters/apply", json={
        "profession": "construction", "region": "Brisbane",
        "team": [{"key": "quotes", "name": "Jo (quotes)", "monthly_budget_cents": 300}]})
    assert r.status_code == 200, r.text
    setup = r.json()
    names = [a["name"] for a in setup["team"]]
    assert names == ["Office manager", "Jo (quotes)", "Accounts", "Crew updates"]
    office = setup["team"][0]
    assert all(db.one("SELECT reports_to FROM agents WHERE id = ?", a["id"])["reports_to"] == office["id"] for a in setup["team"][1:])
    assert db.one("SELECT monthly_budget_cents FROM agents WHERE name = 'Jo (quotes)'")["monthly_budget_cents"] == 300
    assert "Do not assume local laws" in db.one("SELECT instructions FROM agents WHERE id = ?", office["id"])["instructions"]
    jobs = {j["key"]: j for j in setup["schedules"]}
    assert all(j["state"] == "waiting" for j in jobs.values())
    assert not db.one("SELECT 1 AS x FROM schedules WHERE enabled = 1 AND id IN (?, ?)",
                      jobs["morning_mail"]["schedule_id"], jobs["friday_invoices"]["schedule_id"])
    assert client.post("/api/starters/apply", json={"profession": "construction"}).status_code == 409  # no duplicates

    # 2. Each job waits for the owner in Needs you, with a card that says what it reads, changes and returns
    morning = jobs["morning_mail"]["schedule_id"]
    waiting = {i["id"]: i for i in client.get("/api/needs-you").json()}
    item = waiting[f"s:{morning}"]
    assert item["kind"] == "schedule" and item["card"]["requester"] == "Office manager"
    assert "Connect your email first." in item["detail"]
    r = client.post(f"/api/needs-you/s:{morning}/approve")
    assert r.status_code == 409 and "Connect your email first." in r.text  # cannot be turned on without its mailbox
    assert not db.one("SELECT enabled FROM schedules WHERE id = ?", morning)["enabled"]

    # 3. Connect one real mailbox (app password), through the same route the Accounts page uses
    r = client.post("/api/mail/accounts", json={
        "name": "Work", "email": USER, "imap_host": live_imap.host, "imap_port": live_imap.port,
        "smtp_host": live_imap.host, "smtp_port": 465, "username": USER, "password": PASSWORD})
    assert r.status_code == 200, r.text
    bad = client.post("/api/mail/accounts", json={
        "name": "Wrong", "email": USER, "imap_host": live_imap.host, "imap_port": live_imap.port,
        "smtp_host": live_imap.host, "smtp_port": 465, "username": USER, "password": "wrong"})
    assert bad.status_code == 502  # a wrong password is refused by the real server, not stored

    # 4. Approve the morning job, say no to the Friday one
    ok = client.post(f"/api/needs-you/s:{morning}/approve").json()
    assert ok["status"] == "approved" and ok["result"]
    assert client.post(f"/api/needs-you/s:{morning}/approve").status_code == 409  # answered once
    friday = jobs["friday_invoices"]["schedule_id"]
    assert client.post(f"/api/needs-you/s:{friday}/deny").json()["status"] == "denied"
    assert not db.one("SELECT 1 AS x FROM schedules WHERE id = ?", friday)
    row = db.one("SELECT * FROM schedules WHERE id = ?", morning)
    assert row["enabled"] == 1 and row["next_run"] and row["agent_id"] == office["id"]
    assert f"s:{morning}" not in {i["id"] for i in client.get("/api/needs-you").json()}

    # 5. A customer email arrives in the real mailbox; the job comes due and the coworker runs it
    live_imap.append("Sam Lee <sam@client.example>", SUBJECT, "Hi, can you quote a bathroom renovation at 12 Smith St?",
                     "<q1@client.example>")
    seen = {}

    def summary(msgs):
        found = _tool_text(msgs, "search_email")
        seen["search"] = found
        seen["system"] = msgs[0]["content"]
        quoted = SUBJECT if SUBJECT in found else "nothing found"
        return {"role": "assistant", "content": f"Quotes\n- Sam Lee: {quoted}\nInvoices\n- none\nJobs\n- none\nWaiting for your OK\n- nothing"}

    SCRIPT[:] = [tool_call("search_email", {"query": ""}, "a"),
                 tool_call("create_task", {"title": "Quote: bathroom reno, 12 Smith St (Sam Lee)"}, "b"),
                 summary]
    db.run("UPDATE schedules SET next_run = ? WHERE id = ?", "2000-01-01T00:00:00+00:00", morning)
    due = db.all("SELECT * FROM schedules WHERE enabled = 1 AND next_run <= ?", db.now())
    assert [d["id"] for d in due] == [morning]  # exactly what the scheduler loop picks up
    asyncio.run(scheduler.run_schedule(due[0]))

    # 6. It ran as the coworker, on the real mail, and the result is correct and delivered
    assert SUBJECT in seen["search"] and "sam@client.example" in seen["search"]
    assert "Office manager" in seen["system"]
    out = db.one("SELECT * FROM inbox WHERE source = ? ORDER BY id DESC", f"schedule:{morning}")
    assert out["title"] == "Morning mail check" and f"Sam Lee: {SUBJECT}" in out["body"]
    assert db.one("SELECT 1 AS x FROM tasks WHERE title LIKE 'Quote: bathroom reno%'")
    row = db.one("SELECT * FROM schedules WHERE id = ?", morning)
    assert row["last_status"] == "ok" and row["next_run"] > db.now()  # next slot booked, not re-run
    run = db.one("SELECT id FROM conversations WHERE channel = 'schedule' AND external_id = ? ORDER BY id DESC", str(morning))
    calls = db.all("SELECT tool, outcome, agent_id FROM actions WHERE kind = 'tool_call' AND conversation_id = ? ORDER BY id", run["id"])
    assert [(c["tool"], c["outcome"]) for c in calls][:2] == [("search_email", calls[0]["outcome"]), ("create_task", calls[1]["outcome"])]
    assert {c["agent_id"] for c in calls} == {office["id"]}  # the run log names the coworker on every step
    shown = client.get(f"/api/starters/construction").json()
    assert [j["state"] for j in shown["schedules"]] == ["on"] and shown["schedules"][0]["last_status"] == "ok"

    # 7. Undo the profession: its coworkers and job go; the mailbox, the task and the result stay
    assert client.delete("/api/starters/construction").json() == {"removed": "construction"}
    assert not db.one("SELECT 1 AS x FROM agents WHERE id = ?", office["id"])
    assert not db.one("SELECT 1 AS x FROM schedules WHERE id = ?", morning)
    assert db.one("SELECT 1 AS x FROM mail_accounts WHERE email = ?", USER)
    assert db.one("SELECT 1 AS x FROM tasks WHERE title LIKE 'Quote: bathroom reno%'")
    assert db.one("SELECT 1 AS x FROM inbox WHERE id = ?", out["id"])
    assert client.get("/api/starters/construction").status_code == 404
    assert "construction" not in {p["id"] for p in client.get("/api/starters").json()["professions"] if p["set_up"]}


def test_a_coworker_job_cannot_be_turned_on_twice_or_by_a_stranger(client):
    from app import db

    setup = client.post("/api/starters/apply", json={"profession": "personal"}).json()
    sid = setup["schedules"][0]["schedule_id"]
    assert setup["schedules"][0]["missing"] == []  # the daily brief reads only the app's own calendar and tasks
    from fastapi.testclient import TestClient
    from app.main import app

    stranger = TestClient(app)  # no session cookie
    assert stranger.post(f"/api/needs-you/s:{sid}/approve", headers={"X-Workbench": "1"}).status_code in (401, 403)
    assert stranger.post("/api/starters/apply", headers={"X-Workbench": "1"}, json={"profession": "business"}).status_code in (401, 403)
    assert client.post(f"/api/needs-you/s:{sid}/approve").json()["status"] == "approved"
    assert client.post(f"/api/needs-you/s:{sid}/deny").status_code == 409
    assert db.one("SELECT enabled FROM schedules WHERE id = ?", sid)["enabled"] == 1
    client.delete("/api/starters/personal")
    assert json.dumps(client.get("/api/starters").json())  # still serialisable after removal
