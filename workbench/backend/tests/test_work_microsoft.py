"""The work account with Microsoft 365 (design 0012): one sign-in that asks only who you are, then one switch at a time
(OneDrive and SharePoint, Teams, meeting transcripts, Planner and To Do), each asking only for its own permissions.

Everything runs against the fake sign-in and fake Microsoft Graph in fake_graph.py. Its tokens carry the consented
scopes and refuse a call without one, so "least privilege" is what the fake enforces, not what the app claims. Every
write (upload, new version, share, cell edit, post, task change) is proven held in Needs you until the person's yes,
run exactly once after it with the stored arguments, and never approved by a background job's key.

Not tested here (no real accounts): a real tenant, real admin consent, conditional access, sensitivity labels, real
throttling, real transcripts, and which permissions a real company lets a person approve.
"""

import hashlib
import json
import logging
import os
import sqlite3

import httpx
import pytest
from fastapi.testclient import TestClient

import fake_graph as FG
from conftest import SCRIPT, _port, events, tool_call

IDENTITY = {"openid", "email", "profile", "offline_access", "User.Read"}
TERMINAL = "wb_terminal-work-token-0123456789"
BRIDGE = "b" * 40
CODING = "c" * 40
W = {"X-Workbench": "1"}


@pytest.fixture(scope="module")
def graph_url():
    server = FG.serve(port := _port())
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True


@pytest.fixture
def work(client, graph_url, monkeypatch):
    for k, v in {"MICROSOFT_LOGIN_BASE": f"{graph_url}/ms", "GRAPH_API_BASE": f"{graph_url}/graph/v1.0",
                 "MICROSOFT_OAUTH_CLIENT_ID": "ms-client-id", "MAIL_AUTODETECT_ONLINE": "0"}.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("MICROSOFT_OAUTH_TENANT", raising=False)
    FG.reset()
    SCRIPT[:] = []
    from app import actions, db

    for a in actions.pending():
        try:
            actions.decide(a["id"], False, "test")
        except Exception:  # noqa: BLE001
            pass
    yield graph_url
    from app import connect

    for a in db.all("SELECT id FROM linked_accounts"):
        connect.disconnect(a["id"])
    db.run("DELETE FROM tasks WHERE origin != ''")
    SCRIPT[:] = []


def _sign_in(client, feature: str | None = None, code: str = "w-code", query: str = "") -> dict:
    if feature:
        r = client.post(f"/api/work/features/{feature}", json={"on": True})
    else:
        r = client.post("/api/work/connect/microsoft", json={})
    assert r.status_code == 200, r.text
    start = r.json()
    if not start.get("url"):
        return {"start": start}
    q = FG.query_of(start["url"])
    page = httpx.get(f"{q['redirect_uri']}?{query or f'code={code}'}&state={q['state']}", timeout=20)
    return {"start": start, "q": q, "page": page, "status": client.get(f"/api/connect/status/{q['state']}").json()}


def _features(client) -> dict:
    return {f["id"]: f for f in client.get("/api/work/status").json()["features"]}


def _on(client, *features: str) -> None:
    for f in features:
        _sign_in(client, f)
        assert _features(client)[f]["state"] == "on", f


def _chat(client, *calls: dict, final: str = "Waiting for your OK.") -> list[dict]:
    SCRIPT[:] = [*calls, {"role": "assistant", "content": final}]
    return events(client.post("/api/assistant/chat", json={"message": "please"}))


def _held(tool: str) -> dict:
    from app import actions

    rows = [a for a in actions.pending() if a["tool"] == tool]
    assert len(rows) == 1, [a["tool"] for a in actions.pending()]
    return rows[0]


def _anon(client) -> TestClient:
    return TestClient(client.app)


