"""Reliability people feel (design 0003, W4 item 5, package B3).

A long chat compresses instead of dying on a context error, a restart is reported honestly in the thread and the next
turn says it resumed, a goal that opted in picks up after a restart, approvals are never duplicated, and a send that
really happened backs the sentence that says so."""

import asyncio
import json
import re

from conftest import CALLS, SCRIPT, events, tool_call


def _exchange(cid: int, i: int, tool: str, result: str) -> None:
    from app import assistant

    assistant._save(cid, "user", f"question {i}")
    assistant._save(cid, "assistant", "", [{"id": f"t{i}", "type": "function", "function": {"name": tool, "arguments": "{}"}}])
    assistant._save(cid, "tool", result, tool_call_id=f"t{i}", name=tool)
    assistant._save(cid, "assistant", f"answer {i}")


# --- 1. a context overflow is shrunk and retried, never fatal ---------------------------------------------------------
def test_a_context_overflow_is_shrunk_and_retried_not_fatal(client):
    from app import assistant, db, tool_results

    cid = assistant.new_conversation("web")
    for i in range(8):  # far more than the model below can take: eight 19,000 character tool results
        _exchange(cid, i, "list_tasks", f"result {i} " + "y" * 19_000)
    limit = 80_000
    sizes: list[int] = []

    def model(messages):
        n = len(json.dumps(messages))
        sizes.append(n)
        if n > limit:  # the provider's own words for a prompt that does not fit
            SCRIPT.insert(0, model)
            return {"_status": 400, "_code": "context_length_exceeded",
                    "_error": f"This model's maximum context length is 26000 tokens. However, your messages resulted in {n // 3} "
                              "tokens. Please reduce the length of the messages."}
        last = messages[-1]["content"] if isinstance(messages[-1]["content"], str) else ""
        return {"role": "assistant", "content": "fits now: " + ("saw the question" if "what did we find" in last else "lost the question")}

    SCRIPT[:] = [model]
    CALLS.clear()
    ev = events(client.post("/api/assistant/chat", json={"message": "what did we find?", "conversation_id": cid}))
    assert not [e for e in ev if e.get("type") == "error" or "error" in e], ev
    assert next(e for e in ev if e["type"] == "message")["content"] == "fits now: saw the question"
    compacted = [e for e in ev if e["type"] == "compacted"]
    assert compacted and all(e["dropped_rows"] > 0 and e["summary_words"] >= 0 for e in compacted)
    assert 1 <= len(compacted) <= 3
    assert sizes[0] > limit and sizes[-1] <= limit
    turn = db.one("SELECT outcome FROM actions WHERE kind = 'turn' AND conversation_id = ? ORDER BY id DESC LIMIT 1", cid)
    assert turn["outcome"] == "no_claim"
    # the oldest tool results were replaced by one line stubs, and the stubs still lead to the full result
    last = [c for c in CALLS if c.get("tools")][-1]  # the call that answered (learning calls after the turn carry no tools)
    stubs = [m for m in last["messages"] if m["role"] == "tool" and "read_tool_result" in m["content"]]
    assert stubs and all(len(m["content"]) < 400 for m in stubs)
    rid = re.search(r'result_id="(\w+)"', stubs[0]["content"]).group(1)
    assert tool_results.read(cid, rid)["text"].startswith("result 0 ")
    newest = [m for m in last["messages"] if m["role"] == "tool"][-1]
    assert newest["content"].startswith("result 7 ")  # the newest result is never stubbed
    # the record itself is untouched: the thread still has every result in full
    rows = db.all("SELECT content FROM messages WHERE conversation_id = ? AND role = 'tool'", cid)
    assert all(len(r["content"]) > 19_000 for r in rows)
    SCRIPT.clear()


