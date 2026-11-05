"""The main assistant: standing instructions, result cards, and a note when background work finishes."""

from conftest import SCRIPT, events, tool_call


def test_a_clear_standing_instruction_is_saved_in_plain_words(client):
    ev = events(client.post("/api/assistant/chat", json={"message": "Every weekday morning, summarise my inbox"}))
    msg = next(e for e in ev if e["type"] == "message")["content"]
    assert "weekday" in msg.lower() and "0 7" not in msg and "cron" not in msg.lower()
    card = next(e for e in ev if e["type"] == "card")
    assert card["kind"] == "routine" and card["routine_kind"] == "schedule"
    rows = client.get("/api/assistant/routines").json()["routines"]
    assert any(r["kind"] == "schedule" and "weekday" in r["sentence"].lower() for r in rows)
    paused = client.post("/api/assistant/routines/pause", json={"kind": "schedule", "id": card["id"], "enabled": False}).json()
    assert paused["enabled"] is False


def test_a_when_rule_is_an_automation_and_a_chat_is_not(client):
    ev = events(client.post("/api/assistant/chat", json={"message": "When an invoice email arrives, save the PDF"}))
    card = next(e for e in ev if e["type"] == "card")
    assert card["routine_kind"] == "automation"
    assert "email" in card["sentence"].lower()
    SCRIPT[:] = [{"role": "assistant", "content": "Hello."}]
    ev2 = events(client.post("/api/assistant/chat", json={"message": "What's on today?"}))
    assert not [e for e in ev2 if e["type"] == "card" and e.get("kind") == "routine"]
    assert next(e for e in ev2 if e["type"] == "message")["content"] == "Hello."


def test_tool_results_become_cards_on_the_reply(client):
    SCRIPT[:] = [
        tool_call("create_task", {"title": "Call the clinic", "due": "2026-11-06"}),
        {"role": "assistant", "content": "Added to your list."},
    ]
    ev = events(client.post("/api/assistant/chat", json={"message": "Remind me to call the clinic tomorrow"}))
    card = next(e for e in ev if e["type"] == "card")
    assert card["kind"] == "task" and card["title"] == "Call the clinic"
    cid = next(e for e in ev if e["type"] == "start")["conversation_id"]
    msgs = client.get(f"/api/conversations/{cid}").json()["messages"]
    reply = next(m for m in msgs if m["content"] == "Added to your list.")
    assert reply["cards"][0]["kind"] == "task"


def test_a_finished_schedule_and_a_needed_yes_land_in_the_main_chat(client):
    from app import jobs, scheduler

    scheduler.deliver("Morning note", "Two meetings today.", "inbox", "schedule:9")
    cid = client.get("/api/assistant/main").json()["id"]
    again = client.get("/api/assistant/main").json()["id"]
    assert again == cid
    jobs.notice(0, "needs_you", "OK to run the morning check?", "An automation wants to start.")
    msgs = client.get(f"/api/conversations/{cid}").json()["messages"]
    text = "\n".join(m["content"] for m in msgs if m["role"] == "assistant")
    assert "Morning note" in text and "OK to run the morning check?" in text
    assert client.get("/api/inbox").json()["unread"] >= 1


def test_draft_card_says_it_is_not_sent():
    from app.front_door import card_from

    card = card_from("save_email_draft", {"draft_id": 4, "status": "saved, not sent"}, {"to": "a@b.c", "subject": "Hi", "body": "Hello"})
    assert card["kind"] == "draft" and "Not sent" in card["status"] and card["to"] == "a@b.c"
    watch = card_from("use_computer", {"job_id": "job-1", "status": "still running"}, {"goal": "Open the calendar"})
    assert watch["kind"] == "watch" and watch["surface"] == "computer" and watch["job_id"] == "job-1"
