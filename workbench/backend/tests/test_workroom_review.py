"""Review fixes for the Workroom branch (design 0003): plain words on screens, honest claims, and the window kept
cheap. Each test failed on the code before its fix."""

import asyncio
import json
import threading

import pytest
from fastapi import HTTPException

from conftest import SCRIPT, events, tool_call


def test_an_odd_digit_in_a_needs_you_id_is_not_found_not_a_crash(client):
    for item in ("a:%C2%B2", "j:%C2%B2"):
        r = client.post(f"/api/needs-you/{item}/approve")
        assert r.status_code == 404 and r.json()["detail"] == "Nothing is waiting under that name."


def test_anthropics_window_overflow_is_a_prompt_too_long():
    from app import adapters, router
    from app.adapters import ProviderError

    body = ("input length and `max_tokens` exceed context limit: 191384 + 20000 > 200000, decrease input length or "
            "`max_tokens` and try again")
    assert adapters.too_long(body)
    err = ProviderError(502, f"X error 400: {body}", upstream=400, body=body)
    assert router.classify(err) == (router.PROMPT_TOO_LONG, 0, False)


def _human(cid: int, text: str) -> None:
    from app import assistant

    assistant._save(cid, "user", text)


def test_an_earlier_approved_send_does_not_back_a_new_send_to_someone_else(client):
    from app import assistant, receipts

    cid = assistant.new_conversation("web")
    _human(cid, "email sam the quote")
    assistant._save(cid, "user", '[I approved request #7: send_email. Result: {"sent": true, "to": "sam@example.com", '
                                 '"subject": "Quote"}]')
    assistant._save(cid, "assistant", "Sent to Sam.")
    _human(cid, "now email Bob the same quote")
    sentence, why = receipts.unbacked_claim("I sent the quote to Bob.", [], conversation_id=cid)
    assert sentence and why == receipts.NO_SEND
    sentence, why = receipts.unbacked_claim("I sent the invoice to ana@example.com.", [], conversation_id=cid)
    assert sentence and why == receipts.NO_SEND
    # the send that was approved still backs the sentence about it
    assert receipts.unbacked_claim("Yes, I sent the email to Sam.", [], conversation_id=cid) == ("", "")
    assert receipts.unbacked_claim("I sent it to sam@example.com.", [], conversation_id=cid) == ("", "")


def test_the_summary_is_awaited_at_most_once_in_a_turn(client, monkeypatch):
    """A long chat over budget: a summariser that fails is not asked again before every step of the turn."""
    from app import assistant, compression, db, llm

    cid = assistant.new_conversation("web", "long")
    for i in range(30):
        assistant._save(cid, "user", f"question {i}")
        assistant._save(cid, "assistant", "", [{"id": f"t{i}", "type": "function", "function": {"name": "list_tasks", "arguments": "{}"}}])
        assistant._save(cid, "tool", f"result {i} " + "r" * 6000, tool_call_id=f"t{i}", name="list_tasks")
        assistant._save(cid, "assistant", f"answer {i}")
    monkeypatch.setattr(llm, "context_chars", lambda ref: 60_000)
    calls: list[int] = []

    async def failing_summary(conversation_id, model, first_kept_id, minimum=compression.SUMMARY_MIN_NEW):
        calls.append(first_kept_id)
        return False

    monkeypatch.setattr(compression, "refresh_history_summary", failing_summary)
    db.set_setting("compress_history", "1")
    try:
        SCRIPT[:] = [tool_call("list_tasks", {}, f"s{n}") for n in range(4)] + [{"role": "assistant", "content": "done"}]
        ev = events(client.post("/api/assistant/chat", json={"conversation_id": cid, "message": "check five times"}))
        assert next(e for e in ev if e["type"] == "message")["content"] == "done"
        assert len(calls) <= 2, calls  # one awaited, at most one in the background; not one per step
    finally:
        db.set_setting("compress_history", "0")
        SCRIPT.clear()


def test_a_restart_after_a_step_ran_says_it_may_have_run(client):
    from app import actions, assistant, db, restart

    cid = assistant.new_conversation("web")
    assistant._save(cid, "user", "email sam and list my tasks")
    turn = actions.add("turn", "running", trace={"channel": "web", "conversation_id": cid}, model="x")
    assistant._save(cid, "assistant", "", [
        {"id": "m1", "type": "function", "function": {"name": "send_email", "arguments": "{}"}},
        {"id": "m2", "type": "function", "function": {"name": "list_tasks", "arguments": "{}"}}])
    # the send ran and is in the run log; the restart came before its answer was saved in the chat
    actions.add("tool_call", "ok", trace={"channel": "web", "conversation_id": cid, "parent": turn}, tool="send_email",
                effect="external", args="{}")
    done = [d for d in restart.interrupt_running_turns() if d["conversation_id"] == cid][0]
    assert done["cut"] == ["list_tasks"] and done["maybe_ran"] == ["send_email"]
    note = db.one("SELECT content FROM messages WHERE id = ?", done["message_id"])["content"]
    assert "may have run" in note and "send email" in note
    not_run = note.split("not run:")[1] if "not run:" in note else ""
    assert "list tasks" in not_run and "send email" not in not_run


def test_presence_says_what_happens_in_the_room_and_never_quiet_while_working(client, monkeypatch):
    from app import presence

    assert presence.plain_step("use_room", {"action": "run", "command": "pip install x"}) == "Running in the Room: pip install x"
    assert presence.plain_step("use_room", {"action": "up", "goal": "Try it"}) == "Starting the Room: Try it"
    assert presence.plain_step("use_room", {"action": "reset", "name": "p1"}) == "Starting the Room over from p1"
    assert presence.plain_step("use_room", {"action": "zzz"}) == "Using the Room"

    from test_presence import GATE, _hang, _run_in_thread, _settle, _wait

    from app import assistant

    _settle(client)
    tool = assistant.TOOL_MAP["load_skill"]
    monkeypatch.setattr(tool, "fn", _hang(tool.fn))
    SCRIPT[:] = [tool_call("load_skill", {"name": "x"}), {"role": "assistant", "content": "ok"}]
    GATE.set()
    t, _ = _run_in_thread(client, "load it")
    try:
        p = _wait(client, lambda p: p["doing_tool"] == "load_skill")
        assert p["mood"] == "working" and p["doing"] == "Working"
    finally:
        GATE.clear()
        t.join(timeout=10)
    SCRIPT.clear()


def test_presence_asks_the_room_off_the_event_loop(client, monkeypatch):
    from app import presence

    seen: list[bool] = []

    class FakeRoom:
        @staticmethod
        def running() -> bool:
            seen.append(threading.current_thread() is threading.main_thread())
            return True

    monkeypatch.setattr(presence, "_room", FakeRoom)
    out = asyncio.run(presence.build())
    assert "room" in out["watching"] and seen == [False]


def test_no_mailbox_is_said_without_the_old_product_name(client):
    from app import assistant, tools

    for call in (assistant._send_email("a@example.com", "s", "b", account_id=987654),
                 tools.search_email(account_id=987654)):
        with pytest.raises(HTTPException) as e:
            asyncio.run(call)
        assert "Workbench" not in e.value.detail and "Mail page" in e.value.detail