def test_a_prompt_that_never_fits_ends_with_a_plain_message(client):
    from app import assistant, db

    cid = assistant.new_conversation("web")
    calls = {"n": 0}

    def always_too_long(messages):
        calls["n"] += 1
        SCRIPT.insert(0, always_too_long)
        return {"_status": 400, "_error": "prompt is too long: 213462 tokens > 200000 maximum"}

    SCRIPT[:] = [always_too_long]
    ev = events(client.post("/api/assistant/chat", json={"message": "x" * 50_000, "conversation_id": cid}))
    err = next(e for e in ev if e.get("type") == "error")
    assert err["error"] == "This chat got too long for the model. Start a new chat or pick a model with more room."
    # nothing could be left out (one huge message), so nothing was compacted and the model was not asked again
    assert [e for e in ev if e["type"] == "compacted"] == [] and calls["n"] == 1
    turn = db.one("SELECT outcome, failure_reason FROM actions WHERE kind = 'turn' AND conversation_id = ? ORDER BY id DESC LIMIT 1", cid)
    assert turn["outcome"] == "model_error" and "too long" in turn["failure_reason"]
    SCRIPT.clear()


def test_context_length_errors_are_classified_as_prompt_too_long():
    from fastapi import HTTPException

    from app import router
    from app.adapters import ProviderError

    bodies = [
        '{"error": {"message": "This model\'s maximum context length is 8192 tokens.", "code": "context_length_exceeded"}}',
        "prompt is too long: 213462 tokens > 200000 maximum",
        "input too long for the model",
        "the request tokens exceed the model limit",
        "Context length exceeded",
        "maximum context length is 32768 tokens",
    ]
    for body in bodies:
        err = ProviderError(502, f"X error 400: {body}", upstream=400, body=body)
        assert router.classify(err) == (router.PROMPT_TOO_LONG, 0, False), body
    ollama = HTTPException(502, "The prompt filled the whole 16384 token window of qwen3:4b, so Ollama cut part of it. "
                                "Start a new conversation, or raise OLLAMA_NUM_CTX if you have the memory.")
    assert router.classify(ollama) == (router.PROMPT_TOO_LONG, 0, False)
    assert router.prompt_too_long(ollama) and not router.prompt_too_long(HTTPException(502, "upstream exploded"))
    # not confused with limits that pass with time, or with other refusals
    busy = ProviderError(502, "X error 429: Rate limit reached on tokens per minute (TPM)", upstream=429, body="Rate limit reached on tokens per minute (TPM)")
    assert router.classify(busy)[0] == "busy (rate limited)" and router.classify(busy)[2] is True
    other = ProviderError(502, "X error 400: invalid value for temperature", upstream=400, body="invalid value for temperature")
    assert router.classify(other)[0] != router.PROMPT_TOO_LONG and router.classify(other)[2] is True


# --- 2. tool aware compaction, awaited when the window is already over budget -----------------------------------------
def test_tool_rows_are_summarised_before_the_answer_when_the_window_is_over_budget(client, monkeypatch):
    from app import assistant, compression, db, llm

    cid = assistant.new_conversation("web", "tool heavy")
    names = ["list_tasks", "search_notes", "get_agenda"]
    for i in range(30):
        name = names[i % 3]
        body = ("Error: nothing found " if i % 5 == 0 else f"result {i} ") + "r" * 6000
        _exchange(cid, i, name, body)
    monkeypatch.setattr(llm, "context_chars", lambda ref: 60_000)  # a small model: the newest rows alone do not fit
    db.set_setting("compress_history", "1")
    seen: dict = {}

    def summariser(messages):
        text = messages[-1]["content"]
        seen["prompt"] = text
        found = [n for n in names if f"tool {n}:" in text]
        return {"role": "assistant", "content": "Earlier the assistant used " + ", ".join(found) + "; one look-up failed."}

    def answer(messages):
        seen["system"] = messages[0]["content"]
        return {"role": "assistant", "content": "hello"}

    try:
        SCRIPT[:] = [summariser, answer]
        CALLS.clear()
        r = client.post("/api/assistant/chat", json={"conversation_id": cid, "message": "hi"})
        assert r.status_code == 200, r.text
        assert next(e for e in events(r) if e["type"] == "message")["content"] == "hello"
        assert "You maintain a running summary" in seen["prompt"]
        assert "tool list_tasks: ok: result 3" in seen["prompt"] and "tool list_tasks: failed: Error: nothing found" in seen["prompt"]
        assert "tool search_notes: ok" in seen["prompt"] and "tool get_agenda: ok" in seen["prompt"]
        s = compression.history_summary(cid)["summary"]
        assert all(n in s for n in names)
        assert s in seen["system"]  # the same turn's answer was asked with the summary already in place
        # one line per tool row, cut at 80 characters of the result
        line = next(ln for ln in seen["prompt"].splitlines() if ln.startswith("tool search_notes: ok: result 1 "))
        assert len(line) <= len("tool search_notes: ok: ") + 80
    finally:
        db.set_setting("compress_history", "0")
        SCRIPT.clear()


