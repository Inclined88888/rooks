"""Where the Try Room keeps its private home, checkpoints and config."""

from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path


def root() -> Path:
    override = os.environ.get("ROOKS_TRY_HOME", "").strip()
    if override:
        path = Path(override).expanduser()
    else:
        path = Path.home() / ".ai-workspace" / "try-room"
    path.mkdir(parents=True, exist_ok=True)
    return path


def guest_home() -> Path:
    path = root() / "home"
    path.mkdir(parents=True, exist_ok=True)
    return path


def work_dir() -> Path:
    path = root() / "work"
    path.mkdir(parents=True, exist_ok=True)
    return path


def checkpoints_dir() -> Path:
    path = root() / "checkpoints"
    path.mkdir(parents=True, exist_ok=True)
    return path


def state_path() -> Path:
    return root() / "state.json"


def load_state() -> dict:
    path = state_path()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(data: dict) -> None:
    path = state_path()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True))
    tmp.replace(path)


def checkpoint(label: str = "") -> dict:
    """Copy the guest home into a named restore point."""
    stamp = time.strftime("%Y%m%dT%H%M%S")
    name = f"{stamp}-{_safe(label) or 'save'}"
    dest = checkpoints_dir() / name
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(guest_home(), dest, symlinks=True, dirs_exist_ok=False)
    meta = {"name": name, "label": label or "save", "created": stamp, "path": str(dest)}
    state = load_state()
    state["last_checkpoint"] = meta
    save_state(state)
    return meta


def restore(name: str | None = None) -> dict:
    """Replace the guest home with a checkpoint. Latest if name is empty."""
    state = load_state()
    if not name:
        name = (state.get("last_checkpoint") or {}).get("name")
    if not name:
        raise FileNotFoundError("No checkpoint yet. Run rooks-try checkpoint first.")
    src = checkpoints_dir() / name
    if not src.is_dir():
        raise FileNotFoundError(f"Checkpoint {name} is missing.")
    home = guest_home()
    backup = root() / "home.before-reset"
    if backup.exists():
        shutil.rmtree(backup)
    if home.exists():
        home.rename(backup)
    shutil.copytree(src, home, symlinks=True)
    if backup.exists():
        shutil.rmtree(backup)
    meta = {"name": name, "restored": True}
    state["last_restore"] = meta
    save_state(state)
    return meta


def list_checkpoints() -> list[dict]:
    out = []
    for path in sorted(checkpoints_dir().iterdir(), reverse=True):
        if path.is_dir():
            out.append({"name": path.name, "path": str(path)})
    return out


def _safe(label: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "-" for c in (label or "")[:40]).strip("-")
