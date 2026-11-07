"""A restart, reported honestly (design 0003, section 1 "Memory" and W4 item 5; package B3).

When the app comes back, every turn that was still running was cut off. Instead of leaving those chats hanging, each
conversation gets a plain note in its record saying what was cut (a system row, name "restart"), the next turn in it
opens with a `resumed` event, and goals that asked to carry on (goals.resume_on_restart) are continued by a task that
starts with the app, registered in assistant.TURNS like any turn so Stop still works. Jobs keep their own rule:
jobs.recover pauses them for a Resume by hand.
"""

from __future__ import annotations

import asyncio
import json
import logging

from . import actions, db

log = logging.getLogger("restart")

NOTE_NAME = "restart"  # messages.name of the note row
NOTE = "Rooks restarted during this turn."
CUT = " These steps were cut off and not run: {steps}. Anything after them was not done."
MAYBE_RAN = " These steps may have run before the restart; check History to see: {steps}."
NOTHING_CUT = " The reply was cut short; nothing after that point was done."
_TASKS: set[asyncio.Task] = set()


def _cut_steps(conversation_id: int, turn_id: int | None = None) -> tuple[list[str], list[str]]:
    """The tool calls in the conversation's newest assistant row that never got an answer: what the restart cut, as
    (not run, may have run). A call whose run already has a row in the run log (ok or verified) for this turn may have
    done its work before its answer was saved, so it is never said to be "not run"."""
    m = db.one("SELECT id, tool_calls FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1",
               conversation_id)
    if not m or not m["tool_calls"]:
        return [], []
    try:
        calls = json.loads(m["tool_calls"])
    except ValueError:
        return [], []
    answered = {r["tool_call_id"] for r in db.all(
        "SELECT tool_call_id FROM messages WHERE conversation_id = ? AND role = 'tool' AND id > ?", conversation_id, m["id"])}
    ran: dict[str, int] = {}
    if turn_id:
        for r in db.all("SELECT tool FROM actions WHERE kind = 'tool_call' AND parent_action_id = ? AND outcome IN ('ok', 'verified')",
                        turn_id):
            ran[r["tool"]] = ran.get(r["tool"], 0) + 1
    calls = [c for c in calls if isinstance(c, dict)]
    for c in calls:  # an answered call accounts for its own run first
        name = str((c.get("function") or {}).get("name") or "")
        if c.get("id") in answered and ran.get(name):
            ran[name] -= 1
    cut, maybe = [], []
    for c in calls:
        if c.get("id") in answered:
            continue
        name = str((c.get("function") or {}).get("name") or "a step")
        if ran.get(name):
            ran[name] -= 1
            maybe.append(name)
        else:
            cut.append(name)
    return cut, maybe


def note_for(cut: list[str], maybe_ran: list[str] | None = None) -> str:
    """The note, in plain words (the tool names read as words: list tasks, not list_tasks)."""
    words = lambda names: ", ".join(n.replace("_", " ") for n in names)  # noqa: E731
    if not cut and not maybe_ran:
        return NOTE + NOTHING_CUT
    out = NOTE
    if maybe_ran:
        out += MAYBE_RAN.format(steps=words(maybe_ran))
    if cut:
        out += CUT.format(steps=words(cut))
    return out


def interrupt_running_turns() -> list[dict]:
    """At startup: close every turn still marked running (actions.recover) and write the note into its conversation.
    Returns what was done, one entry per turn: turn_id, conversation_id, cut (tool names), message_id."""
    from . import assistant

    rows = db.all("SELECT id, conversation_id FROM actions WHERE kind = 'turn' AND outcome = 'running' ORDER BY id")
    actions.recover()
    out = []
    for r in rows:
        cid = r["conversation_id"]
        if not cid or not db.one("SELECT id FROM conversations WHERE id = ?", cid):
            continue
        cut, maybe = _cut_steps(cid, r["id"])
        mid = assistant._save(cid, "system", note_for(cut, maybe), name=NOTE_NAME)
        out.append({"turn_id": r["id"], "conversation_id": cid, "cut": cut, "maybe_ran": maybe, "message_id": mid})
    return out


def resumed_from(conversation_id: int, turn_id: int | None) -> str | None:
    """When this conversation's previous turn was cut off by a restart: when that was (ISO), for the resumed event
    the new turn opens with. None for an ordinary turn."""
    if not conversation_id or not turn_id:
        return None
    prev = db.one("SELECT outcome, failure_reason FROM actions WHERE kind = 'turn' AND conversation_id = ? AND id < ? "
                  "ORDER BY id DESC LIMIT 1", conversation_id, turn_id)
    if not prev or prev["outcome"] != "interrupted" or prev["failure_reason"] != actions.RESTART_REASON:
        return None
    note = db.one("SELECT created_at FROM messages WHERE conversation_id = ? AND name = ? ORDER BY id DESC LIMIT 1",
                  conversation_id, NOTE_NAME)
    return (note or {}).get("created_at") or db.now()


async def _resume_goal(goal: dict) -> dict | None:
    """One more round of a goal that opted in, as a new turn in its conversation (the goal's own continue note)."""
    from . import assistant, goals

    cid = goal["conversation_id"]
    if actions.pending(cid):  # never continue past a held action
        return None
    can, reason = goals.can_continue(goal["id"])
    if not can:
        goals.block(goal["id"], {"code": "round-limit", "message": reason})
        return None
    conv = db.one("SELECT channel, model FROM conversations WHERE id = ?", cid)
    if not conv:
        return None
    goal = goals.increment_round(goal["id"])
    prompt = goals.GOAL_CONTINUE_PROMPT.format(objective=goal["objective"], round=goal["rounds_used"], max_rounds=goal["max_rounds"])
    ctx = assistant.Ctx(channel=conv["channel"] or "web", conversation_id=cid)
    task = asyncio.current_task()
    if task is not None:
        assistant.TURNS[cid] = task  # the Stop button cancels it, like any turn
    try:
        final, events = await assistant.ask(ctx, prompt, conv["model"] or None)
    finally:
        if task is not None and assistant.TURNS.get(cid) is task:
            del assistant.TURNS[cid]
    return {"goal_id": goal["id"], "conversation_id": cid, "final": final, "events": events}


async def resume_goals() -> list[dict]:
    """Continue every active goal that asked to carry on after a restart. Returns one entry per goal that ran."""
    from . import goals

    todo = goals.resumable()
    if not todo:
        return []
    results = await asyncio.gather(*(asyncio.create_task(_resume_goal(g)) for g in todo), return_exceptions=True)
    out = []
    for g, r in zip(todo, results):
        if isinstance(r, BaseException):
            log.warning("goal %s did not resume after the restart: %s", g["id"], r)
        elif r:
            out.append(r)
    return out


def recover() -> dict:
    """At startup, once the database is open: close the cut off turns and tell their conversations. Returns what was
    done and which goals will be continued (start() runs them)."""
    from . import goals

    turns = interrupt_running_turns()
    return {"turns": turns, "goals": [g["id"] for g in goals.resumable()]}


def start() -> asyncio.Task | None:
    """Continue the goals that opted in, without holding the app's start up."""
    try:
        task = asyncio.get_running_loop().create_task(resume_goals())
    except RuntimeError:
        return None
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
    return task