# --- 3. a restart is reported in the thread; the next turn says it resumed; opted in goals continue ------------------
def _cut_off_turn(cid: int, tool: str = "list_tasks") -> int:
    """A turn cut off by a restart between a tool call and its answer: the row says running, the call has no answer."""
    from app import actions, assistant

    assistant._save(cid, "user", "list my tasks")
    turn = actions.add("turn", "running", trace={"channel": "web", "conversation_id": cid}, model="x")
    assistant._save(cid, "assistant", "", [{"id": f"cut{cid}", "type": "function", "function": {"name": tool, "arguments": "{}"}}])
    return turn


def test_a_restart_is_reported_in_the_thread_and_the_next_turn_says_resumed(client):
    from app import assistant, db, jobs, restart

    cid = assistant.new_conversation("web")
    turn = _cut_off_turn(cid)
    jobs.ensure()
    jid = db.run("INSERT INTO jobs(kind, title, prompt, status, created_at, updated_at) VALUES ('chat', 'Tidy', 'tidy', 'running', ?, ?)",
                 db.now(), db.now())
    done = restart.recover()
    assert [d["conversation_id"] for d in done["turns"]] == [cid] and done["turns"][0]["cut"] == ["list_tasks"]
    row = db.one("SELECT outcome, failure_reason FROM actions WHERE id = ?", turn)
    assert row["outcome"] == "interrupted" and "restarted" in row["failure_reason"] and "Workbench" not in row["failure_reason"]
    rows = client.get(f"/api/conversations/{cid}").json()["messages"]
    note = rows[-1]
    assert note["role"] == "system" and note["name"] == "restart"
    assert "restarted" in note["content"] and "list tasks" in note["content"] and "not run" in note["content"]
    # jobs keep their own rule (jobs.recover, run by the jobs loop at startup): paused, resumed by hand
    jobs.recover()
    assert jobs.get(jid)["status"] == "paused" and "Resume" in jobs.get(jid)["detail"]

    def model(msgs):
        texts = [m["content"] for m in msgs if isinstance(m.get("content"), str)]
        saw_cut = any(m["role"] == "tool" and m["content"] == assistant.INTERRUPTED for m in msgs)
        saw_note = any("restarted during this turn" in t for t in texts)
        return {"role": "assistant", "content": "resumed:" + ("saw" if saw_cut and saw_note else "blind")}

    SCRIPT[:] = [model]
    ev = events(client.post("/api/assistant/chat", json={"message": "carry on, please", "conversation_id": cid}))
    assert [e["type"] for e in ev][:2] == ["start", "resumed"], [e["type"] for e in ev]
    assert ev[1]["reason"] == "restart" and ev[1]["at"] and ev[1]["at"][:4].isdigit()
    assert next(e for e in ev if e["type"] == "message")["content"] == "resumed:saw"
    # said once: the turn after that is an ordinary turn
    SCRIPT[:] = [{"role": "assistant", "content": "ok"}]
    ev = events(client.post("/api/assistant/chat", json={"message": "and?", "conversation_id": cid}))
    assert "resumed" not in [e["type"] for e in ev]
    db.run("DELETE FROM jobs WHERE id = ?", jid)


