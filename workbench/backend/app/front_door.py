"""The one assistant people talk to: a main conversation, result cards, standing routines, and pings.

Schedules still run in scheduler.py. "When this happens" rules still run in automations.py.
This module only decides which one a sentence belongs to, and writes a plain note into the main chat
when background work finishes or needs a yes.
"""

from __future__ import annotations

import json
import re

from . import db

_CUE = re.compile(
    r"\b(always|every|when(?:ever)?|each\s+(morning|weekday|week|day)|from now on|standing instruction)\b",
    re.I,
)
_ALWAYS = re.compile(r"^(please\s+)?(always|from now on)\b[:,]?\s*", re.I)


def main_conversation() -> int:
    """The chat Home opens. Created once and reused."""
    from . import assistant

    raw = db.get_setting("main_conversation_id", "") or ""
    if str(raw).isdigit():
        row = db.one("SELECT id FROM conversations WHERE id = ?", int(raw))
        if row:
            return int(row["id"])
    name = db.get_setting("assistant_name", "Atlas") or "Atlas"
    cid = assistant.new_conversation("web", name)
    db.set_setting("main_conversation_id", str(cid))
    return cid


def ping(text: str) -> int:
    """Leave a note in the main chat. Does not send mail or start another job."""
    from . import assistant

    body = (text or "").strip()
    if not body:
        return 0
    return assistant._save(main_conversation(), "assistant", body[:2000])


def _deliver() -> str:
    return "telegram" if (db.get_setting("reach_channel") or "") == "telegram" else "inbox"


def try_routine(text: str) -> dict | None:
    """Save a clear standing instruction. Unclear sentences return None so the chat can ask."""
    from . import automations, scheduler
    from .sites import describe_cron

    spoken = (text or "").strip()
    if len(spoken) < 8 or not _CUE.search(spoken):
        return None
    if _ALWAYS.search(spoken) and not re.search(r"\b(every|whenever|when|each)\b", spoken, re.I):
        spoken = "Every morning, " + _ALWAYS.sub("", spoken).strip()
    try:
        draft = automations.parse(spoken)
    except Exception:  # noqa: BLE001 - a sentence we cannot read is just a normal chat
        return None
    if draft.get("questions") or float(draft.get("confidence") or 0) < 0.8:
        return None
    prompt = (draft.get("action") or {}).get("prompt") or draft.get("then") or spoken
    if draft["trigger_kind"] == "schedule":
        cron = draft["trigger"]["cron"]
        row = scheduler.create_schedule(draft["name"], cron, prompt, _deliver())
        when = describe_cron(cron)
        task = prompt[:1].lower() + prompt[1:] if prompt else "that"
        sentence = f"{when[:1].upper()}{when[1:]}, I'll {task}"
        kind, rid = "schedule", row["id"]
    else:
        saved = automations.create({
            "name": draft["name"], "request": spoken, "trigger_kind": draft["trigger_kind"],
            "trigger": draft["trigger"], "action_kind": draft["action_kind"], "action": draft["action"],
            "ask_first": True,
        })
        sentence = saved["sentence"]
        kind, rid = "automation", saved["id"]
    confirmation = (
        f"Saved. {sentence}. I'll ask before anything is sent or leaves this computer. "
        "You can pause it under Routines."
    )
    return {
        "confirmation": confirmation,
        "card": {"kind": "routine", "routine_kind": kind, "id": rid, "name": draft["name"], "sentence": sentence},
    }


def routines() -> list[dict]:
    from . import automations
    from .sites import describe_cron

    out = []
    for s in db.all("SELECT id, name, cron, prompt, enabled FROM schedules ORDER BY id DESC"):
        try:
            when = describe_cron(s["cron"])
        except Exception:  # noqa: BLE001
            when = "On a schedule"
        out.append({
            "kind": "schedule", "id": s["id"], "name": s["name"], "enabled": bool(s["enabled"]),
            "sentence": f"{when[:1].upper()}{when[1:]}, {s['prompt'][:180]}",
        })
    try:
        rows = automations.listing().get("automations") or []
    except Exception:  # noqa: BLE001
        rows = []
    for a in rows:
        out.append({
            "kind": "automation", "id": a["id"], "name": a["name"], "enabled": bool(a["enabled"]),
            "sentence": a.get("sentence") or a.get("name") or "",
        })
    return out


