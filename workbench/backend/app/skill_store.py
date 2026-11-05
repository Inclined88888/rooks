"""A small store of skills and connectors, ordered by how this person already uses the app."""

from __future__ import annotations

from . import db, learn

SKILLS = (
    {
        "id": "inbox-check",
        "name": "Inbox check",
        "when": ("mail", "work"),
        "description": "Look through new mail and say what needs a reply.",
        "steps": "Open the inbox. List what arrived that still needs a reply, grouped by who it is from. "
                 "Do not send anything. Offer to draft a reply only when asked.",
    },
    {
        "id": "admin-day",
        "name": "Admin day",
        "when": ("work",),
        "description": "Run an administration day: mail, calendar, and what is waiting.",
        "steps": "Check today's calendar, then the inbox, then open tasks. "
                 "Write a short list: what is due, what is waiting on someone else, and what to do next. "
                 "Do not send mail or change the calendar unless asked.",
    },
    {
        "id": "meeting-prep",
        "name": "Meeting prep",
        "when": ("calendar",),
        "description": "Get ready for the next meeting on the calendar.",
        "steps": "Find the next event. Summarise who is coming, what it is about, and what is still open from related notes or mail. "
                 "Keep it to a few lines.",
    },
    {
        "id": "task-sweep",
        "name": "Task sweep",
        "when": ("tasks",),
        "description": "Sort open tasks into today, waiting, and later.",
        "steps": "Read open tasks. Group them into today, waiting on someone, and later. "
                 "Suggest one next step for today. Do not delete tasks.",
    },
    {
        "id": "weekly-review",
        "name": "Weekly review",
        "when": (),
        "description": "A short review of the week from mail, tasks, and notes.",
        "steps": "Look at what was finished and what is still open. Write under 250 words: done, still open, and the one thing to start next week.",
    },
    {
        "id": "careful-coding",
        "name": "Careful coding",
        "when": ("code",),
        "description": "Change a project only after saying what will change.",
        "steps": "Read the folder first. Say which files you expect to touch. Ask before running a command or editing. "
                 "After a change, say what you ran and what the result was.",
    },
)

CONNECTORS = (
    {"id": "mail", "name": "Mail", "to": "/settings?section=apps", "blurb": "Read and draft mail from here.", "flag": "mail"},
    {"id": "calendar", "name": "Calendar", "to": "/calendar", "blurb": "See the day and add events.", "flag": "calendar"},
    {"id": "models", "name": "Models", "to": "/models", "blurb": "Choose who answers.", "flag": None},
    {"id": "tools", "name": "Other tools", "to": "/mcp", "blurb": "Connect a tool you already use.", "flag": None},
)


def _flags() -> dict:
    flags = {"mail": False, "work": False, "calendar": False, "tasks": False, "code": False}
    try:
        rows = db.all("SELECT life_role FROM mail_accounts")
        flags["mail"] = bool(rows)
        flags["work"] = any((r.get("life_role") or "") == "work" for r in rows)
    except Exception:  # noqa: BLE001 - the table is not in every install
        pass
    try:
        flags["calendar"] = db.one("SELECT id FROM calendars LIMIT 1") is not None
    except Exception:  # noqa: BLE001
        pass
    try:
        flags["tasks"] = db.one("SELECT id FROM tasks LIMIT 1") is not None
    except Exception:  # noqa: BLE001
        pass
    try:
        flags["code"] = db.one(
            "SELECT id FROM conversations WHERE title LIKE '%code%' OR channel = 'cli' LIMIT 1"
        ) is not None
    except Exception:  # noqa: BLE001
        pass
    return flags


def _saved_name(name: str) -> str:
    return name.strip().lower().replace(" ", "-")


def _have() -> set[str]:
    try:
        return {r["name"] for r in db.all("SELECT name FROM skills")}
    except Exception:  # noqa: BLE001
        return set()


def listing() -> dict:
    flags = _flags()
    have = _have()

    def score(item: dict) -> int:
        tags = item["when"]
        if not tags:
            return 1
        return sum(2 for tag in tags if flags.get(tag))

    skills = []
    for item in sorted(SKILLS, key=score, reverse=True):
        skills.append({
            "id": item["id"],
            "name": item["name"],
            "description": item["description"],
            "why": _why(item, flags),
            "added": _saved_name(item["name"]) in have,
            "for_you": score(item) > 1,
        })
    connectors = []
    for item in CONNECTORS:
        on = bool(item["flag"] and flags.get(item["flag"]))
        connectors.append({
            "id": item["id"],
            "name": item["name"],
            "blurb": item["blurb"],
            "to": item["to"],
            "on": on,
        })
    return {"skills": skills, "connectors": connectors}


def _why(item: dict, flags: dict) -> str:
    if "work" in item["when"] and flags.get("work"):
        return "Fits the work mail already connected."
    if "mail" in item["when"] and flags.get("mail"):
        return "Fits the mail already connected."
    if "calendar" in item["when"] and flags.get("calendar"):
        return "Fits the calendar already connected."
    if "tasks" in item["when"] and flags.get("tasks"):
        return "Fits the tasks already here."
    if "code" in item["when"] and flags.get("code"):
        return "Fits the coding you already do here."
    return "Useful on its own."


def add(skill_id: str) -> dict:
    item = next((s for s in SKILLS if s["id"] == skill_id), None)
    if item is None:
        from fastapi import HTTPException
        raise HTTPException(404, "That skill is not in the store.")
    return learn.upsert_skill(item["name"], item["description"], item["steps"], source="user")
