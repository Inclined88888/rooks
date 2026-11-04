"""A connected chat can draft mail, leave a morning note, or queue a browse. It does not click or send."""


def test_browse_waits_and_mail_is_only_a_draft(client, monkeypatch):
    from app import db, telegram

    sent = []
    monkeypatch.setattr(telegram, "send", lambda *a, **k: sent.append("sent"))
    try:
        reply = telegram.suite_command("browse the vendor page")
        assert reply and "wait" in reply.lower() and "Nothing is sent" in reply
        row = __import__("json").loads(db.get_setting("pending_browse") or "")
        assert row["status"] == "waiting" and row["clicks"] is False and row["sends"] is False
        assert "vendor" in row["goal"] and row["id"]
        listed = client.get("/api/browser/jobs").json()
        assert any(j["id"] == row["id"] and j["status"] == "waiting" for j in listed)
        opened = client.get(f"/api/browser/jobs/{row['id']}").json()
        assert opened["steps"] == [] and opened["sends"] is False

        mail = telegram.suite_command("draft mail to boss@example.com: Please review the price.")
        assert mail and "Nothing was sent" in mail
        assert db.one("SELECT to_addr FROM mail_drafts WHERE to_addr = ?", "boss@example.com")

        morning = telegram.suite_command("every morning: Summarise overnight mail")
        assert morning and "morning" in morning.lower()
        assert db.one("SELECT cron FROM schedules WHERE name = 'Morning'")["cron"] == "0 8 * * *"
        assert sent == []
        assert telegram.suite_command("what is the weather") is None
    finally:
        db.set_setting("pending_browse", "")
        db.run("DELETE FROM mail_drafts WHERE to_addr = ?", "boss@example.com")
        db.run("DELETE FROM schedules WHERE name = 'Morning'")