def set_enabled(kind: str, rid: int, enabled: bool) -> dict:
    from . import automations, scheduler

    if kind == "schedule":
        row = db.one("SELECT * FROM schedules WHERE id = ?", rid)
        if not row:
            from fastapi import HTTPException
            raise HTTPException(404, "That routine is gone.")
        db.run("UPDATE schedules SET enabled = ?, next_run = ? WHERE id = ?", int(enabled), scheduler.next_run(row["cron"]), rid)
    elif kind == "automation":
        automations.update(rid, {"enabled": enabled})
    else:
        from fastapi import HTTPException
        raise HTTPException(400, "Unknown routine.")
    found = next((r for r in routines() if r["kind"] == kind and r["id"] == rid), None)
    return found or {"kind": kind, "id": rid, "enabled": enabled}


def _loads(raw) -> dict:
    if isinstance(raw, dict):
        return raw
    try:
        data = json.loads(raw or "{}")
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def card_from(name: str, result, arguments=None) -> dict | None:
    """A result the chat can show as a card. Unknown tools stay as plain text."""
    data = _loads(result)
    args = _loads(arguments)
    if name == "save_email_draft" and data.get("draft_id"):
        return {
            "kind": "draft", "id": data["draft_id"], "to": args.get("to") or "",
            "subject": args.get("subject") or "", "body": str(args.get("body") or "")[:600],
            "status": "Not sent. It waits for you.",
        }
    if name == "create_event" and (data.get("id") or data.get("title") or args.get("title")):
        return {
            "kind": "event", "id": data.get("id"), "title": data.get("title") or args.get("title") or "Event",
            "start": data.get("start") or args.get("start") or "", "location": data.get("location") or args.get("location") or "",
        }
    if name == "create_task" and (data.get("id") or data.get("title") or args.get("title")):
        return {
            "kind": "task", "id": data.get("id"), "title": data.get("title") or args.get("title") or "Task",
            "due": data.get("due") or args.get("due") or "",
        }
    if name == "create_note" and data.get("id"):
        return {"kind": "note", "id": data["id"], "title": data.get("title") or args.get("title") or "Note", "note_kind": data.get("kind") or "note"}
    if name in ("use_computer", "browse_web") and data.get("job_id"):
        return {
            "kind": "watch", "surface": "computer" if name == "use_computer" else "browser",
            "job_id": str(data["job_id"]), "goal": str(args.get("goal") or "")[:200],
            "status": data.get("status") or "",
        }
    if name == "use_room" and (args.get("action") or "") == "up" and data.get("running"):
        return {"kind": "watch", "surface": "room", "job_id": "room", "goal": str(args.get("goal") or "The Room")[:200],
                "status": "running"}
    files = data.get("files") if isinstance(data.get("files"), list) else []
    if name == "use_computer" and files:
        return {"kind": "file", "files": [str(f) for f in files[:8]]}
    return None


def stamp_cards(rows: list[dict]) -> None:
    """Attach tool cards to the last reply of each turn. Rows may carry `_card`."""
    def flush(chunk: list[dict]) -> None:
        cards = []
        last = None
        for r in chunk:
            if r.get("role") != "assistant":
                card = r.pop("_card", None)
                if card:
                    cards.append(card)
                continue
            card = r.pop("_card", None)
            if card:
                cards.append(card)
            if (r.get("content") or "").strip():
                last = r
        if cards and last is not None:
            last["cards"] = cards
        elif cards:
            for r in reversed(chunk):
                if r.get("role") == "assistant":
                    r["cards"] = cards
                    break

    chunk: list[dict] = []
    for r in rows:
        if r.get("role") == "user" and (r.get("name") or "") != "claim_check":
            flush(chunk)
            chunk = []
        else:
            chunk.append(r)
    flush(chunk)
    for r in rows:
        r.pop("_card", None)
        r.pop("tool_call_id", None)
