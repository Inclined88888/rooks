"""Presence (design 0003, section 8): what the assistant is doing right now, for the strip above the thread.

GET /api/presence answers from state the app already keeps: the run log (turns in flight and the tool call each is on),
the jobs board, held approvals, and the connected mailboxes and calendars. It never calls a model and never leaves the
machine: the only network it touches is the desk and browser helpers on this computer, asked with a short timeout
through needs_you, and a helper that is off or silent counts as nothing waiting. The answer is cached for one second,
so a strip that polls every second costs one set of indexed queries.

The current step is said the way the frontend says it (src/plainStep.ts): the same vocabulary, kept in step by hand,
so the strip and the thread never disagree. Arguments reach the strip summarised and redacted (R7): an address or a
key in a tool call is never shown on the status line.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Callable

from fastapi import APIRouter, Depends

from . import actions, db, jobs
from .redact import redact, redact_obj
from .security import require_user

log = logging.getLogger("presence")
router = APIRouter(prefix="/api/presence", dependencies=[Depends(require_user)])

CACHE_S = 1.0            # a strip polling every second reads the cached answer
DONE_S = 20              # a turn that finished this recently reads as "done"
STALE_TURN_S = 6 * 3600  # a turn row still "running" after this long is a leftover, not a live turn
ARGS_CHARS = 120         # the args summary on the status line
SUBJECT_CHARS = 72       # the subject inside a sentence, clipped like the frontend does

try:  # B2 adds the Room (app/room.py); until then there is nothing to watch there
    from . import room as _room
except ImportError:
    _room = None

_cache: tuple[float, dict] | None = None


# --- the vocabulary: a tool call, said the way a person would (mirror of plainStep.ts) ---------------------------------
def _field(args: dict, key: str) -> str:
    v = args.get(key)
    return " ".join(v.split()) if isinstance(v, str) else ""


def clip(text: str, n: int = SUBJECT_CHARS) -> str:
    t = text.strip()
    return t[: n - 1] + "…" if len(t) > n else t


def _with(verb: str, subject: str) -> str:
    return f"{verb}: {clip(subject)}" if subject else verb


SAY: dict[str, Callable[[dict], str]] = {
    "web_search": lambda a: _with("Searching", _field(a, "query")),
    "read_page": lambda a: "Reading a page",
    "browse_web": lambda a: _with("Looking through a site", _field(a, "goal")),
    "search_email": lambda a: _with("Looking through mail", _field(a, "query")),
    "read_email": lambda a: "Reading a message",
    "list_mail_accounts": lambda a: "Checking the mailboxes",
    "save_email_draft": lambda a: "Writing a draft",
    "send_email": lambda a: "Preparing to send mail",
    "list_tasks": lambda a: "Checking tasks",
    "create_task": lambda a: _with("Adding a task", _field(a, "title")),
    "update_task": lambda a: "Updating a task",
    "get_agenda": lambda a: "Checking the day",
    "list_events": lambda a: "Checking the calendar",
    "create_event": lambda a: _with("Adding to the calendar", _field(a, "title")),
    "list_calendars": lambda a: "Checking the calendars",
    "find_free_time": lambda a: "Looking for a free time",
    "search_notes": lambda a: _with("Looking through notes", _field(a, "query")),
    "read_note": lambda a: "Reading a note",
    "create_note": lambda a: "Writing a note",
    "append_to_note": lambda a: "Adding to a note",
    "read_file": lambda a: "Reading a file",
    "write_file": lambda a: "Writing a file",
    "edit_file": lambda a: "Editing a file",
    "run_command": lambda a: "Running something on this computer",
    "use_computer": lambda a: "Using this computer",
    "remember": lambda a: "Remembering that",
    "forget": lambda a: "Forgetting that",
    "search_memory": lambda a: "Looking through what it remembers",
    "search_history": lambda a: _with("Looking through past chats", _field(a, "query")),
    "schedule_task": lambda a: _with("Setting something to run later", _field(a, "name")),
    "list_schedules": lambda a: "Checking what runs later",
}

# Where a step happens, by the tool that does it; otherwise by the channel (a terminal chat works in the terminal).
WHERE_BY_TOOL = {"browse_web": "browser", "use_computer": "desktop", "use_room": "room"}
WHERE_BY_JOB = {"browser": "browser", "computer": "desktop", "room": "room"}


def plain_step(name: str, args: dict | None = None) -> str | None:
    """The sentence for a tool call, or None when the vocabulary has no words for it (the frontend keeps its own)."""
    say = SAY.get(name)
    return say(args or {}) if say else None


def args_summary(args: dict | str | None, limit: int = ARGS_CHARS) -> str:
    """Arguments as one short line: `key: value; key: value`, redacted before it is clipped, so a cut never leaves half
    an address behind."""
    if isinstance(args, str):
        try:
            args = json.loads(args or "{}")
        except ValueError:
            args = {"text": args}
    parts = []
    for k, v in (args or {}).items() if isinstance(args, dict) else []:
        if k == "ctx" or v is None or v == "":
            continue
        text = " ".join(v.split()) if isinstance(v, str) else json.dumps(v, ensure_ascii=False, default=str)
        parts.append(f"{k}: {text}")
    out = redact("; ".join(parts))
    return out[: limit - 1] + "…" if len(out) > limit else out


def where_of(tool: str | None, channel: str) -> str:
    if tool and tool in WHERE_BY_TOOL:
        return WHERE_BY_TOOL[tool]
    return "terminal" if channel == "cli" else "chat"


# --- what is in flight, from the run log and the board -----------------------------------------------------------------
def _since(seconds: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat(timespec="seconds")


def running_turns() -> list[dict]:
    """Turns in flight, newest first. Every turn opens a row that its loop closes whatever happens (assistant.run_turn),
    and a restart closes the rest (actions.recover); the age guard is belt and braces."""
    return db.all("SELECT id, ts, channel, conversation_id FROM actions WHERE kind = 'turn' AND outcome = 'running' "
                  "AND ts >= ? ORDER BY id DESC", _since(STALE_TURN_S))


def current_call(turn: dict) -> tuple[str, dict] | None:
    """The tool call the turn is on: the model's newest tool-calling message in this turn (saved before its tools run),
    first call without an answer yet, else its last call."""
    cid = turn["conversation_id"]
    m = db.one("SELECT id, tool_calls FROM messages WHERE conversation_id = ? AND role = 'assistant' AND tool_calls != '' "
               "AND created_at >= ? ORDER BY id DESC LIMIT 1", cid, turn["ts"])
    if not m:
        return None
    try:
        calls = json.loads(m["tool_calls"] or "[]")
    except ValueError:
        return None
    if not isinstance(calls, list) or not calls:
        return None
    answered = {r["tool_call_id"] for r in db.all(
        "SELECT tool_call_id FROM messages WHERE conversation_id = ? AND role = 'tool' AND id > ?", cid, m["id"])}
    call = next((c for c in calls if isinstance(c, dict) and c.get("id") not in answered), calls[-1])
    fn = (call.get("function") or {}) if isinstance(call, dict) else {}
    name = str(fn.get("name") or "")
    if not name:
        return None
    raw = fn.get("arguments")
    try:
        args = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except ValueError:
        args = {"text": raw}
    return name, args if isinstance(args, dict) else {}


def active_jobs() -> list[dict]:
    jobs.ensure()
    return db.all("SELECT id, kind, title, status FROM jobs WHERE status IN ('queued', 'running') ORDER BY id DESC")


def recently_done() -> bool:
    row = db.one("SELECT ts, latency_ms FROM actions WHERE kind = 'turn' AND outcome != 'running' "
                 "ORDER BY ts DESC, id DESC LIMIT 1")  # the (kind, ts) index answers this without a scan
    if not row:
        return False
    try:
        finished = datetime.fromisoformat(row["ts"]) + timedelta(milliseconds=row["latency_ms"] or 0)
    except ValueError:
        return False
    if finished.tzinfo is None:
        finished = finished.replace(tzinfo=timezone.utc)
    return 0 <= (datetime.now(timezone.utc) - finished).total_seconds() <= DONE_S


def room_running() -> bool:
    fn = getattr(_room, "running", None) if _room else None
    if not callable(fn):
        return False
    try:
        return bool(fn())
    except Exception as e:  # noqa: BLE001 - the Room is a watch, never a reason for the strip to fail
        log.debug("room status unavailable: %s", e.__class__.__name__)
        return False


def watching(active: list[dict]) -> list[str]:
    out = []
    if db.one("SELECT 1 FROM mail_accounts LIMIT 1"):
        out.append("mail")
    if db.one("SELECT 1 FROM calendars WHERE enabled = 1 LIMIT 1"):
        out.append("calendar")
    if active:
        out.append("jobs")
    if room_running():
        out.append("room")
    return out


async def build() -> dict:
    from . import needs_you

    turns = running_turns()
    active = active_jobs()
    running_jobs = [j for j in active if j["status"] == "running"]
    needs = await needs_you.count()

    doing = doing_tool = doing_args = where = None
    on_a_tool = False
    if turns:
        turn = turns[0]
        call = current_call(turn)
        if call:
            name, args = call
            clean = redact_obj(args)
            on_a_tool = True
            doing_tool = name
            doing_args = args_summary(clean) or None
            doing = plain_step(name, clean)
            where = where_of(name, turn["channel"])
        else:
            where = where_of(None, turn["channel"])
    if doing is None and running_jobs:
        doing = running_jobs[0]["title"] or None
        where = where or WHERE_BY_JOB.get(running_jobs[0]["kind"], "chat")

    if needs:
        mood = "needs"
    elif on_a_tool or running_jobs:
        mood = "working"
    elif turns:
        mood = "thinking"
    elif recently_done():
        mood = "done"
    else:
        mood = "idle"
    return {
        "name": db.get_setting("assistant_name", "Atlas") or "Atlas",
        "mood": mood,
        "doing": doing,
        "doing_tool": doing_tool,
        "doing_args": doing_args,
        "where": where,
        "watching": watching(active),
        "needs_you": needs,
        "running": {"turns": len(turns), "jobs": len(running_jobs)},
        "updated_at": db.now(),
    }


async def snapshot(fresh: bool = False) -> dict:
    global _cache
    if not fresh and _cache and time.monotonic() - _cache[0] < CACHE_S:
        return _cache[1]
    out = await build()
    _cache = (time.monotonic(), out)
    return out


@router.get("")
async def presence(fresh: bool = False):
    """The presence strip: name, mood, the current step in plain words, where it happens, what is watched, how many
    things need you, and what is running. `fresh=true` skips the one second cache."""
    return await snapshot(fresh)
