"""Chats can be archived, and the skill store follows how the app is used."""

from __future__ import annotations


def test_a_chat_can_be_archived_and_deleted(client):
    from app import db

    cid = db.run(
        "INSERT INTO conversations (title, channel, created_at, updated_at) VALUES ('Old chat', 'web', ?, ?)",
        db.now(), db.now(),
    )
    listed = client.get("/api/conversations").json()
    assert any(c["id"] == cid for c in listed)
    client.patch(f"/api/conversations/{cid}", json={"archived": True})
    listed = client.get("/api/conversations").json()
    assert all(c["id"] != cid for c in listed)
    archived = client.get("/api/conversations?archived=1").json()
    assert any(c["id"] == cid for c in archived)
    client.patch(f"/api/conversations/{cid}", json={"archived": False})
    assert any(c["id"] == cid for c in client.get("/api/conversations").json())
    client.delete(f"/api/conversations/{cid}")
    assert all(c["id"] != cid for c in client.get("/api/conversations").json())


def test_work_mail_puts_admin_skills_first(client):
    from app import db

    aid = db.run(
        "INSERT INTO mail_accounts (name, email, imap_host, imap_port, smtp_host, smtp_port, username, password_enc, life_role) "
        "VALUES ('Work', 'a@work.example', 'mail.example', 993, 'mail.example', 465, 'a@work.example', '', 'work')"
    )
    try:
        _admin_skills_first(client)
    finally:  # the app is shared by every test: a mail account left here becomes everyone's first account
        db.run("DELETE FROM mail_accounts WHERE id = ?", aid)


def _admin_skills_first(client):
    body = client.get("/api/skills/store").json()
    names = [s["name"] for s in body["skills"] if s["for_you"]]
    assert "Admin day" in names
    assert "Inbox check" in names
    added = client.post("/api/skills/store/admin-day").json()
    assert added["created"] == "admin-day"
    again = client.get("/api/skills/store").json()
    row = next(s for s in again["skills"] if s["id"] == "admin-day")
    assert row["added"] is True
    mail = next(c for c in body["connectors"] if c["id"] == "mail")
    assert mail["on"] is True
