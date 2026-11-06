"""Needs you (design 0003, section 8): one inbox for everything waiting on the person, from every system.

Items keep their home and are answered there, exactly once. The id says where an item lives:

  a:<action id>              a held tool call in the run log (chat, jobs, schedules; a Room hand-off is one too)
  j:<job id>                 a job that asks before it starts (automations with "ask first")
  d:<desk job>:<approval>    a step Rooks Desk paused on (a command, a file outside the allowed folders, a purchase)
  b:<browser job>:<approval> a step Rooks Browser paused on (submit, purchase, message, login, download)

POST /api/needs-you/{id}/approve|deny routes to assistant.decide, jobs.approve_start, or the helper's own approval
route. A second answer to the same item is refused (409 from the run log, 409 from the board, 404 from a helper that no
longer waits), so nothing is ever run twice from the inbox. The helpers on this computer are asked with a short
timeout; one that is off or silent contributes nothing to the list and is logged at debug level only. An answer to a
helper that cannot be reached is an error (502), never a silent loss.

Every call to a helper is a row in the outbound audit log (R8), and the presence strip polls every second, so the
helpers' answers are kept for a few seconds (HELPER_CACHE_S) for the count; opening the inbox asks them afresh, and an
answer posted here clears what was kept.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException

from . import actions, browser_proxy, config, db, desk_proxy, jobs
from .security import require_user

log = logging.getLogger("needs_you")
router = APIRouter(prefix="/api/needs-you", dependencies=[Depends(require_user)])

HELPER_TIMEOUT_S = 0.5   # per request: the helpers are on this computer; a slow one must not slow the strip
HELPER_BUDGET_S = 1.5    # per helper, all its requests together (a listing and a few job details)
HELPER_JOBS = 5          # how many of a helper's active jobs are asked for their waiting steps
HELPER_CACHE_S = 5.0     # the count reuses the helpers' last answer this long; an answer posted here clears it
ACTIONS = ["approve", "deny"]
_helper_cache: tuple[float, tuple, list[dict]] | None = None  # (when, which helpers, items)

# What a held call asks for, as a title a person reads before saying yes. Verbs, plain words, no tool names.
TITLES: dict[str, tuple[str, str]] = {  # tool: (title, the argument that names its subject)
    "send_email": ("Send an email", "to"),
    "save_email_draft": ("Save a draft", "to"),
    "create_event": ("Add to the calendar", "title"),
    "create_task": ("Add a task", "title"),
    "update_task": ("Change a task", "title"),
    "create_note": ("Write a note", "title"),
    "append_to_note": ("Add to a note", "title"),
    "remember": ("Remember something about you", ""),
    "forget": ("Forget a memory", ""),
    "save_skill": ("Save a skill", "name"),
    "load_skill": ("Use a skill", "name"),
    "schedule_task": ("Set something to run later", "name"),
    "use_computer": ("Use this computer", "goal"),
    "browse_web": ("Open the browser", "goal"),
    "use_room": ("Use the Room", "goal"),
    "run_command": ("Run a command", "command"),
    "write_file": ("Write a file", "path"),
    "edit_file": ("Edit a file", "path"),
    "delegate_task": ("Hand a task to a teammate", "title"),
    "start_background_job": ("Start a job", "title"),
    "watch_site": ("Watch a website", "name"),
    "site_action": ("Act on a website", "name"),
}


def _title(tool: str, args: dict) -> str:
    from .presence import clip

    if tool.startswith("mcp__"):  # mcp__<server>__<tool>: a tool on one of the user's own connected servers
        parts = tool.split("__", 2)
        server, name = (parts[1], parts[2]) if len(parts) == 3 else ("", parts[-1])
        return f"Run {name.replace('_', ' ')} on {server}" if server else f"Run {name.replace('_', ' ')}"
    title, key = TITLES.get(tool, (tool.replace("_", " ").strip().capitalize() or "A step", ""))
    subject = args.get(key) if key else None
    return f"{title}: {clip(' '.join(str(subject).split()))}" if isinstance(subject, (str, int)) and str(subject).strip() else title


def _iso(epoch) -> str | None:
    try:
        return datetime.fromtimestamp(float(epoch), timezone.utc).isoformat(timespec="seconds")
    except (TypeError, ValueError, OverflowError):
        return None


# --- items -------------------------------------------------------------------------------------------------------------
def _action_item(a: dict) -> dict:
    """A held tool call, as the run log shows it to its owner: the real arguments, so the card says what will really be
    sent or changed (the same as /api/approvals)."""
    from .presence import args_summary

    try:
        args = json.loads(a["args"] or "{}")
    except ValueError:
        args = {}
    args = args if isinstance(args, dict) else {}
    return {"id": f"a:{a['id']}", "kind": "approval", "title": _title(a["tool"], args),
            "detail": args_summary(args, 200), "since": a["created_at"], "conversation_id": a["conversation_id"],
            "job_id": None, "actions": ACTIONS, "tool": a["tool"], "effect": a["effect"], "reason": a["reason"] or "",
            "args": a["args"]}


def _job_item(j: dict) -> dict:
    payload = j.get("payload") if isinstance(j.get("payload"), dict) else {}
    return {"id": f"j:{j['id']}", "kind": "job", "title": j["title"], "detail": payload.get("event_summary") or j["detail"],
            "since": j["created_at"], "conversation_id": j.get("conversation_id"), "job_id": j["id"], "actions": ACTIONS}


def _desk_item(job: dict, ap: dict) -> dict:
    return {"id": f"d:{job['id']}:{ap['id']}", "kind": "desktop",
            "title": ap.get("summary") or "A step on this computer needs your OK", "detail": ap.get("detail") or job.get("goal") or "",
            "since": _iso(ap.get("asked_at")) or _iso(job.get("updated_at")), "conversation_id": None, "job_id": job["id"],
            "actions": ACTIONS}


def _browser_item(job: dict, ap: dict) -> dict:
    host = urlsplit(ap.get("url") or "").hostname or ""
    label = ap.get("label") or ap.get("category") or "A step"
    return {"id": f"b:{job['id']}:{ap['id']}", "kind": "browser",
            "title": ap.get("description") or label, "detail": f"{label} on {host}" if host else label,
            "since": _iso(ap.get("asked_at")) or _iso(job.get("updated_at")), "conversation_id": None, "job_id": job["id"],
            "actions": ACTIONS}


def _jobs_waiting_to_start() -> list[dict]:
    jobs.ensure()
    rows = db.all("SELECT * FROM jobs WHERE status = 'waiting' AND needs = 'start' ORDER BY id DESC")
    out = []
    for r in rows:
        r = dict(r)
        try:
            r["payload"] = json.loads(r.get("payload") or "{}")
        except ValueError:
            r["payload"] = {}
        out.append(r)
    return out


# --- the helpers on this computer ----------------------------------------------------------------------------------------
HELPERS = {  # kind: (enabled, base url, key, item builder)
    "desktop": (desk_proxy.enabled, lambda: config.DESK_URL, lambda: config.DESK_API_KEY, _desk_item),
    "browser": (lambda: bool(config.BROWSER_URL and config.BROWSER_API_KEY), lambda: config.BROWSER_URL,
                lambda: config.BROWSER_API_KEY, _browser_item),
}


async def _helper_items(kind: str) -> list[dict]:
    _, base, key, build = HELPERS[kind]
    headers = {"Authorization": f"Bearer {key()}"}
    out = []
    async with httpx.AsyncClient(timeout=HELPER_TIMEOUT_S, base_url=base()) as c:
        r = await c.get("/api/jobs", headers=headers)
        r.raise_for_status()
        listing = r.json()
        listing = listing if isinstance(listing, list) else []
        active = [j for j in listing if isinstance(j, dict) and j.get("status") in ("running", "waiting", "queued")][:HELPER_JOBS]
        for j in active:
            d = await c.get(f"/api/jobs/{j['id']}", headers=headers)
            if d.status_code != 200:
                continue
            job = d.json()
            for ap in job.get("pending_approvals") or []:
                if isinstance(ap, dict) and ap.get("id"):
                    out.append(build(job, ap))
    return out


async def _helper_items_or_nothing(kind: str) -> list[dict]:
    try:
        return await asyncio.wait_for(_helper_items(kind), HELPER_BUDGET_S)
    except Exception as e:  # noqa: BLE001 - a quiet helper is "nothing waiting", never an error on the strip
        log.debug("%s approvals unavailable: %s", kind, e.__class__.__name__)
        return []


def _which_helpers() -> tuple:
    return tuple(base() if enabled() else "" for enabled, base, *_rest in HELPERS.values())


def forget_helpers() -> None:
    """Drop the kept answer, so the next count asks the helpers again (after an answer, or in tests)."""
    global _helper_cache
    _helper_cache = None


async def helper_items(fresh: bool = False) -> list[dict]:
    """Steps the desk and browser helpers paused on, asked side by side. A helper that is off, slow or broken
    contributes nothing, so the whole call is bounded by one helper's budget. Unless `fresh`, an answer younger than
    HELPER_CACHE_S from the same helpers is reused."""
    global _helper_cache
    which = _which_helpers()
    if not fresh and _helper_cache and _helper_cache[1] == which and time.monotonic() - _helper_cache[0] < HELPER_CACHE_S:
        return _helper_cache[2]
    kinds = [kind for kind, (enabled, *_rest) in HELPERS.items() if enabled()]
    out = []
    for found in await asyncio.gather(*(_helper_items_or_nothing(k) for k in kinds)):
        out += found
    _helper_cache = (time.monotonic(), which, out)
    return out


# --- the inbox ----------------------------------------------------------------------------------------------------------
async def items() -> list[dict]:
    out = [_action_item(a) for a in actions.pending()]  # newest first already
    out += [_job_item(j) for j in _jobs_waiting_to_start()]
    out += await helper_items(fresh=True)  # a person opening the inbox sees the helpers as they are now
    return sorted(out, key=lambda i: i["since"] or "", reverse=True)  # stable: ties keep newest-first order


async def count() -> int:
    jobs.ensure()
    starts = db.one("SELECT COUNT(*) AS n FROM jobs WHERE status = 'waiting' AND needs = 'start'")["n"]
    return actions.pending_count() + starts + len(await helper_items())


@router.get("")
async def inbox():
    """Everything waiting on you, newest first: held actions, jobs that ask first, and steps the desk and browser paused on."""
    return await items()


@router.post("/{item_id}/{answer}")
async def decide(item_id: str, answer: str):
    """Approve or deny one item in the system it came from. Answered once: a repeat is refused."""
    if answer not in ACTIONS:
        raise HTTPException(404, "Nothing is waiting under that name.")
    approve = answer == "approve"
    kind, _, rest = item_id.partition(":")
    status = "approved" if approve else "denied"
    if kind == "a" and rest.isdigit():
        from . import assistant

        a = await assistant.decide(int(rest), approve)  # 404 unknown, 409 already answered
        return {"id": item_id, "status": a["status"], "result": a.get("result", "")}
    if kind == "j" and rest.isdigit():
        j = jobs.approve_start(int(rest), approve)  # 404 unknown, 409 not waiting to start
        return {"id": item_id, "status": status, "job": {"id": j["id"], "status": j["status"], "detail": j["detail"]}}
    if kind in ("d", "b"):
        job_id, _, aid = rest.partition(":")
        if not job_id or not aid:
            raise HTTPException(404, "Nothing is waiting under that name.")
        call = desk_proxy.call if kind == "d" else browser_proxy._call  # 503 off, 502 unreachable, 404 no longer waiting
        r = await call("POST", f"/api/jobs/{job_id}/approvals/{aid}", json={"approve": approve})
        forget_helpers()  # the pill drops at once, not when the kept answer expires
        try:
            result = r.json()
        except ValueError:
            result = {}
        return {"id": item_id, "status": status, "result": result}
    raise HTTPException(404, "Nothing is waiting under that name.")
