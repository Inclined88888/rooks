"""One Rooks account on three surfaces: the desktop app, a paired browser, and the terminal.

A paired browser gets a bearer token (the code is shown once, on a machine that is already signed in).
The token is stored only as a hash. Computer and local-file work stay on the machine that runs Rooks;
a browser somewhere else can still chat, and is told when those actions are not on this device.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time

from fastapi import HTTPException, Request

from . import config, db

_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_CODE_TTL = 600


def ensure() -> None:
    db.conn().executescript(
        """
        CREATE TABLE IF NOT EXISTS browser_pairs (
          code_hash TEXT PRIMARY KEY,
          expires REAL NOT NULL,
          used INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS browser_tokens (
          id INTEGER PRIMARY KEY,
          token_hash TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          revoked INTEGER NOT NULL DEFAULT 0
        );
        """
    )


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def start_pair() -> dict:
    ensure()
    now = time.time()
    db.run("DELETE FROM browser_pairs WHERE expires < ? OR used = 1", now)
    raw = "".join(secrets.choice(_ALPHABET) for _ in range(8))
    code = f"{raw[:4]}-{raw[4:]}"
    db.run("INSERT INTO browser_pairs(code_hash, expires, used) VALUES (?, ?, 0)", _hash(code), now + _CODE_TTL)
    return {"code": code, "expires_in": _CODE_TTL}


def claim(code: str) -> dict:
    ensure()
    cleaned = "".join((code or "").split()).upper().replace("—", "-")
    if len(cleaned) == 8 and "-" not in cleaned:
        cleaned = f"{cleaned[:4]}-{cleaned[4:]}"
    row = db.one("SELECT code_hash, expires, used FROM browser_pairs WHERE code_hash = ?", _hash(cleaned))
    if not row or row["used"] or row["expires"] < time.time():
        raise HTTPException(401, "That code has expired or was already used. Make a new one on the computer running Rooks.")
    db.run("UPDATE browser_pairs SET used = 1 WHERE code_hash = ?", row["code_hash"])
    token = secrets.token_urlsafe(32)
    db.run("INSERT INTO browser_tokens(token_hash, created_at) VALUES (?, ?)", _hash(token), db.now())
    return {"token": token}


def bearer_ok(request: Request) -> bool:
    auth = request.headers.get("authorization", "")
    token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    if len(token) < 20:
        return False
    try:
        ensure()
    except Exception:  # noqa: BLE001
        return False
    digest = _hash(token)
    row = db.one("SELECT token_hash, revoked FROM browser_tokens WHERE token_hash = ?", digest)
    if row and not row["revoked"] and hmac.compare_digest(row["token_hash"], digest):
        return True
    # The desktop app's own key (app.json) lets the terminal on this machine talk as the same account.
    app_key = getattr(config, "TOOLS_API_KEY", "") or ""
    return bool(app_key) and len(token) == len(app_key) and hmac.compare_digest(token, app_key)


def status() -> dict:
    computer = bool(getattr(config, "DESK_URL", "") and getattr(config, "DESK_API_KEY", ""))
    browser_agent = bool(getattr(config, "BROWSER_URL", "") and getattr(config, "BROWSER_API_KEY", ""))
    return {
        "computer": computer,
        "browser_agent": browser_agent,
        "files": "this computer" if computer else "the Rooks machine",
        "note": "" if computer else "Chat and memory work here. Using this computer, or files that live only on it, needs the desktop app on that machine.",
    }
