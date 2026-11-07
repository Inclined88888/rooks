"""GET /api/pulse (design 0003, section 6, principle 4: one poller per kind of data): the presence strip, the Needs you
count, the job notices and the revisions the open pages refresh on, in one cheap answer. The app asks this one route
instead of /api/presence, /api/jobs/notices, /api/approvals and /api/conversations on their own timers."""

from starlette.testclient import TestClient


def _pulse(client, **params) -> dict:
    r = client.get("/api/pulse", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def test_pulse_carries_presence_needs_you_and_revisions(client):
    p = _pulse(client)
    assert {"presence", "needs_you", "notices", "notices_after", "revs"} <= set(p)
    assert {"name", "mood", "doing", "watching", "needs_you", "running"} <= set(p["presence"])
    assert p["needs_you"] == p["presence"]["needs_you"]
    assert {"chats", "held"} <= set(p["revs"])


def test_first_look_gives_the_cursor_and_no_old_notices(client):
    from app import jobs

    jobs.ensure()
    jobs.notice(0, "finished", "An old job finished")
    first = _pulse(client)  # no `after`: only learn where the notices are
    assert first["notices"] == []
    assert first["notices_after"] >= 1

    nid = jobs.notice(0, "needs_you", "A job needs your OK", "Send the invoice")
    nxt = _pulse(client, after=first["notices_after"])
    assert [n["id"] for n in nxt["notices"]] == [nid]
    assert nxt["notices"][0]["title"] == "A job needs your OK"
    assert nxt["notices_after"] == nid
    # asked again from the new cursor: nothing new, the cursor stays
    again = _pulse(client, after=nxt["notices_after"])
    assert again["notices"] == [] and again["notices_after"] == nid


def test_chats_revision_moves_when_a_message_lands(client):
    from app import db

    before = _pulse(client)["revs"]["chats"]
    cid = db.run("INSERT INTO conversations(title, created_at, updated_at) VALUES ('Pulse', ?, ?)", db.now(), db.now())
    db.run("INSERT INTO messages(conversation_id, role, content, created_at) VALUES (?, 'assistant', 'from the terminal', ?)", cid, db.now())
    after = _pulse(client)["revs"]["chats"]
    assert after != before


def test_pulse_needs_sign_in(client):
    anon = TestClient(client.app)
    assert anon.get("/api/pulse").status_code == 401