# --- 1.1 and 1.2: one account, least privilege, one switch at a time -------------------------------------------------
def test_first_work_sign_in_asks_only_who_you_are(client, work):
    from app import db

    out = _sign_in(client)
    assert set(out["q"]["scope"].split()) == IDENTITY
    assert out["status"]["status"] == "connected", out["status"]
    assert "Your work account is connected" in out["page"].text
    st = client.get("/api/work/status").json()
    assert st["account"]["email"] == "ana@contoso.com" and st["account"]["provider"] == "microsoft"
    assert {f["id"]: f["state"] for f in st["features"]} == {f: "off" for f in
                                                            ("mail", "calendar", "files_read", "files_change", "chats_read",
                                                             "chats_post", "transcripts", "tasks")}
    row = db.one("SELECT work, tenant, subject FROM linked_accounts WHERE email = 'ana@contoso.com'")
    assert row == {"work": 1, "tenant": FG.TENANT, "subject": FG.OID}
    # A Files call before Files is on is refused by the app and never sent...
    sent = len(FG.S["requests"])
    r = client.get("/api/work/files", params={"query": "budget"})
    assert r.status_code == 409 and r.json()["detail"] == "Reading files is off. Turn it on in Work apps."
    assert len(FG.S["requests"]) == sent
    # ...and the fake would refuse it anyway: the token holds no file permission
    from app import connect

    tok = connect.access_token(db.one("SELECT id FROM linked_accounts WHERE work = 1")["id"])
    r = httpx.get(f"{work}/graph/v1.0/me/drive/root/children", headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 403


def test_turning_on_files_asks_only_for_the_file_permissions(client, work):
    _sign_in(client)
    out = _sign_in(client, "files_read")
    assert set(out["q"]["scope"].split()) == IDENTITY | {"Files.Read.All", "Sites.Read.All"}
    assert out["q"]["login_hint"] == "ana@contoso.com"
    f = _features(client)
    assert f["files_read"]["state"] == "on" and f["files_change"]["state"] == "off" and f["chats_read"]["state"] == "off"
    hits = client.get("/api/work/files", params={"query": "budget"}).json()["items"]
    assert {h["name"] for h in hits} == {"Q3 plan.txt", "Budget.csv"}
    # Change asks for write permission only when that switch is turned on, and says it always asks first
    assert f["files_change"]["asks_first"] and not f["files_read"]["asks_first"]
    out = _sign_in(client, "files_change")
    assert set(out["q"]["scope"].split()) == IDENTITY | {"Files.ReadWrite.All"}


def test_a_personal_microsoft_account_is_not_a_work_account(client, work):
    FG.S["tenant"] = FG.CONSUMER_TENANT
    out = _sign_in(client)
    assert out["status"]["status"] == "failed"
    assert out["status"]["error"] == ("That is a personal Microsoft account. Work apps need the account your company gave you. "
                                      "Personal accounts connect under Mail and calendar.")
    assert client.get("/api/work/status").json()["account"] is None


def test_admin_blocked_switch_waits_for_it_with_a_note_to_copy(client, work):
    _sign_in(client)
    # The company blocks it on Microsoft's own page: the person never gets a code
    out = _sign_in(client, "chats_read", query="error=access_denied&error_description=AADSTS90094%3A+Admin+approval+required")
    assert out["status"]["status"] == "needs_admin"
    st = client.get("/api/work/status").json()
    chats = next(f for f in st["features"] if f["id"] == "chats_read")
    assert chats["state"] == "waiting" and chats["state_words"] == "Waiting for your IT team"
    assert chats["waiting_words"].startswith("Your company asks an IT admin to approve apps")
    note = client.get("/api/work/features/chats_read/it-note").json()["note"]
    for perm in ("Chat.Read", "Team.ReadBasic.All", "Channel.ReadBasic.All", "ChannelMessage.Read.All"):
        assert perm in note
    assert f"/{FG.TENANT}/v2.0/adminconsent?client_id=ms-client-id" in note and "on my own computer" in note
    normal = json.dumps({k: v for k, v in st.items() if k != "advanced"})
    assert "http" not in normal and "AADSTS" not in normal and "adminconsent" not in normal and "Chat.Read" not in normal
    assert "adminconsent" in json.dumps(st["advanced"])
    # The same when the refusal comes back from the token exchange (AADSTS65001)
    FG.S["admin_blocked"] = True
    out = _sign_in(client, "transcripts")
    assert out["status"]["status"] == "needs_admin"
    assert _features(client)["transcripts"]["state"] == "waiting"
    # Once IT approved, turning it on again works and the wait is over
    FG.S["admin_blocked"] = False
    _sign_in(client, "chats_read")
    assert _features(client)["chats_read"]["state"] == "on"


def test_turning_a_switch_off_stops_its_tools_while_the_token_still_holds_the_scope(client, work):
    _sign_in(client)
    _on(client, "files_read", "files_change")
    assert client.get("/api/work/files", params={"query": "budget"}).status_code == 200
    client.get("/api/work/files")  # names for the card
    # A share waits for a yes; meanwhile the person turns Change off
    _chat(client, tool_call("work_file_share", {"file": "drv-me/f2", "people": "lee@contoso.com", "access": "view"}))
    held = _held("work_file_share")
    assert client.post("/api/work/features/files_change", json={"on": False}).json()["state"] == "off"
    assert client.post("/api/work/features/files_read", json={"on": False}).json()["state"] == "off"
    assert "Files.ReadWrite.All" in FG.S["consented"]  # the provider still allows it
    sent = len(FG.S["requests"])
    r = client.post(f"/api/needs-you/a:{held['id']}/approve")
    assert r.json()["status"] == "failed" and "Changing files is off" in r.json()["result"]
    assert client.get("/api/work/files", params={"query": "budget"}).status_code == 409
    assert len(FG.S["requests"]) == sent and FG.S["writes"] == []
    # The tool is not offered at all, and naming it anyway does nothing
    from conftest import CALLS

    CALLS.clear()
    _chat(client, tool_call("work_search", {"query": "budget"}))
    assert "work_search" not in {t["function"]["name"] for t in CALLS[0]["tools"]}
    assert len(FG.S["requests"]) == sent


# --- 2.2 OneDrive and SharePoint: read ---------------------------------------------------------------------------------
def test_list_search_read_and_save_across_pages_and_a_throttle(client, work):
    _sign_in(client)
    _on(client, "files_read")
    FG.S["throttle"] = {"/me/drive/root/children"}
    listing = client.get("/api/work/files").json()
    assert FG.S["throttled"] == [f"/graph/v1.0/me/drive/root/children"]  # one 429, waited out, then answered
    names = [i["name"] for i in listing["items"]]
    assert names == ["Q3 plan.txt", "Budget.csv", "Old notes.txt", "Forecast.xlsx", "Reports", "Brief.docx"]  # three pages
    assert listing["items"][4]["folder"] and listing["items"][0]["file"] == "drv-me/f1"
    assert listing["items"][0]["where"] == "OneDrive"
    sites = client.get("/api/work/sites").json()["sites"]
    assert sites == [{"id": "contoso.sharepoint.com,site-1,web-1", "name": "Sales"}]
    lib = client.get("/api/work/files", params={"site": sites[0]["id"]}).json()["items"]
    assert [i["name"] for i in lib] == ["Price list.txt"] and lib[0]["where"] == "Sales"
    shared = client.get("/api/work/files", params={"shared": "true"}).json()["items"]
    assert [i["name"] for i in shared] == ["Price list.txt"]
    sub = client.get("/api/work/files", params={"folder": "drv-me/fold"}).json()["items"]
    assert sub == []
    read = client.get("/api/work/files/read", params={"file": "drv-me/f1", "query": "budget"}).json()
    assert any(p.startswith("[Q3 plan.txt, ") and "42,000" in p for p in read["passages"]), read["passages"]
    assert read["cite_as"] and read["from"] == "OneDrive"
    assert not FG.S.get("leaked_auth")  # the download address never got the token
    saved = client.post("/api/work/files/save", json={"file": "drv-me/f1"}).json()
    assert saved["name"] == "Q3 plan.txt" and saved["source"] == "onedrive" and saved["remote"] == "drv-me/f1"
    files = client.get("/api/files").json()
    assert any(f["id"] == saved["id"] and f["source"] == "onedrive" for f in files)
    opened = client.get("/api/work/files/open", params={"file": "drv-me/f1"}).json()
    assert opened["address"] == FG.S["drives"]["drv-me"]["f1"]["webUrl"]
    # Nothing above was a write
    assert FG.S["writes"] == []


def test_the_assistant_reads_work_files_as_untrusted_content(client, work):
    _sign_in(client)
    _on(client, "files_read")
    ev = _chat(client, tool_call("work_search", {"query": "budget"}), final="Found them.")
    from conftest import CALLS

    tool_msgs = [m for m in CALLS[-1]["messages"] if m["role"] == "tool"]
    assert tool_msgs[-1]["content"].startswith("[Untrusted content from work_search.")
    assert "Q3 plan.txt" in tool_msgs[-1]["content"]
    assert any(e.get("type") == "message" for e in ev)


# --- 2.2 and 2.4: every write waits for a yes, runs once after it, exactly as asked ------------------------------------
def _library_file(name: str, data: bytes) -> int:
    from app import analysis

    return analysis.add(name, data=data)["id"]


WRITES = [
    ("work_file_upload", lambda: {"file_id": _library_file("report.txt", b"hello"), "folder": "drv-me/fold"},
     "Upload to OneDrive: report.txt",
     lambda w: w == [{"kind": "upload", "drive": "drv-me", "parent": "fold", "name": "report.txt", "size": 5, "conflict": "rename"}]),
    ("work_file_upload", lambda: {"file_id": _library_file("big.bin", os.urandom(5 * 1024 * 1024 + 7)), "replace": True},
     "Upload to OneDrive: big.bin",
     lambda w: len(w) == 1 and w[0]["kind"] == "upload" and w[0]["size"] == 5 * 1024 * 1024 + 7 and len(w[0]["chunks"]) == 2
     and w[0]["conflict"] == "replace" and w[0]["parent"] == "root"),
    ("work_file_share", lambda: {"file": "drv-me/f2", "people": "lee@contoso.com", "access": "edit"},
     "Share Budget.csv with lee@contoso.com (can edit)",
     lambda w: w == [{"kind": "invite", "drive": "drv-me", "item": "f2", "people": ["lee@contoso.com"], "roles": ["write"],
                      "signin": True, "notify": True}]),
    ("work_file_share", lambda: {"file": "drv-me/f1", "access": "view"},
     "Share Q3 plan.txt: a link people in your company can view",
     lambda w: w == [{"kind": "link", "drive": "drv-me", "item": "f1", "type": "view", "scope": "organization"}]),
    ("work_file_edit", lambda: {"file": "drv-me/f4", "changes": [{"sheet": "Sheet1", "range": "B2:C2", "values": [[5, "ok"]]}]},
     "Change Forecast.xlsx",
     lambda w: w == [{"kind": "cells", "drive": "drv-me", "item": "f4", "sheet": "Sheet1", "range": "B2:C2", "values": [[5, "ok"]]}]),
    ("work_file_edit", lambda: {"file": "drv-me/f5", "changes": {"text": "# Brief\n\nThe new plan."}},
     "Change Brief.docx",
     lambda w: len(w) == 1 and w[0]["kind"] == "new_version" and w[0]["item"] == "f5" and w[0]["size"] > 1000),
    ("work_chat_post", lambda: {"chat": "chat:19:chat-lee@unq.gbl.spaces", "text": "Sending it <now> & then"},
     "Post in Teams: Lee Park",
     lambda w: w == [{"kind": "chat_post", "chat": "19:chat-lee@unq.gbl.spaces",
                      "body": {"contentType": "text", "content": "Sending it <now> & then"}}]),
    ("work_chat_post", lambda: {"chat": "channel:team-1/19:general@thread.tacv2", "text": "Thanks!", "reply_to": "c1"},
     "Post in Teams: Sales team, General",
     lambda w: w == [{"kind": "channel_reply", "team": "team-1", "channel": "19:general@thread.tacv2", "reply_to": "c1",
                      "body": {"contentType": "text", "content": "Thanks!"}}]),
]


@pytest.mark.parametrize("tool,make,title,check", WRITES, ids=[f"{w[0]}-{i}" for i, w in enumerate(WRITES)])
def test_every_write_waits_for_a_yes_and_runs_once_exactly_as_asked(client, work, tool, make, title, check):
    _sign_in(client)
    _on(client, "files_read", "files_change", "chats_read", "chats_post")
    client.get("/api/work/files")
    client.get("/api/work/chats", params={"kind": "all"})
    args = make()
    _chat(client, tool_call(tool, args))
    held = _held(tool)
    assert json.loads(held["args"]) == args and held["effect"] == "external"
    assert FG.S["writes"] == []  # nothing reached Microsoft yet
    item = next(i for i in client.get("/api/needs-you").json() if i["id"] == f"a:{held['id']}")
    assert item["title"] == title
    r = client.post(f"/api/needs-you/a:{held['id']}/approve")
    assert r.status_code == 200 and r.json()["status"] == "done", r.text
    assert check(FG.S["writes"]), FG.S["writes"]
    # answered once: a second yes is refused and runs nothing
    assert client.post(f"/api/needs-you/a:{held['id']}/approve").status_code == 409
    assert check(FG.S["writes"])


def test_a_no_sends_nothing(client, work):
    _sign_in(client)
    _on(client, "chats_read", "chats_post")
    _chat(client, tool_call("work_chat_post", {"chat": "chat:19:chat-lee@unq.gbl.spaces", "text": "hi"}))
    held = _held("work_chat_post")
    assert client.post(f"/api/needs-you/a:{held['id']}/deny").json()["status"] == "denied"
    assert FG.S["writes"] == []


def test_a_background_job_cannot_approve_its_own_write(client, work, monkeypatch):
    """A schedule's run asks to post; the bridge key the helpers and coding jobs share, the coding job's own key, and a
    second identical request never approve it or send anything. Only the person's yes does."""
    import asyncio

    from app import actions, assistant, config, db, security

    monkeypatch.setattr(config, "BROWSER_API_KEY", BRIDGE)
    monkeypatch.setattr(config, "CODING_BRIDGE_KEY", CODING)
    monkeypatch.setattr(security, "_attempts", {})
    _sign_in(client)
    _on(client, "chats_read", "chats_post")
    sid = 77  # one schedule's runs share its id (the duplicate check looks across them)
    args = {"chat": "chat:19:sales-group@thread.v2", "text": "Daily numbers please"}

    def scheduled_run():
        cid = assistant.new_conversation("schedule", external_id=str(sid))
        SCRIPT[:] = [tool_call("work_chat_post", args), {"role": "assistant", "content": "Asked."}]
        asyncio.run(assistant.ask(assistant.Ctx(channel="schedule", conversation_id=cid), "post the daily nudge"))

    scheduled_run()
    held = _held("work_chat_post")
    scheduled_run()  # the next day's run: the same request is not asked twice
    assert len([a for a in actions.pending() if a["tool"] == "work_chat_post"]) == 1
    anon = _anon(client)
    for key in (BRIDGE, CODING):
        for path in (f"/api/needs-you/a:{held['id']}/approve", f"/api/approvals/{held['id']}"):
            r = anon.post(path, json={"approve": True}, headers={"Authorization": f"Bearer {key}", "X-Workbench-Channel": "rooks-code", **W})
            assert r.status_code in (401, 403), (key[:1], path, r.status_code)
        r = anon.post(f"/v1/rooks/approvals/{held['id']}", json={"approve": True}, headers={"Authorization": f"Bearer {key}", **W})
        assert r.status_code in (401, 403, 404)
        r = anon.post("/api/work/hold", json={"tool": "work_chat_post", "args": args},
                      headers={"Authorization": f"Bearer {key}", "X-Workbench-Channel": "rooks-code", **W})
        assert r.status_code == 401
    assert FG.S["writes"] == [] and actions.approval(held["id"])["status"] == "pending"
    # The person says yes: it runs once
    assert client.post(f"/api/needs-you/a:{held['id']}/approve").json()["status"] == "done"
    assert [w["kind"] for w in FG.S["writes"]] == ["chat_post"]


def test_a_teams_message_asking_for_a_share_makes_the_share_wait_as_untrusted(client, work):
    from app import assistant

    _sign_in(client)
    _on(client, "files_read", "files_change", "chats_read")
    _chat(client, tool_call("work_chat_read", {"chat": "chat:19:chat-lee@unq.gbl.spaces"}),
          tool_call("work_file_share", {"file": "drv-me/f2", "people": "x@evil.example", "access": "edit"}, call_id="c2"))
    held = _held("work_file_share")
    assert held["reason"] == assistant.HOLD_REASON
    assert FG.S["writes"] == []


# --- 2.2 meeting transcripts -------------------------------------------------------------------------------------------
def test_a_teams_transcript_becomes_a_meeting_with_speakers(client, work):
    from app import db, meetings

    _sign_in(client)
    _on(client, "calendar", "transcripts")
    cal = db.one("SELECT c.id FROM calendars c JOIN linked_accounts l ON l.id = c.linked_account_id WHERE l.work = 1")
    eid = db.run("INSERT INTO events(calendar_id, uid, title, start, end) VALUES (?, 'ev1|2026-11-05T10:00:00Z', 'Launch review', "
                 "'2026-11-05T10:00:00Z', '2026-11-05T11:00:00Z')", cal["id"])
    no_link = db.run("INSERT INTO events(calendar_id, uid, title, start, end) VALUES (?, 'ev2|2026-11-06T12:00:00Z', 'Lunch', "
                     "'2026-11-06T12:00:00Z', '2026-11-06T13:00:00Z')", cal["id"])
    out = client.post("/api/work/transcript", json={"event": eid}).json()
    m = db.one("SELECT * FROM meetings WHERE id = ?", out["meeting_id"])
    segs = json.loads(m["segments"])
    assert m["title"] == "Launch review" and m["source"] == "teams" and m["status"] == "ready"
    assert [s["speaker"] for s in segs] == ["Ana Lima", "Lee Park"] and "launch post by Friday" in m["transcript"]
    r = client.post("/api/work/transcript", json={"event": no_link})
    assert r.status_code == 404 and r.json()["detail"] == "This meeting was not held in Teams."
    FG.S["transcripts"] = False
    r = client.post("/api/work/transcript", json={"event": eid})
    assert r.status_code == 404 and r.json()["detail"] == "This meeting has no transcript."
    meetings.ensure()
    assert FG.S["writes"] == []
    # the meetings list offers it on meetings held in Teams
    offered = client.get("/api/work/meetings").json()["meetings"]
    assert [x["title"] for x in offered if x["teams"]] == ["Launch review"]


# --- 2.2 Planner and To Do ---------------------------------------------------------------------------------------------
def test_planner_and_to_do_tasks_join_the_one_list_and_changes_wait(client, work):
    from app import db

    _sign_in(client)
    _on(client, "tasks")
    out = client.post("/api/work/tasks/sync").json()
    assert out["planner"] == 1 and out["todo"] == 1
    rows = {t["title"]: t for t in client.get("/api/tasks").json()}
    assert rows["Draft the launch post"]["origin"] == "planner" and rows["Draft the launch post"]["due"] == "2026-11-20"
    assert rows["Call the printer"]["origin"] == "todo" and rows["Call the printer"]["status"] == "todo"
    client.post("/api/work/tasks/sync")  # a second sync updates, never duplicates
    assert len([t for t in client.get("/api/tasks").json() if t["origin"]]) == 2
    pid = rows["Draft the launch post"]["id"]
    _chat(client, tool_call("work_task_update", {"task": pid, "done": True}))
    held = _held("work_task_update")
    assert FG.S["writes"] == []
    assert next(i for i in client.get("/api/needs-you").json() if i["id"] == f"a:{held['id']}")["title"] == \
        "Change a task in Planner: Draft the launch post"
    assert client.post(f"/api/needs-you/a:{held['id']}/approve").json()["status"] == "done"
    assert FG.S["writes"] == [{"kind": "planner", "task": "p1", "percentComplete": 100}]
    assert db.one("SELECT status FROM tasks WHERE id = ?", pid)["status"] == "done"
    tid = rows["Call the printer"]["id"]
    _chat(client, tool_call("work_task_update", {"task": tid, "due": "2026-11-30", "title": "Call the printer again"}))
    held = _held("work_task_update")
    client.post(f"/api/needs-you/a:{held['id']}/approve")
    assert FG.S["writes"][-1] == {"kind": "todo", "list": "list-1", "task": "t1", "title": "Call the printer again",
                                  "dueDateTime": {"dateTime": "2026-11-30T00:00:00", "timeZone": "UTC"}}
    _chat(client, tool_call("work_task_update", {"title": "Book the venue", "due": "2026-12-01"}))
    held = _held("work_task_update")
    client.post(f"/api/needs-you/a:{held['id']}/approve")
    assert FG.S["writes"][-1]["kind"] == "todo_add" and FG.S["writes"][-1]["title"] == "Book the venue"
    assert any(t["title"] == "Book the venue" and t["origin"] == "todo" for t in client.get("/api/tasks").json())


# --- the terminal reaches these with its own sign in, never the shared key ---------------------------------------------
def test_the_terminal_uses_its_own_sign_in_never_the_bridge_key(client, work, monkeypatch):
    from app import actions, config, db, security

    monkeypatch.setattr(config, "BROWSER_API_KEY", BRIDGE)
    monkeypatch.setattr(security, "_attempts", {})
    db.set_setting("cli_token_hash", hashlib.sha256(TERMINAL.encode()).hexdigest())
    try:
        _sign_in(client)
        _on(client, "chats_read", "chats_post")
        anon = _anon(client)
        term = {"Authorization": f"Bearer {TERMINAL}", "X-Workbench-Channel": "rooks-code", **W}
        bridge = {"Authorization": f"Bearer {BRIDGE}", "X-Workbench-Channel": "rooks-code", **W}
        assert anon.get("/api/work/status", headers=bridge).status_code == 401
        st = anon.get("/api/work/status", headers=term).json()
        assert st["account"]["email"] == "ana@contoso.com"
        chats = anon.get("/api/work/chats", params={"kind": "all"}, headers=term).json()["chats"]
        assert {c["name"] for c in chats} == {"Lee Park", "Sales leads", "Sales team, General"}
        r = anon.post("/api/work/hold", json={"tool": "work_chat_post", "args": {"chat": chats[0]["chat"], "text": "hello"}}, headers=term)
        assert r.status_code == 200 and r.json()["held"] and r.json()["title"].startswith("Post in Teams:")
        assert FG.S["writes"] == []
        # only writes can be put in Needs you this way, and only the work tools
        assert anon.post("/api/work/hold", json={"tool": "remember", "args": {"content": "x"}}, headers=term).status_code == 400
        aid = int(r.json()["id"].split(":")[1])
        assert anon.post(f"/api/needs-you/a:{aid}/approve", headers=term).json()["status"] == "done"
        assert [w["kind"] for w in FG.S["writes"]] == ["chat_post"]
        assert actions.approval(aid)["status"] == "done"
    finally:
        db.set_setting("cli_token_hash", "")


# --- secrets, upgrades -------------------------------------------------------------------------------------------------
def test_tokens_never_reach_logs_the_run_log_or_the_outbound_record(client, work, caplog):
    from app import db

    caplog.set_level(logging.DEBUG)
    _sign_in(client)
    _on(client, "files_read", "chats_read")
    client.get("/api/work/files")
    client.get("/api/work/files/read", params={"file": "drv-me/f1"})
    client.get("/api/work/chats", params={"kind": "chats"})
    tokens = list(FG.S["tokens"]) + ["w-rt"]
    rows = db.all("SELECT args, detail, evidence, failure_reason FROM actions")
    text = json.dumps(rows) + caplog.text + json.dumps(db.all("SELECT * FROM linked_accounts"))
    for t in tokens:
        assert t not in text
    assert db.one("SELECT COUNT(*) AS n FROM actions WHERE kind = 'egress' AND provider = '127.0.0.1'")["n"] > 0


def test_old_accounts_keep_mail_and_calendar_after_the_upgrade(tmp_path):
    from app import db

    path = tmp_path / "old.db"
    c = sqlite3.connect(path)
    c.row_factory = sqlite3.Row
    db.migrate(c, path)
    for col in ("work", "tenant", "subject", "features"):
        c.execute(f"ALTER TABLE linked_accounts DROP COLUMN {col}")
    c.execute("PRAGMA user_version = 5")
    c.execute("INSERT INTO linked_accounts(provider, email, scopes, created_at, updated_at) VALUES ('microsoft', 'old@contoso.com', "
              "'Mail.ReadWrite Calendars.ReadWrite', 'x', 'x')")
    c.commit()
    db.migrate(c, path)
    row = c.execute("SELECT work, features FROM linked_accounts").fetchone()
    assert row["work"] == 0 and set(json.loads(row["features"])["on"]) == {"mail", "calendar"}
    assert c.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION == 6
    c.close()


def test_a_turn_run_with_the_shared_key_is_offered_no_work_tools(client, work, monkeypatch):
    """The terminal's chat turns (/v1/rooks/run_turn) accept the shared bridge key too, which coding jobs and the
    helpers hold. Through it the work account is out of reach: its tools are offered only to a turn the person's own
    Terminal access token started (or the app itself)."""
    from conftest import CALLS

    from app import config, db, security

    monkeypatch.setattr(config, "BROWSER_API_KEY", BRIDGE)
    monkeypatch.setattr(security, "_attempts", {})
    db.set_setting("cli_token_hash", hashlib.sha256(TERMINAL.encode()).hexdigest())
    try:
        _sign_in(client)
        _on(client, "files_read")
        anon = _anon(client)
        for key, offered in ((BRIDGE, False), (TERMINAL, True)):
            h = {"Authorization": f"Bearer {key}", **W}
            cid = anon.post("/v1/rooks/conversation", json={"session": f"s-{key[:1]}", "model": ""}, headers=h).json()["conversation_id"]
            SCRIPT[:] = [tool_call("work_search", {"query": "budget"}), {"role": "assistant", "content": "done"}]
            CALLS.clear()
            sent = len(FG.S["requests"])
            events(anon.post("/v1/rooks/run_turn", json={"conversation_id": cid, "prompt": "find the budget"}, headers=h))
            names = {t["function"]["name"] for t in CALLS[0]["tools"]}
            assert ("work_search" in names) is offered, key[:1]
            assert (len(FG.S["requests"]) > sent) is offered, key[:1]
    finally:
        db.set_setting("cli_token_hash", "")


def test_a_team_leads_sub_agents_are_offered_no_work_tools(client, work):
    """Sub-agents are background jobs a turn can start (team_dispatch); the work account stays with the person's turn."""
    from app import assistant

    _sign_in(client)
    _on(client, "files_read")
    cid = assistant.new_conversation("web")
    assert "work_search" in {t.name for t in assistant.available_tools(assistant.Ctx(channel="web", conversation_id=cid))}
    assert not {t.name for t in assistant.available_tools(assistant.Ctx(channel="subagent", conversation_id=cid))
                if t.name.startswith("work_")}


def test_disconnecting_the_work_account_takes_its_tasks_and_names_out_of_rooks(client, work):
    """Nothing is deleted at Microsoft; Rooks just stops showing what it can no longer reach."""
    from app import db, work_suite

    _sign_in(client)
    _on(client, "tasks", "chats_read")
    client.post("/api/work/tasks/sync")
    client.get("/api/work/chats")
    assert [t for t in client.get("/api/tasks").json() if t["origin"]] and work_suite.name_of("chat:19:chat-lee@unq.gbl.spaces")
    mine = client.post("/api/tasks", json={"title": "Kept only in Rooks"}).json()
    assert client.delete("/api/work/account").status_code == 200
    left = client.get("/api/tasks").json()
    assert not [t for t in left if t["origin"]] and any(t["id"] == mine["id"] for t in left)
    assert work_suite.name_of("chat:19:chat-lee@unq.gbl.spaces") == ""
    assert FG.S["writes"] == []
    db.run("DELETE FROM tasks WHERE id = ?", mine["id"])
