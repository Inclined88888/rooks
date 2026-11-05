"""Provider keys in the operating system keychain (desktop app only).

When WORKBENCH_SECRET_BACKEND=keychain (set by the desktop shell), an API key is written to the OS keychain
(macOS Keychain, Windows Credential Manager, Secret Service on Linux) and the database stores only a reference,
"keychain:<name>". The Docker install never sets it and keeps Fernet encryption under APP_SECRET.

The `keyring` package is imported lazily so the Docker image does not need it.
"""

import logging
import threading

from . import config

SERVICE = "ai-workspace"
PREFIX = "keychain:"
log = logging.getLogger("workbench.keychain")
_lock = threading.Lock()
_cache: dict[str, str] = {}
_sealed = False


def _keyring():
    try:
        import keyring
        from keyring.backends import fail
    except ImportError:
        return None
    kr = keyring.get_keyring()
    if isinstance(kr, fail.Keyring):
        return None
    return keyring


def enabled() -> bool:
    return config.SECRET_BACKEND == "keychain" and _keyring() is not None


def backend_name() -> str:
    """What protects provider keys, for the status page: "os-keychain" or "encrypted-db"."""
    return "os-keychain" if enabled() else "encrypted-db"


def is_ref(value: str) -> bool:
    return bool(value) and value.startswith(PREFIX)


def seal() -> None:
    """Stop talking to the OS keychain for the rest of this run.

    An ad hoc signed desktop app cannot keep "Always Allow". Each later read opens the
    password box again. After secrets have been copied into the database, seal it.
    """
    global _sealed
    with _lock:
        _sealed = True


def unseal() -> None:
    """Test helper. The desktop app does not call this."""
    global _sealed
    with _lock:
        _sealed = False
        _cache.clear()


def put(name: str, secret: str) -> str:
    """Store a secret and return the reference to keep in the database."""
    with _lock:
        if _sealed:
            raise RuntimeError("No OS keychain is available")
    kr = _keyring()
    if kr is None:
        raise RuntimeError("No OS keychain is available")
    try:
        kr.set_password(SERVICE, name, secret)
    except Exception:  # noqa: BLE001 - macOS -25244/-25299: an item left by an older build, owned by another binary
        try:
            kr.delete_password(SERVICE, name)
        except Exception:  # noqa: BLE001 - nothing to remove, or not ours to remove
            pass
        kr.set_password(SERVICE, name, secret)
    with _lock:
        _cache[name] = secret
    return PREFIX + name


def get(ref: str) -> str:
    if not is_ref(ref):
        return ""
    name = ref[len(PREFIX):]
    with _lock:
        if name in _cache:
            return _cache[name]
        if _sealed:
            return ""
        kr = _keyring()
        value = ""
        if kr is not None:
            try:
                value = kr.get_password(SERVICE, name) or ""
            except Exception:  # noqa: BLE001 - a locked or missing keychain reads as "key must be re-entered"
                log.warning("Keychain read failed for %s", name)
                value = ""
        # Remember the answer, including a refusal, so the password box is not opened again this run.
        _cache[name] = value
        return value


def delete(ref: str) -> None:
    if not is_ref(ref):
        return
    name = ref[len(PREFIX):]
    with _lock:
        _cache.pop(name, None)
        if _sealed:
            return
    kr = _keyring()
    if kr is None:
        return
    try:
        kr.delete_password(SERVICE, name)
    except Exception:  # noqa: BLE001 - already gone
        pass
