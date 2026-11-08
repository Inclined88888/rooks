"""Sign-in links: how a server install (Docker, a VPS) is opened without typing a PIN.

The desktop app needs none of this; its window signs itself in. A server is reachable over the network, so it stays
locked, but the key is a link instead of a password: setup.sh prints the first one (the SETUP_CODE, good only until
setup is done), and `python -m app.signin` on the server, or Settings on a device already signed in, makes more. Each
link works once and expires. Only a hash of each code is stored.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time

from . import db

TTL = 15 * 60
_KEY = "signin_codes"


def _hash(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


def _load() -> dict[str, float]:
    try:
        raw = json.loads(db.get_setting(_KEY, "") or "{}")
        return {str(k): float(v) for k, v in raw.items()} if isinstance(raw, dict) else {}
    except (ValueError, TypeError):
        return {}


def _save(codes: dict[str, float]) -> None:
    db.set_setting(_KEY, json.dumps(codes))


def make_code(ttl: int = TTL) -> str:
    """A new one-time code, valid for `ttl` seconds."""
    code = secrets.token_urlsafe(24)
    now = time.time()
    codes = {h: exp for h, exp in _load().items() if exp > now}
    codes[_hash(code)] = now + ttl
    _save(codes)
    return code


def take(code: str) -> bool:
    """True once for a live code; the code is spent either way."""
    if not code:
        return False
    now = time.time()
    codes = _load()
    want = _hash(code)
    hit = next((h for h in codes if hmac.compare_digest(h, want)), None)
    ok = hit is not None and codes[hit] > now
    live = {h: exp for h, exp in codes.items() if exp > now and h != hit}
    if live != codes:
        _save(live)
    return ok


def link(base: str, code: str) -> str:
    return f"{base.rstrip('/')}/api/signin?code={code}"


def main() -> None:
    db.init()
    base = os.getenv("PUBLIC_URL") or f"http://localhost:{os.getenv('WORKBENCH_PORT', '3100')}"
    print(link(base, make_code()))
    print(f"Open it within {TTL // 60} minutes. It works once.")


if __name__ == "__main__":
    main()
