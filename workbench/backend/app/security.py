from __future__ import annotations
import base64
import hashlib
import hmac
import json
import logging
import secrets
import time

from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException, Request

from . import config, db

log = logging.getLogger("workbench.security")

COOKIE = "wb_session"

def set_session_cookie(response, token: str) -> None:
    """Set session cookie with security flags (AIW-002)."""
    response.set_cookie(
        COOKIE,
        token,
        secure=config.COOKIE_SECURE,
        httponly=True,
        samesite="lax",
        max_age=config.SESSION_DAYS * 86400,
        path="/",
    )
_fernet = Fernet(base64.urlsafe_b64encode(hashlib.sha256(b"enc:" + config.APP_SECRET.encode()).digest()))
_sign_key = hashlib.sha256(b"sig:" + config.APP_SECRET.encode()).digest()


# Passwords (scrypt, stdlib)
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**15, r=8, p=1, maxmem=64 * 1024 * 1024)
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, salt, digest = stored.split("$")
        test = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=2**15, r=8, p=1, maxmem=64 * 1024 * 1024)
        return hmac.compare_digest(test.hex(), digest)
    except ValueError:
        return False


# Secrets at rest
def encrypt(value: str) -> str:
    return _fernet.encrypt(value.encode()).decode() if value else ""


def decrypt(value: str) -> str:
    if not value:
        return ""
    from . import keychain

    if keychain.is_ref(value):
        return keychain.get(value)
    try:
        return _fernet.decrypt(value.encode()).decode()
    except InvalidToken:
        # APP_SECRET changed since this was stored; the credential must be re-entered.
        return ""


def seal(name: str, value: str) -> str:
    """What to keep in the database for a secret: a keychain reference when the desktop app enabled the keychain
    and it accepts the item, else the Fernet ciphertext. A refused keychain never loses the secret."""
    from . import keychain

    if value and keychain.enabled():
        try:
            return keychain.put(name, value)
        except Exception as e:  # noqa: BLE001 - a refused keychain must not lose the key or stop the app starting
            log.warning("Keychain refused %s (%s); keeping it encrypted in the database", name, e.__class__.__name__)
    return encrypt(value)


_REF_COLUMNS = (("connections", "secret_enc"), ("linked_accounts", "secret_enc"), ("sites", "secret_enc"),
                ("vault_items", "secret_ref"))


def migrate_keychain_refs() -> int:
    """With the keychain switched off (an ad hoc signed desktop build, see desktop/sidecar), move every secret still
    kept as a keychain reference into the encrypted database, so macOS asks at most once and never again. A secret
    the keychain will not give back (denied, deleted) is left as it was. Returns how many were moved."""
    from . import keychain

    if keychain.enabled():
        return 0
    moved = 0
    for table, col in _REF_COLUMNS:
        try:
            rows = db.all(f"SELECT id, {col} AS ref FROM {table} WHERE {col} LIKE 'keychain:%'")
        except Exception:  # noqa: BLE001 - the table is not there in this install
            continue
        for r in rows:
            value = keychain.get(r["ref"])
            if value:
                db.run(f"UPDATE {table} SET {col} = ? WHERE id = ?", encrypt(value), r["id"])
                moved += 1
    if moved:
        log.info("Moved %d secrets from the keychain into the encrypted database", moved)
    return moved


def store_connection_secret(cid: int, value: str) -> None:
    """Save a model connection's key: in the OS keychain when the desktop app enabled it, else encrypted in SQLite."""
    from . import keychain

    old = db.one("SELECT secret_enc FROM connections WHERE id = ?", cid)
    if old and keychain.is_ref(old["secret_enc"]) and not value:
        keychain.delete(old["secret_enc"])
    db.run("UPDATE connections SET secret_enc = ? WHERE id = ?", seal(f"connection:{cid}", value), cid)


def forget_connection_secret(stored: str) -> None:
    from . import keychain

    keychain.delete(stored)


# Sessions: signed, expiring token. Changing the password bumps the generation and logs out all sessions.
def _sign(payload: bytes) -> str:
    return base64.urlsafe_b64encode(hmac.new(_sign_key, payload, hashlib.sha256).digest()).decode().rstrip("=")


def make_session() -> str:
    gen = db.get_setting("session_generation", "1")
    payload = base64.urlsafe_b64encode(
        json.dumps({"exp": int(time.time()) + config.SESSION_DAYS * 86400, "gen": gen}).encode()
    ).decode()
    return f"{payload}.{_sign(payload.encode())}"