def test_a_goal_that_opted_in_resumes_after_a_restart_and_one_that_did_not_stays(client):
    from app import assistant, db, goals, restart

    def goal_conversation(flag: bool) -> tuple[int, int]:
        cid = assistant.new_conversation("web")
        _cut_off_turn(cid, "create_note")
        g = goals.create(goals.GoalIn(conversation_id=cid, objective="Write three drafts", max_rounds=3, resume_on_restart=flag))
        return cid, g["id"]

    db.run("UPDATE goals SET resume_on_restart = 0 WHERE resume_on_restart = 1")  # other suites leave flagged goals behind
    yes_cid, yes_goal = goal_conversation(True)
    no_cid, no_goal = goal_conversation(False)
    restart.recover()
    registered: list[bool] = []
    SCRIPT[:] = [lambda msgs: registered.append(yes_cid in assistant.TURNS) or tool_call("complete_goal", {"summary": "all three written"}),
                 {"role": "assistant", "content": "The drafts are written."}]
    CALLS.clear()
    resumed = asyncio.run(restart.resume_goals())
    assert [r["conversation_id"] for r in resumed] == [yes_cid]
    assert registered == [True] and yes_cid not in assistant.TURNS
    assert any(e["type"] == "resumed" and e["reason"] == "restart" for e in resumed[0]["events"])
    assert "still active" in CALLS[0]["messages"][-1]["content"]  # the goal's own continue note, as a new turn
    yes, no = goals.get(yes_goal), goals.get(no_goal)
    assert yes["phase"] == "complete" and yes["rounds_used"] == 1
    assert no["phase"] == "active" and no["rounds_used"] == 0
    outcomes = [t["outcome"] for t in db.all("SELECT outcome FROM actions WHERE kind = 'turn' AND conversation_id = ? ORDER BY id", yes_cid)]
    assert outcomes[0] == "interrupted" and outcomes[-1] not in ("running", "interrupted") and len(outcomes) == 2
    assert [t["outcome"] for t in db.all("SELECT outcome FROM actions WHERE kind = 'turn' AND conversation_id = ?", no_cid)] == ["interrupted"]
    # a goal waiting on an approval is never continued past it
    from app import actions

    held_cid = assistant.new_conversation("web")
    g = goals.create(goals.GoalIn(conversation_id=held_cid, objective="Send the report", max_rounds=3, resume_on_restart=True))
    actions.add("tool_call", "held", trace={"conversation_id": held_cid}, tool="send_email", effect="external", payload='{"to": "a@b.c"}', detail="test")
    assert asyncio.run(restart.resume_goals()) == []
    assert goals.get(g["id"])["rounds_used"] == 0
    SCRIPT.clear()
    db.run("DELETE FROM goals WHERE id IN (?, ?, ?)", yes_goal, no_goal, g["id"])  # other suites count goals


