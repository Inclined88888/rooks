"""Files in the Room (design 0006, sections 3.2 and 6): what is in the Room's folder, read only.

The listing works whether the Room is on or off (the folder is there either way, which is the answer to "it reset":
nothing was wiped). A path is resolved and must stay inside the Room's home; a link that leads outside it, or nowhere,
is listed as "link" with why ("outside" or "broken") and never followed. The folder is then opened one name at a time
from the Room's home without following a link, so a folder a Room program swaps for a link after the check is refused,
not listed. Nothing here changes a file.

`can` says what this Room can do on this computer, for status: a terminal (in process, POSIX, terminals not switched
off in Settings, and a driver that gives a shell here) and Files (a driver whose folder is on this computer), and why
there is no terminal when there is a reason to give ("switched_off", "helper", "windows").
"""

from __future__ import annotations

import errno
import os
import stat
import sys
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
    """What this Room can offer here, and why there is no terminal. Through a helper (TRY_URL) neither: its terminals are
    not hosted yet. A driver with no shell of its own (a separate computer, a drawing) gives no reason: use its screen."""
    if remote:
        return {"terminal": False, "files": False, "terminal_off_reason": "helper"}
    if driver is None:
        return {"terminal": False, "files": False, "terminal_off_reason": None}
    from . import terminal_pty

    files = getattr(driver, "name", "") in FOLDER_DRIVERS
    windows = sys.platform == "win32"
    if windows and not terminal_pty.available():  # Windows older than 10 1809: no pseudo console
        return {"terminal": False, "files": files, "terminal_off_reason": "windows" if files else None,
                "terminal_shells": []}
    try:
        from rooks_try import store

        shell = driver.terminal_argv(store.guest_home()) is not None
    except Exception:  # noqa: BLE001 - a driver that cannot say has no terminal
        shell = False
    kinds: list[str] = []
    if windows and shell:  # PowerShell, and Git Bash when Git for Windows is there (the New terminal menu)
        try:
            kinds = list(driver.terminal_shells())
        except Exception:  # noqa: BLE001
            kinds = ["powershell"]
    if shell and not terminal_pty.enabled():
        return {"terminal": False, "files": files, "terminal_off_reason": "switched_off", "terminal_shells": []}
    return {"terminal": shell, "files": files, "terminal_off_reason": None, "terminal_shells": kinds}


def _when(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _inside(path: Path, home: Path) -> bool:
    return path == home or home in path.parents


def _entry(entry: os.DirEntry, home: Path, folder: Path) -> dict:
    name = entry.name
    try:
        if entry.is_symlink():
            st = entry.stat(follow_symlinks=False)
            try:
                target = (folder / name).resolve(strict=True)
            except (OSError, RuntimeError):
                target = None
            if target is None or not _inside(target, home):  # broken, or leads outside: listed, never followed
                return {"name": name, "kind": "link", "why": "broken" if target is None else "outside", "size": None,
                        "modified": _when(st.st_mtime)}
            st = target.stat()
            is_folder = target.is_dir()
        else:
            st = entry.stat(follow_symlinks=False)
            is_folder = entry.is_dir(follow_symlinks=False)
    except OSError:
        return {"name": name, "kind": "file", "size": None, "modified": None}
    if is_folder:
        return {"name": name, "kind": "folder", "size": None, "modified": _when(st.st_mtime)}
    return {"name": name, "kind": "file", "size": st.st_size, "modified": _when(st.st_mtime)}


def _order(e: dict) -> tuple:
    """Folders first, then files and links, A to Z; dotfiles last (shown: the Room's .profile must be visible)."""
    return (e["name"].startswith("."), e["kind"] != "folder", e["name"].lower(), e["name"])


def _open_beneath(home: Path, target: Path) -> int | None:
    """The checked folder, opened from the Room's home one name at a time without following a link (a name swapped for
    a link after the check is refused), then checked again by where the open folder really is. None where the system
    cannot list an open folder (Windows): the checked path is listed as before."""
    if os.name != "posix" or os.scandir not in os.supports_fd or not hasattr(os, "O_NOFOLLOW"):
        return None
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    fd = os.open(home, flags)
    try:
        for part in target.relative_to(home).parts:
            try:
                nfd = os.open(part, flags | os.O_NOFOLLOW, dir_fd=fd)
            except OSError as e:
                raise _refusal(fd, part, e) from e
            os.close(fd)
            fd = nfd
        where = f"/proc/self/fd/{fd}"
        if os.path.exists(where) and not _inside(Path(os.path.realpath(where)), home):
            raise HTTPException(400, OUTSIDE)
        return fd
    except BaseException:
        os.close(fd)
        raise


def _refusal(dir_fd: int, name: str, e: OSError) -> HTTPException:
    """Why a name could not be opened as a folder: a link (outside, as far as the listing goes), gone, or a file."""
    try:
        st = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    except OSError:
        return HTTPException(404, GONE)
    if stat.S_ISLNK(st.st_mode) or e.errno == errno.ELOOP:
        return HTTPException(400, OUTSIDE)
    if not stat.S_ISDIR(st.st_mode):
        return HTTPException(400, NOT_A_FOLDER)
    return HTTPException(400, UNREADABLE)


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
    try:
        fd = _open_beneath(home, target)
    except OSError as e:
        raise HTTPException(400, UNREADABLE) from e
    try:
        if fd is None:
            if not target.exists():
                raise HTTPException(404, GONE)
            if not target.is_dir():
                raise HTTPException(400, NOT_A_FOLDER)
        try:
            with os.scandir(target if fd is None else fd) as it:
                entries = [_entry(e, home, target) for e in it]
        except OSError as e:
            raise HTTPException(400, UNREADABLE) from e
    finally:
        if fd is not None:
            os.close(fd)
    entries.sort(key=_order)
    rel = "" if target == home else target.relative_to(home).as_posix()
    parent = None if target == home else ("" if target.parent == home else target.parent.relative_to(home).as_posix())
    return {"path": rel, "parent": parent, "root_label": ROOT_LABEL, "entries": entries[:MAX_ENTRIES],
            "truncated": len(entries) > MAX_ENTRIES}