def check_session(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    payload, sig = token.rsplit(".", 1)
    if not hmac.compare_digest(sig, _sign(payload.encode())):
        return False
    try:
        data = json.loads(base64.urlsafe_b64decode(payload.encode()))
    except ValueError:
        return False
    return data.get("exp", 0) > time.time() and data.get("gen") == db.get_setting("session_generation", "1")


def require_user(request: Request) -> None:
    if check_session(request.cookies.get(COOKIE)):
        return
    from . import surfaces

    if surfaces.bearer_ok(request):
        return
    raise HTTPException(status_code=401, detail="Not signed in")


def _bearer_token(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    return auth[7:].strip() if auth.lower().startswith("bearer ") else ""


def check_cli_token(token: str) -> bool:
    """The Terminal access token (Settings > Terminal access); stored only as a hash."""
    stored = db.get_setting("cli_token_hash", "") or ""
    return bool(token) and bool(stored) and hmac.compare_digest(hashlib.sha256(token.encode()).hexdigest(), stored)


def check_bridge_key(token: str) -> bool:
    """The /v1 bridge keys: the app.json key (BROWSER_API_KEY in the desktop app), Rooks Desk's, and the coding jobs' one."""
    keys = [k for k in (config.BROWSER_API_KEY, config.DESK_API_KEY, config.CODING_BRIDGE_KEY) if k]
    return bool(token) and any(hmac.compare_digest(token, k) for k in keys)


def is_coding_job_key(token: str) -> bool:
    """The key coding jobs the app starts are given (cli_agents.coding_bridge_key). It is always its own key."""
    key = config.CODING_BRIDGE_KEY or ""
    return bool(token) and bool(key) and hmac.compare_digest(token, key)


def is_signed_in(request: Request) -> bool:
    """The person themselves: a session cookie, or a browser they paired. Never a bearer key a program could read."""
    try:
        require_user(request)
        return True
    except HTTPException:
        return False


def require_user_or_terminal(request: Request) -> None:
    """The signed in user, or the rooks terminal on this computer with its own key: only for the Workroom routes the
    terminal's /room, /needs and /jobs use (room status/up/down/run, Needs you, the Jobs board). The Terminal access
    token works as it does for chat; a bridge key only with the terminal's channel header, since the browser and desk
    helpers hold the same key and must not answer Needs you for themselves. Writes still need X-Workbench (main.guard)."""
    try:
        require_user(request)
        return
    except HTTPException:
        pass
    token = _bearer_token(request)
    if check_cli_token(token):
        return
    # A bridge key only reads. Coding jobs the app starts hold the same key, so if it could write, an unattended job
    # (or its model through its shell) could approve its own request in Needs you or run in the Room without a yes.
    # Answering and acting need the Terminal access token, which a person creates, or a signed in session.
    if (request.method == "GET" and request.headers.get("x-workbench-channel") == "rooks-code"
            and check_bridge_key(token) and not is_coding_job_key(token)):
        return
    raise HTTPException(status_code=401, detail="Not signed in")


def check_bearer(request: Request) -> bool:
    auth = request.headers.get("authorization", "")
    token = auth[7:] if auth.lower().startswith("bearer ") else ""
    return bool(token) and hmac.compare_digest(token, config.TOOLS_API_KEY)


def check_native_key(request: Request) -> bool:
    """The native Rooks window's own sign in key (NATIVE_SIGNIN_KEY). The sidecar writes it only to native.json, which
    only the window reads; it is never put in app.json, in a helper's or a coding job's environment, or accepted as a
    bearer anywhere. It is good for one thing: minting a session cookie at /api/desktop/local-session on loopback."""
    key = getattr(config, "NATIVE_SIGNIN_KEY", "") or ""
    token = _bearer_token(request)
    return bool(key) and len(token) >= 20 and len(token) == len(key) and hmac.compare_digest(token, key)


# The app's own secrets. No child process the app starts (coding jobs, model CLIs, MCP servers, helpers) inherits
# them: a background agent holding one could sign in as the person, forge a session or approve its own request.
APP_SECRET_ENV = ("APP_SECRET", "TOOLS_API_KEY", "BROWSER_API_KEY", "DESK_API_KEY", "CODING_BRIDGE_KEY",
                  "NATIVE_SIGNIN_KEY", "WORKBENCH_DESKTOP_TOKEN", "TRY_API_KEY", "ROOKS_TRY_API_KEY",
                  "ROOKS_BROWSER_TOKEN", "ROOKS_DESK_TOKEN", "WORKBENCH_API_KEY", "BRIDGE_API_KEY")


def scrub_env(env) -> dict:
    """A copy of env without the app's own secrets; the caller adds back the one key a child is meant to have."""
    return {k: v for k, v in env.items() if k not in APP_SECRET_ENV}


def require_tool_key(request: Request) -> None:
    if not check_bearer(request):
        raise HTTPException(401, "Invalid tool API key")


# Login throttling (per client IP, in memory)
_attempts: dict[str, list[float]] = {}


def throttle(ip: str) -> None:
    window = [t for t in _attempts.get(ip, []) if t > time.time() - 300]
    _attempts[ip] = window
    if len(window) >= 10:
        raise HTTPException(429, "Too many attempts. Wait a few minutes.")
    window.append(time.time())