# --- 4. approvals are never duplicated -------------------------------------------------------------------------------
def test_the_same_held_call_twice_is_one_approval_and_an_honest_end(client):
    from app import actions, db

    args = {"to": "sam@example.com", "subject": "Hi", "body": "Hello Sam"}
    never = {"role": "assistant", "content": "NEVER: the turn should have ended before this"}
    SCRIPT[:] = [tool_call("send_email", args, "a"), tool_call("send_email", args, "b"), never]
    ev = events(client.post("/api/assistant/chat", json={"message": "email sam"}))
    cid = ev[0]["conversation_id"]
    held = [e for e in ev if e["type"] == "approval_required"]
    assert len(held) == 1 and held[0]["tool"] == "send_email"
    assert len(actions.pending(cid)) == 1
    results = [e for e in ev if e["type"] == "tool_result"]
    assert len(results) == 2 and results[1]["ok"] is False
    assert results[1]["preview"].startswith("Not run:") and f"request #{held[0]['id']}" in results[1]["preview"]
    final = next(e for e in ev if e["type"] == "message")["content"]
    assert "NEVER" not in final and "your OK" in final and "stopped" in final
    assert db.one("SELECT outcome FROM actions WHERE kind = 'turn' AND conversation_id = ?", cid)["outcome"] == "held"
    assert SCRIPT == [never]  # the model was not asked again after the repeat
    rows = db.all("SELECT outcome, detail FROM actions WHERE kind = 'tool_call' AND conversation_id = ? ORDER BY id", cid)
    assert [r["outcome"] for r in rows] == ["held", "duplicate"] and f"#{held[0]['id']}" in rows[1]["detail"]
    # the request is still pending in a later turn: asking again does not make a second one either
    SCRIPT[:] = [tool_call("send_email", args, "c"), never]
    ev2 = events(client.post("/api/assistant/chat", json={"message": "did you send it?", "conversation_id": cid}))
    assert not [e for e in ev2 if e["type"] == "approval_required"] and len(actions.pending(cid)) == 1
    assert "stopped" in next(e for e in ev2 if e["type"] == "message")["content"]
    # a different request is a different approval
    SCRIPT[:] = [tool_call("send_email", {**args, "to": "ana@example.com"}, "d"), {"role": "assistant", "content": "Two waiting."}]
    ev3 = events(client.post("/api/assistant/chat", json={"message": "and ana", "conversation_id": cid}))
    assert len([e for e in ev3 if e["type"] == "approval_required"]) == 1 and len(actions.pending(cid)) == 2
    SCRIPT.clear()


# --- 5. a send that happened backs the sentence that says so ---------------------------------------------------------
def test_an_approved_send_backs_a_sent_claim(client, monkeypatch):
    from app import assistant, db, receipts

    sent: list[str] = []

    async def fake_send(to, subject, body, in_reply_to="", account_id=None):
        sent.append(to)
        return {"sent": True, "from": "me@example.com", "to": to, "subject": subject, "message_id": "<m1@example.com>"}

    monkeypatch.setattr(assistant.TOOL_MAP["send_email"], "fn", fake_send)
    SCRIPT[:] = [tool_call("send_email", {"to": "sam@example.com", "subject": "Hi", "body": "Hello"}),
                 {"role": "assistant", "content": "I need your OK to send it."}]
    ev = events(client.post("/api/assistant/chat", json={"message": "email sam hello"}))
    cid = ev[0]["conversation_id"]
    held = next(e for e in ev if e["type"] == "approval_required")
    ok = client.post(f"/api/approvals/{held['id']}", json={"approve": True}).json()
    assert ok["status"] == "done" and sent == ["sam@example.com"]
    SCRIPT[:] = [{"role": "assistant", "content": "Yes, I sent the email to Sam."}, {"role": "assistant", "content": "Yes, I sent the email to Sam."}]
    ev = events(client.post("/api/assistant/chat", json={"message": "did it go?", "conversation_id": cid}))
    final = next(e for e in ev if e["type"] == "message")["content"]
    assert "Not verified" not in final and not [e for e in ev if e["type"] == "claim_check"]
    assert db.one("SELECT outcome FROM actions WHERE kind = 'turn' AND conversation_id = ? ORDER BY id DESC LIMIT 1", cid)["outcome"] == "backed"
    # the rule itself: a send that ran backs the sentence; without one it is still caught, in plain words
    ran = [{"tool": "send_email", "effect": "external", "outcome": "ok", "verified": None, "evidence": "", "ref": None}]
    assert receipts.unbacked_claim("I sent it to Sam.", ran) == ("", "")
    sentence, why = receipts.unbacked_claim("I sent it to Sam.", [])
    assert sentence and why and "Workbench" not in why
    SCRIPT.clear()
