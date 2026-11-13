"""One local brain under ~/.rooks — shared home for terminal + Desk/daemon.

Canonical layout (also used by the orchestrator; see orchestrator/src/paths.ts):

  ~/.rooks/
    config/rooks.toml          # terminal settings
    config/rooks-keys.json     # terminal-stored provider keys (mode 600)
    config/terminal-memory.json  # standalone facts when the app is offline
    secrets.env                # daemon secrets (CLI reads as key fallback)
    skills/<id>/SKILL.md       # skills registry Desk + terminal share
    run/app.json               # bridge to the open app/daemon
    run/needs-you/<id>.json    # terminal/browser "Needs you" drop for Desk
    appearance.json            # colour scheme (desktop + terminal themes)
    memory/                    # daemon global memory files
    rooks.db                   # daemon SQLite (rules, learnings, …)

Legacy dual paths (read / one-time migrate, never write as default):
  ~/.config/ai-workspace/…   (Windows: %APPDATA%\\ai-workspace\\…)
  ~/.ai-workspace/appearance.json
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

_MIGRATED: set[str] = set()


def rooks_home() -> Path:
    """`$ROOKS_HOME` when set, else `~/.rooks` — same rule as the orchestrator."""
    env = (os.environ.get("ROOKS_HOME") or "").strip()
    return Path(env).expanduser() if env else Path.home() / ".rooks"


def legacy_config_dir() -> Path:
    if sys.platform == "win32" and os.environ.get("APPDATA"):
        return Path(os.environ["APPDATA"]) / "ai-workspace"
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return Path(base) / "ai-workspace"


def config_dir() -> Path:
    return rooks_home() / "config"


def run_dir() -> Path:
    return rooks_home() / "run"


def skills_dir() -> Path:
    return rooks_home() / "skills"


def secrets_env_path() -> Path:
    return rooks_home() / "secrets.env"


def terminal_memory_path() -> Path:
    return config_dir() / "terminal-memory.json"


def needs_you_dir() -> Path:
    return run_dir() / "needs-you"


def appearance_path() -> Path:
    return rooks_home() / "appearance.json"


def _copy_if_needed(src: Path, dest: Path) -> bool:
    """Copy legacy → new once. Returns True when dest exists afterwards (new or copied)."""
    key = str(dest)
    if dest.exists():
        return True
    if not src.exists():
        return False
    if key in _MIGRATED:
        return dest.exists()
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        _MIGRATED.add(key)
        return True
    except OSError:
        return False


def ensure_migrated_file(canonical: Path, *legacy: Path) -> Path:
    """Prefer canonical; if missing, copy the first existing legacy path onto it."""
    if canonical.exists():
        return canonical
    for old in legacy:
        if _copy_if_needed(old, canonical):
            return canonical
    return canonical


def parse_secrets_env(raw: str) -> dict[str, str]:
    """Minimal KEY=VALUE parser matching orchestrator `parseEnvFile` (no interpolation)."""
    out: dict[str, str] = {}
    for line in raw.lstrip("\ufeff").splitlines():
        trimmed = line.strip()
        if not trimmed or trimmed.startswith("#"):
            continue
        if trimmed.startswith("export "):
            trimmed = trimmed[7:].strip()
        eq = trimmed.find("=")
        if eq <= 0:
            continue
        key = trimmed[:eq].strip()
        if not key or not all(c.isalnum() or c == "_" for c in key):
            continue
        value = trimmed[eq + 1 :].strip()
        if len(value) >= 2 and ((value[0] == value[-1] == '"') or (value[0] == value[-1] == "'")):
            value = value[1:-1]
        out[key] = value
    return out


def secrets_env_keys() -> dict[str, str]:
    try:
        return parse_secrets_env(secrets_env_path().read_text(encoding="utf-8"))
    except OSError:
        return {}


def list_rooks_skills() -> list[dict]:
    """Skills from `~/.rooks/skills/<id>/SKILL.md` — the same registry Desk lists."""
    root = skills_dir()
    if not root.is_dir():
        return []
    out: list[dict] = []
    try:
        names = sorted(p.name for p in root.iterdir() if p.is_dir())
    except OSError:
        return []
    for name in names:
        path = root / name / "SKILL.md"
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        title, description, body = _parse_skill_md(text, name)
        out.append({"name": name, "title": title, "description": description, "steps": body, "path": str(path)})
    return out


def read_rooks_skill(name: str) -> dict | None:
    safe = "".join(c for c in name if c.isalnum() or c in "._:-")
    if not safe or safe != name:
        return None
    path = skills_dir() / safe / "SKILL.md"
    if not path.is_file():
        return None
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    title, description, body = _parse_skill_md(text, safe)
    return {"name": safe, "title": title, "description": description, "steps": body, "path": str(path)}


def _parse_skill_md(text: str, fallback: str) -> tuple[str, str, str]:
    title, description, body = fallback, "", text
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            fm = text[3:end]
            body = text[end + 4 :].lstrip("\n")
            for line in fm.splitlines():
                if ":" not in line:
                    continue
                k, v = line.split(":", 1)
                k, v = k.strip().lower(), v.strip().strip("\"'")
                if k == "name" and v:
                    title = v
                elif k == "description" and v:
                    description = v
    if not description:
        for line in body.splitlines():
            s = line.strip()
            if s and not s.startswith("#"):
                description = s[:200]
                break
    return title, description, body


def write_needs_you(item: dict) -> Path | None:
    """Drop a Needs-you item for Desk/daemon consumers. Best-effort."""
    try:
        d = needs_you_dir()
        d.mkdir(parents=True, exist_ok=True)
        iid = str(item.get("id") or item.get("anchor") or os.urandom(8).hex())
        safe = "".join(c for c in iid if c.isalnum() or c in "._:-")[:80] or os.urandom(4).hex()
        path = d / f"{safe}.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(item, ensure_ascii=False, indent=1), encoding="utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(path)
        return path
    except OSError:
        return None


def clear_needs_you(item_id: str) -> None:
    safe = "".join(c for c in str(item_id) if c.isalnum() or c in "._:-")[:80]
    if not safe:
        return
    try:
        p = needs_you_dir() / f"{safe}.json"
        if p.is_file():
            p.unlink()
    except OSError:
        pass


def daemon_api() -> tuple[str, str] | None:
    """`(base_url, bearer)` for the local daemon when discoverable, else None."""
    url = (os.environ.get("ROOKS_API") or "").rstrip("/")
    token = (os.environ.get("ROOKS_API_TOKEN") or "").strip()
    if not token:
        try:
            token = (rooks_home() / "daemon-token").read_text(encoding="utf-8").strip()
        except OSError:
            token = ""
    if url and token:
        return url, token
    # app.json may point at the desktop's local API (same machine).
    try:
        from . import config as cfg
        link = cfg.app_link()
        if link.get("url") and link.get("key"):
            return str(link["url"]).rstrip("/"), str(link["key"])
    except Exception:
        pass
    return None


def notify_desk_needs_you(*, title: str, body: str, anchor: str, source: str = "terminal") -> str | None:
    """Surface a Needs-you item in the Desk notification centre when the daemon is up.

    Always writes the drop file. Also POSTs `/api/notifications` when auth is available.
    Returns the notification id when the HTTP path succeeded.
    """
    write_needs_you({
        "id": anchor,
        "anchor": anchor,
        "kind": "approval",
        "title": title,
        "detail": body[:4000],
        "source": source,
        "status": "pending",
    })
    api = daemon_api()
    if not api:
        return None
    base, token = api
    import urllib.error
    import urllib.request

    payload = json.dumps({
        "type": "action_required",
        "urgent": True,
        "title": title[:200],
        "body": body[:4000],
        "anchor": anchor,
        "ttl_minutes": 60,
        "dismiss_on": [],
    }).encode()
    req = urllib.request.Request(
        f"{base}/api/notifications",
        data=payload,
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as r:  # noqa: S310 — local daemon
            data = json.loads(r.read() or b"{}")
        nid = (data.get("notification") or {}).get("id")
        return str(nid) if nid else None
    except (OSError, ValueError, urllib.error.URLError):
        return None


def dismiss_desk_needs_you(anchor: str) -> None:
    clear_needs_you(anchor)
    api = daemon_api()
    if not api:
        return
    base, token = api
    import urllib.error
    import urllib.request

    # Best-effort: list + dismiss matching anchor (no dedicated dismiss-by-anchor route for externals).
    try:
        req = urllib.request.Request(
            f"{base}/api/notifications?limit=50",
            headers={"Authorization": f"Bearer {token}"},
        )
        with urllib.request.urlopen(req, timeout=3) as r:  # noqa: S310
            rows = json.loads(r.read() or b"{}").get("notifications") or []
        for n in rows:
            if n.get("anchor") == anchor and n.get("id"):
                dreq = urllib.request.Request(
                    f"{base}/api/notifications/{n['id']}/dismiss",
                    data=b"{}",
                    method="POST",
                    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                )
                try:
                    urllib.request.urlopen(dreq, timeout=3).close()  # noqa: S310
                except (OSError, urllib.error.URLError):
                    pass
    except (OSError, ValueError, urllib.error.URLError):
        pass
