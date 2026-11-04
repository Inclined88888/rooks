"""Notes the browser leaves for the Computer page, and a browse job that waits before it clicks."""

import json
import time
import uuid

from . import db


def record(reason: str, url: str = "") -> dict:
    note = {
        "reason": (reason or "Please finish this step yourself.").strip()[:300],
        "url": (url or "").strip()[:500],
        "where": "computer",
    }
    if not note["reason"]:
        note["reason"] = "Please finish this step yourself."
    db.set_setting("desk_handoff", json.dumps(note))
    return note


def latest() -> dict | None:
    raw = db.get_setting("desk_handoff", "") or ""
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return data if isinstance(data, dict) and data.get("reason") else None


def _job(goal: str) -> dict:
    return {
        "id": uuid.uuid4().hex[:12],
        "goal": " ".join((goal or "").split())[:500],
        "status": "waiting",
        "source": "chat",
        "provider": "",
        "model": "",
        "created_at": time.time(),
        "clicks": False,
        "sends": False,
        "steps": [],
        "error": None,
        "has_screenshot": False,
        "pending_approvals": [],
        "allowed_domains": [],
        "result": None,
    }


def queue_browse(goal: str) -> dict:
    """A browse job that waits for approval. Nothing is opened, clicked, or sent from here."""
    row = _job(goal)
    db.set_setting("pending_browse", json.dumps(row))
    _hold_on_browser(row)
    return pending_browse() or row


def _hold_on_browser(row: dict) -> None:
    """Ask the browser service to keep the same job waiting, when that service is already running."""
    from . import config

    if not (config.BROWSER_URL and config.BROWSER_API_KEY) or not row.get("goal"):
        return
    import httpx

    try:
        r = httpx.post(
            f"{config.BROWSER_URL.rstrip('/')}/api/jobs",
            json={"goal": row["goal"], "hold": True, "source": "chat"},
            headers={"Authorization": f"Bearer {config.BROWSER_API_KEY}"},
            timeout=3,
        )
        if r.status_code >= 400:
            return
        remote = r.json()
        if remote.get("id"):
            row["id"] = remote["id"]
            db.set_setting("pending_browse", json.dumps(row))
    except (httpx.HTTPError, ValueError, OSError):
        return


def pending_browse() -> dict | None:
    raw = db.get_setting("pending_browse", "") or ""
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return data if isinstance(data, dict) and data.get("goal") else None


def remember_page(url: str, title: str, outline: str = "") -> dict:
    """Keep a short note of a page that was read. This does not open the page again."""
    head = " · ".join(part for part in ((title or "").strip(), (url or "").strip()) if part)
    body = " ".join((outline or "").split())[:400]
    note = (head + ("\n" + body if body else "")).strip()
    row = {"note": note, "url": (url or "").strip()[:500], "title": (title or "").strip()[:200]}
    db.set_setting("browse_note", json.dumps(row))
    return row


def last_page() -> dict | None:
    raw = db.get_setting("browse_note", "") or ""
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return data if isinstance(data, dict) and data.get("note") else None
