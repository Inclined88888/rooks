"""Files in the Room (design 0006, sections 3.2 and 6): what is in the Room's folder, read only.

The listing works whether the Room is on or off (the folder is there either way, which is the answer to "it reset":
nothing was wiped). A path is resolved and must stay inside the Room's home; a link that leads outside it, or nowhere,
is listed as "link" and never followed. Nothing here changes a file.

`can` says what this Room can do on this computer, for status: a terminal (in process, POSIX, terminals not switched
off in Settings, and a driver that gives a shell here) and Files (a driver whose folder is on this computer).
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

OUTSIDE = "That is outside the Room."
GONE = "That folder is gone."
NOT_A_FOLDER = "That is a file, not a folder."
UNREADABLE = "That folder could not be read."
NOT_HERE = "Files live inside the separate computer."
ROOT_LABEL = "Home"
MAX_ENTRIES = 500
FOLDER_DRIVERS = {"shell", "nested"}  # the Room's folder is on this computer; a separate computer keeps its own


def can(driver, remote: bool) -> dict:
    """What this Room can offer here. Both false through a helper (TRY_URL): its terminals are not hosted yet."""
    if remote or driver is None:
        return {"terminal": False, "files": False}
    from . import terminal_pty

    files = getattr(driver, "name", "") in FOLDER_DRIVERS
    terminal = False
    if os.name == "posix" and terminal_pty.enabled():
        try:
            from rooks_try import store

            terminal = driver.terminal_argv(store.guest_home()) is not None
        except Exception:  # noqa: BLE001 - a driver that cannot say has no terminal
            terminal = False
    return {"terminal": terminal, "files": files}


def _when(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _inside(path: Path, home: Path) -> bool:
    return path == home or home in path.parents


def _entry(entry: os.DirEntry, home: Path) -> dict:
    name = entry.name
    try:
        if entry.is_symlink():
            st = entry.stat(follow_symlinks=False)
            try:
                target = Path(entry.path).resolve(strict=True)
            except (OSError, RuntimeError):
                target = None
            if target is None or not _inside(target, home):  # broken, or leads outside: listed, never followed
                return {"name": name, "kind": "link", "size": None, "modified": _when(st.st_mtime)}
            st = target.stat()
            folder = target.is_dir()
        else:
            st = entry.stat(follow_symlinks=False)
            folder = entry.is_dir(follow_symlinks=False)
    except OSError:
        return {"name": name, "kind": "file", "size": None, "modified": None}
    if folder:
        return {"name": name, "kind": "folder", "size": None, "modified": _when(st.st_mtime)}
    return {"name": name, "kind": "file", "size": st.st_size, "modified": _when(st.st_mtime)}


def _order(e: dict) -> tuple:
    """Folders first, then files and links, A to Z; dotfiles last (shown: the Room's .profile must be visible)."""
    return (e["name"].startswith("."), e["kind"] != "folder", e["name"].lower(), e["name"])


def listing(path: str = "") -> dict:
    """One folder of the Room's home. Blocking (a big folder takes a moment): routes call it in a worker thread."""
    from rooks_try import store

    home = store.guest_home().resolve()
    raw = str(path or "").strip()
    try:
        target = (home / raw).resolve() if raw else home
    except (OSError, RuntimeError) as e:  # a link loop
        raise HTTPException(400, OUTSIDE) from e
    if not _inside(target, home):
        raise HTTPException(400, OUTSIDE)
    if not target.exists():
        raise HTTPException(404, GONE)
    if not target.is_dir():
        raise HTTPException(400, NOT_A_FOLDER)
    try:
        with os.scandir(target) as it:
            entries = [_entry(e, home) for e in it]
    except OSError as e:
        raise HTTPException(400, UNREADABLE) from e
    entries.sort(key=_order)
    rel = "" if target == home else target.relative_to(home).as_posix()
    parent = None if target == home else ("" if target.parent == home else target.parent.relative_to(home).as_posix())
    return {"path": rel, "parent": parent, "root_label": ROOT_LABEL, "entries": entries[:MAX_ENTRIES],
            "truncated": len(entries) > MAX_ENTRIES}
