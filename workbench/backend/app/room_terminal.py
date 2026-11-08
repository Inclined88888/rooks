"""The Room's terminals (design 0006, section 4.1): real login shells inside the Room that live on the server.

A Room terminal is the Room's login shell (rooks_try's `login_argv`: its own home, its profile and PATH, its private
mount namespace when there is one) on a pseudo terminal. Unlike the app's own terminal (terminal_pty.py), the shell is
not owned by a WebSocket: this module keeps it. Leaving the page, or a reload, keeps the shell; attaching again replays
its last 256 KiB as one scrollback frame, then streams. Nothing here has a time limit.

Each terminal has a reader thread (not the event loop's add_reader: the chat tool and the routes may run on different
loops, and a shell must outlive any one of them). It appends the output to a ring and to a log in the Room's work
folder (0600, in a 0700 folder: the person's alone), forwards it to the one attached socket (one that falls behind gets
a fresh scrollback frame instead of a growing queue), and cuts out the invisible exit code marker the Room's profile
prints after each command (ESC ] 7777 ; code ; nonce BEL, with this terminal's own nonce so nothing a command prints
can pass for it), which is how the server knows a started command has ended and how. A shell that exits while a job
still holds its terminal ends the terminal and the job is hung up. A command Rooks starts is one line.

Who may attach: terminal_pty's rules (signed in, same origin, loopback peer and page, terminals not switched off in
Settings). What is recorded in the run log (channel room, tool use_room): opening and closing a terminal, every command
Rooks starts and how it ended, every line sent through the send route (the phone row, /room send; only its length when
the terminal was waiting for hidden input, a password prompt), and one coarse "You used the terminal for N min" row
when a socket that typed detaches. Keystrokes over the socket are never recorded. tail gives plain text: no escape
sequences reach the model or the rooks terminal.

At most four Room terminals, live or ended, counted apart from the app terminal's six. Stop closes them (the ended ones
stay listed, greyed, with their text); Start over closes and forgets them. When the app exits, every live shell is hung
up and its record says "restart"; the next start lists it as ended with its log as its text (load_ended), and the
restart note in a cut-off chat says so once (ended_at_restart).
"""

from __future__ import annotations

import asyncio
import atexit
import codecs
import json
import logging
import os
import re
import select
import shutil
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket

from . import terminal_pty
from .room import TERMINAL_MAX
from .security import require_user, require_user_or_terminal, scrub_env

log = logging.getLogger("room.terminal")

# The routes: the rooks terminal's key reaches what /room open, tail, send and close use (a bridge key only reads);
# taking a terminal and naming it are the person's. The socket checks terminal_pty's rules itself.
terminal = APIRouter(prefix="/api/room", dependencies=[Depends(require_user_or_terminal)])
router = APIRouter(prefix="/api/room", dependencies=[Depends(require_user)])
sockets = APIRouter()

MAX = TERMINAL_MAX  # live or ended, counted apart from terminal_pty._open (the app terminal's six)
RING_MAX = 256 * 1024
LOG_MAX = 2 * 1024 * 1024
LOG_KEEP = 1024 * 1024
PROMPT_WAIT_S = 5.0     # a started command waits for the shell's first prompt this long
DONE_LINES = 20
TAIL_DEFAULT, TAIL_MAX = 200, 2000
COLS, ROWS = 80, 24

FULL = "Four terminals are in the Room, ended ones included. Close one to open another."
ONE_LINE = "Start one line at a time. Join the steps with && on one line."
THEIRS = "That terminal is the person's own, so Rooks does not read it. They can hand it to Rooks first."
HIDDEN_LINE = "(a line was sent, {n} characters)"
OFF = "The Room is off. Start it first."
NOT_INSTALLED = "The Room is not installed on this computer."
NO_TERMINAL = "This Room has no terminal of its own. Use its screen."
SWITCHED_OFF = "Terminals are switched off in Settings."
NO_SUCH = "No such terminal."
ENDED = "This terminal has ended."
ROOKS_BUSY = "Rooks is working in that terminal. Take it first, or open your own."
DID_NOT_START = "The terminal could not start in the Room."
BAD_NAME = "A terminal's name is 1 to 40 characters."
TAKEN_NOTE = "The person took this terminal; what it prints now is theirs."
STARTED_NOTE = "Started in the Room's terminal. Use tail to see how it goes."
NOTHING_STARTED = "Rooks has not started anything in a Room terminal yet."
# WebSocket close reasons (design 0006, section 6)
WS_OFF = "Terminals are switched off in Settings or not available on this system"
WS_NOT_LOCAL = "The terminal only opens on the computer running Rooks"
WS_NO_SUCH = "No such terminal"
WS_ENDED = "This terminal has ended"
ELSEWHERE = "This terminal was opened in another window."
EXITED = "The shell exited"

QUEUE_MAX = RING_MAX     # output queued for one socket; past this the socket gets a fresh scrollback frame instead

# The exit code marker the Room's profile prints at each prompt: ESC ] 7777 ; code ; nonce BEL, the nonce this
# terminal's own (ROOKS_MARK in its environment, kept unexported by the profile), so what a command prints cannot end
# it. A profile seeded before the nonce prints ESC ] 7777 ; code BEL: read while the terminal has never shown a nonce.
_MARK = re.compile(rb"\x1b\]7777;(-?\d{0,6})(?:;([0-9a-f]{0,64}))?\x07")
_MARK_HEAD = b"\x1b]7777;"
_MARK_PART = re.compile(rb"\x1b\]7777;-?\d{0,6}(?:;[0-9a-f]{0,64})?")
# What tail gives is plain text (the model and the rooks terminal read it): escape sequences out, carriage returns
# settled. CSI; OSC, DCS, APC, PM and SOS strings to their end; two and three byte escapes; a lone ESC; C1 controls.
_ESCAPES = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]P_^X][^\x07\x1b]*(?:\x07|\x1b\\?|$)|\x1b[ -/]*[0-~]|\x1b$"
                      r"|[\x80-\x9f]")
_CONTROLS = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def plain(text: str) -> str:
    """A terminal's text as plain lines: no escape sequences (a program in the Room cannot retitle, switch modes in or
    write the clipboard of whoever reads it), carriage returns settled the way a screen shows them."""
    text = _ESCAPES.sub("", text).replace("\r\n", "\n")
    lines = []
    for line in text.split("\n"):
        if "\r" in line:
            shown = ""
            for part in line.split("\r"):  # a later write starts at the left and covers what it is as long as
                shown = part + shown[len(part):]
            line = shown
        lines.append(_CONTROLS.sub("", line))
    return "\n".join(lines)


def _private(path: Path, mode: str = "w"):
    """A file only the person can read (0600), opened for writing ("w", "wb" or "ab")."""
    flags = os.O_WRONLY | os.O_CREAT | (os.O_APPEND if "a" in mode else os.O_TRUNC)
    fd = os.open(path, flags, 0o600)
    try:
        os.fchmod(fd, 0o600)  # one an earlier version wrote with the default mode
    except (OSError, AttributeError):
        pass
    return os.fdopen(fd, mode)


@dataclass
class RoomTerminal:
    id: str
    name: str
    owner: str                      # "person" | "rooks": who types here now
    starter: str                    # who opened it
    started: str                    # ISO
    started_ts: float
    log: Path
    meta: Path
    shell: str = ""
    proc: subprocess.Popen | None = None
    master: int | None = None
    cols: int = COLS
    rows: int = ROWS
    ring: bytearray = field(default_factory=bytearray)
    total: int = 0                  # bytes ever written to the ring
    command: str | None = None      # what Rooks typed (owner rooks), redacted
    command_ts: float | None = None
    command_mono: float | None = None
    command_mark: int = 0           # self.total when the command was typed
    command_code: int | None = None
    done_ts: float | None = None
    pending: bool = False           # a started command has not reported its end yet
    prompts: int = 0                # exit code markers seen (0 until the first prompt)
    last_code: int | None = None
    taken: bool = False             # the person took this terminal from Rooks
    ended: bool = False
    ended_reason: str | None = None  # "closed" | "stop" | "start over" | "exited" | "restart"
    ended_ts: float | None = None
    exit_code: int | None = None
    restart_seen: bool = False
    run: str = ""
    attached: _Socket | None = None  # the one socket attached: its queue, its loop, what waits in the queue
    lock: threading.RLock = field(default_factory=threading.RLock)
    stop: threading.Event = field(default_factory=threading.Event)
    reader: threading.Thread | None = None
    decoder: codecs.IncrementalDecoder = field(default_factory=lambda: codecs.getincrementaldecoder("utf-8")("replace"))
    carry: bytes = b""
    log_fh: object | None = None
    log_size: int = 0
    last_out: float = 0.0           # monotonic time of the last output
    nonce: str = field(default_factory=lambda: uuid.uuid4().hex)  # what this terminal's own exit code markers carry
    nonce_seen: bool = False        # its profile prints the nonce: a marker without it is not the shell's

    # --- what it is now -------------------------------------------------------------------------------------------------
    @property
    def alive(self) -> bool:
        return not self.ended

    def busy(self) -> bool:
        """A foreground program runs (the pty's foreground process group is not the shell's), or a command Rooks
        started has not reported its end."""
        if self.ended or self.master is None or self.proc is None:
            return False
        if self.pending:
            return True
        try:
            return os.tcgetpgrp(self.master) != self.proc.pid
        except OSError:
            return False

    def code(self) -> int | None:
        if self.ended:
            return self.exit_code
        if self.busy():
            return None
        if self.command is not None:
            return self.command_code
        return self.last_code if self.prompts > 1 else None

    def elapsed(self) -> int:
        if self.command_ts is not None:
            return int((self.done_ts or (self.ended_ts if self.ended else None) or time.time()) - self.command_ts)
        return int((self.ended_ts or time.time()) - self.started_ts)

    def text(self) -> str:
        """The ring as text, without a character cut by a read: its first bytes at the end (the decoder holds them and
        sends the whole character with the next output) or its last bytes at the start (the rest went out of the ring)."""
        with self.lock:
            data = bytes(self.ring)
            held = self.decoder.getstate()[0]
        if held and data.endswith(held):
            data = data[: -len(held)]
        for _ in range(3):
            if data and 0x80 <= data[0] < 0xC0:
                data = data[1:]
        return data.decode("utf-8", "replace")

    def frame(self) -> str:
        """The scrollback frame a socket gets first (and again when it fell too far behind)."""
        return json.dumps({"type": "scrollback", "data": self.text(), "cols": self.cols, "rows": self.rows,
                           "alive": self.alive})

    def row(self, extra: bool = False) -> dict:
        out = {"id": self.id, "name": self.name, "owner": self.owner, "alive": self.alive, "busy": self.busy(),
               "started": self.started, "exit_code": self.code(), "ended_reason": self.ended_reason,
               "command": self.command, "elapsed_s": self.elapsed(), "taken": self.taken}
        if extra:
            out.update(cols=self.cols, rows=self.rows, shell=self.shell)
        return out

    def meta_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "owner": self.owner, "starter": self.starter, "started": self.started,
                "started_ts": self.started_ts, "command": self.command, "command_ts": self.command_ts,
                "command_code": self.command_code, "ended": self.ended, "exit_code": self.exit_code,
                "ended_reason": self.ended_reason, "ended_ts": self.ended_ts, "run": self.run,
                "restart_seen": self.restart_seen, "shell": self.shell, "cols": self.cols, "rows": self.rows}

    def save(self) -> None:
        try:
            tmp = self.meta.with_suffix(f".{threading.get_ident()}.tmp")
            with _private(tmp) as f:
                f.write(json.dumps(self.meta_dict()))
            tmp.replace(self.meta)
        except OSError as e:  # a Room folder that went away (a test's, or a removed home) loses nothing that matters
            log.debug("terminal meta not written: %s", e.__class__.__name__)


# --- the registry ---------------------------------------------------------------------------------------------------------
_TERMS: dict[str, RoomTerminal] = {}
_LOCK = threading.RLock()
_DIR: Path | None = None           # the terminals folder the registry belongs to
_RUN = uuid.uuid4().hex            # this process; a record from another run is a restart's
_RESTART_ENDED = 0                 # terminals this start found ended by the restart
_ATEXIT = False


def _folder() -> Path | None:
    """The Room's terminals folder (store.work_dir()/terminals), or None when there is no Room in this process."""
    from . import room

    if room.remote() or room._import_room() is None:
        return None
    path = room._store().work_dir() / "terminals"
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.name == "posix" and path.stat().st_mode & 0o077:  # a terminal's text is the person's: theirs alone
        path.chmod(0o700)
    return path


def _registry() -> dict[str, RoomTerminal]:
    """The terminals of the Room in this process; on first use (and when the Room's folder changes) the ended ones from
    an earlier run are read back."""
    global _DIR
    try:
        folder = _folder()
    except OSError:
        folder = None
    with _LOCK:
        if folder != _DIR:
            for t in list(_TERMS.values()):  # another Room's shells (tests switch homes): end them, quietly
                _end_now(t, "closed")
            _TERMS.clear()
            _DIR = folder
            if folder is not None:
                _load(folder)
        return _TERMS


def _ordered() -> list[RoomTerminal]:
    return sorted(_registry().values(), key=lambda t: (t.started_ts, t.id))


def listing() -> list[dict]:
    """The status shape (design 0006, section 6): the server's order, names and state, never the browser's."""
    try:
        return [t.row() for t in _ordered()]
    except Exception as e:  # noqa: BLE001 - status never fails because of a terminal
        log.debug("terminal listing failed: %s", e.__class__.__name__)
        return []


def get(tid: str) -> RoomTerminal | None:
    return _registry().get(str(tid or ""))


def _need(tid: str) -> RoomTerminal:
    t = get(tid)
    if t is None:
        raise HTTPException(404, NO_SUCH)
    return t


def taken_any() -> bool:
    """Whether the person took a terminal from Rooks and it still runs (presence: "You took the terminal; Rooks waits")."""
    try:
        return any(t.taken and t.alive for t in _registry().values())
    except Exception:  # noqa: BLE001
        return False


def load_ended() -> int:
    """Read back the terminals an earlier run of the app left: listed as ended (a live one was hung up by the restart),
    their log as their text. Returns how many this call found ended by the restart. The registry does this on its first
    use, so the app's start (restart.recover) reads them before any chat is told: counted here either way."""
    with _LOCK:
        before = _RESTART_ENDED
    _registry()
    with _LOCK:
        if _DIR is not None:
            _load(_DIR)
        return _RESTART_ENDED - before


def _record(folder: Path, path: Path) -> tuple[RoomTerminal, bool] | None:
    """One ended terminal from its record, or None when the record is not one (a Room program can write this folder
    when the Room has no namespace; a bad file is skipped, never a reason for every terminal route to fail)."""
    try:
        meta = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(meta, dict):
        return None
    tid = str(meta.get("id") or "")
    if not re.fullmatch(r"[0-9a-f]{8}", tid) or tid in _TERMS or meta.get("run") == _RUN:
        return None
    code = meta.get("exit_code")
    try:
        t = RoomTerminal(id=tid, name=str(meta.get("name") or "Terminal")[:40], owner=str(meta.get("owner") or "person"),
                         starter=str(meta.get("starter") or meta.get("owner") or "person"),
                         started=str(meta.get("started") or ""), started_ts=float(meta.get("started_ts") or 0),
                         log=folder / f"{tid}.log", meta=path, shell=str(meta.get("shell") or ""),
                         cols=int(meta.get("cols") or COLS), rows=int(meta.get("rows") or ROWS),
                         command=str(meta["command"]) if meta.get("command") is not None else None,
                         command_ts=float(meta["command_ts"]) if meta.get("command_ts") is not None else None,
                         command_code=int(meta["command_code"]) if meta.get("command_code") is not None else None,
                         run=str(meta.get("run") or ""))
        t.exit_code = int(code) if code is not None else None
        t.ended_ts = float(meta.get("ended_ts") or path.stat().st_mtime)
    except (TypeError, ValueError, OverflowError, OSError):
        return None
    t.ended = True
    t.ended_reason = str(meta.get("ended_reason") or "restart")
    t.restart_seen = bool(meta.get("restart_seen"))
    if t.owner not in ("person", "rooks") or t.starter not in ("person", "rooks"):
        return None
    return t, bool(meta.get("ended"))


def _load(folder: Path) -> int:
    global _RESTART_ENDED
    found = 0
    for path in sorted(folder.glob("*.json")):
        got = _record(folder, path)
        if got is None:
            continue
        t, was_ended = got
        if not was_ended or (t.ended_reason == "restart" and not t.restart_seen):
            t.ended_reason = "restart"
            t.restart_seen = True
            found += 1
            t.save()
        try:
            with t.log.open("rb") as f:
                f.seek(max(0, t.log.stat().st_size - RING_MAX))
                t.ring = bytearray(f.read())
        except OSError:
            pass
        _TERMS[t.id] = t
    _RESTART_ENDED += found
    return found


def ended_at_restart() -> int:
    """How many Room terminals were live when the app last stopped (the restart note says so, design 0006, section 5)."""
    try:
        _registry()
    except Exception:  # noqa: BLE001
        return 0
    return _RESTART_ENDED


def _at_exit() -> None:
    """The app is going away: hang every live shell up and write that a restart ended it."""
    for t in list(_TERMS.values()):
        if not t.ended and t.proc is not None:
            terminal_pty._hang_up(t.proc)
            t.ended, t.ended_reason, t.ended_ts = True, "restart", time.time()
            t.stop.set()
            t.save()


def reset_for_tests(restart: bool = True) -> None:
    """Forget the registry as a restart would. restart=True: every live shell is hung up and recorded as ended by a
    restart (what atexit does); False: they are ended quietly, as closed."""
    global _DIR, _RUN, _RESTART_ENDED
    with _LOCK:
        terms = list(_TERMS.values())
        for t in terms:
            _end_now(t, "restart" if restart else "closed")
        _TERMS.clear()
    for t in terms:  # a reader finishing later would write its row into whatever runs next
        if t.reader is not None and t.reader is not threading.current_thread():
            t.reader.join(timeout=3)
        _DIR = None
        _RUN = uuid.uuid4().hex
        _RESTART_ENDED = 0


# --- the shell's output ----------------------------------------------------------------------------------------------------
def _split_marks(data: bytes) -> tuple[bytes, list[tuple[int, str | None]], bytes]:
    """The output without exit code markers, the (code, nonce) each carried (nonce None from a profile seeded before
    the nonce), and a tail held back because it may be the start of a marker cut by the read."""
    marks = [(int(m.group(1)) if m.group(1) not in (b"", b"-") else 0,
              m.group(2).decode() if m.group(2) is not None else None) for m in _MARK.finditer(data)]
    clean = _MARK.sub(b"", data)
    i = clean.rfind(b"\x1b")
    if i != -1:
        tail = clean[i:]
        if len(tail) < 96 and (_MARK_HEAD.startswith(tail) or _MARK_PART.fullmatch(tail)):
            return clean[:i], marks, tail
    return clean, marks, b""


@dataclass
class _Socket:
    """The one socket attached to a terminal: its queue, its loop, and how much output waits in the queue."""
    token: object
    q: asyncio.Queue
    loop: asyncio.AbstractEventLoop
    queued: int = 0

    def __getitem__(self, i: int):  # (token, queue, loop), as before
        return (self.token, self.q, self.loop)[i]


def _resync(q: asyncio.Queue, frame: str) -> None:
    """On the socket's loop: what waits is dropped and one fresh scrollback frame takes its place."""
    closing = []
    while not q.empty():
        item = q.get_nowait()
        if isinstance(item, tuple) and item[0] == "close":
            closing.append(item)
    q.put_nowait(("frame", frame))
    for item in closing:
        q.put_nowait(item)


def _emit(t: RoomTerminal, clean: bytes) -> None:
    if not clean:
        return
    with t.lock:
        t.ring += clean
        if len(t.ring) > RING_MAX:
            del t.ring[: len(t.ring) - RING_MAX]
        t.total += len(clean)
        t.last_out = time.monotonic()
        text = t.decoder.decode(clean)
        sock = t.attached
        if sock and text:
            try:
                if sock.queued + len(text) > QUEUE_MAX:  # a window that stopped reading: it gets the ring, once
                    frame = t.frame()
                    sock.queued = len(frame)
                    sock.loop.call_soon_threadsafe(_resync, sock.q, frame)
                else:
                    sock.queued += len(text)
                    sock.loop.call_soon_threadsafe(sock.q.put_nowait, text)
            except RuntimeError:  # that socket's loop is gone
                t.attached = None
    _log_write(t, clean)


def _log_write(t: RoomTerminal, data: bytes) -> None:
    """The terminal's log in the Room's work folder: the person's alone (0600 in a 0700 folder)."""
    try:
        if t.log_fh is None:
            t.log_fh = _private(t.log, "ab")
            t.log_size = t.log.stat().st_size
        t.log_fh.write(data)
        t.log_fh.flush()
        t.log_size += len(data)
        if t.log_size > LOG_MAX:  # keep the last megabyte
            t.log_fh.close()
            keep = t.log.read_bytes()[-LOG_KEEP:]
            with _private(t.log, "wb") as f:
                f.write(keep)
            t.log_fh, t.log_size = _private(t.log, "ab"), len(keep)
    except OSError as e:
        log.debug("terminal log not written: %s", e.__class__.__name__)


def _command_output(t: RoomTerminal) -> str:
    with t.lock:
        since = t.total - t.command_mark
        raw = bytes(t.ring[-since:]) if 0 < since <= len(t.ring) else bytes(t.ring)
    text = plain(raw.decode("utf-8", "replace"))
    return "\n".join([ln for ln in text.split("\n") if ln.strip()][-DONE_LINES:])


def _marker(t: RoomTerminal, code: int, nonce: str | None = None) -> None:
    """The shell came back to its prompt: the last command ended with this code. A marker without this terminal's
    nonce is something a command printed, once the profile has shown it prints the nonce; it is cut out and ignored."""
    done = False
    with t.lock:
        if nonce is not None:
            if nonce != t.nonce:
                return
            t.nonce_seen = True
        elif t.nonce_seen:
            return
        t.prompts += 1
        t.last_code = code
        if t.pending:
            t.pending, t.command_code, t.done_ts, done = False, code, time.time(), True
    if done:
        t.save()
        # The end of a command Rooks started, with its last lines; not when the person took the terminal (theirs).
        lines = "" if t.taken else _command_output(t)
        _row("done", {"name": t.name, "command": t.command, "exit_code": code}, "ok" if code == 0 else "error",
             (f"exit {code}; " + lines)[:500], t.command_mono or time.monotonic())


def _take(t: RoomTerminal, data: bytes) -> None:
    clean, marks, t.carry = _split_marks(t.carry + data)
    _emit(t, clean)
    for code, nonce in marks:
        _marker(t, code, nonce)


def _shell_gone(t: RoomTerminal) -> bool:
    proc = t.proc
    try:
        return proc is not None and proc.poll() is not None
    except OSError:
        return False


def _read_loop(t: RoomTerminal) -> None:
    fd = t.master
    left = False  # the shell exited while something it started still holds the terminal (sleep 30 & exit)
    while not t.stop.is_set():
        try:
            ready, _, _ = select.select([fd], [], [], 0.25)
        except (OSError, ValueError):
            break
        if not ready:
            if t.carry:  # a held tail that turned out not to be a marker
                carry, t.carry = t.carry, b""
                _emit(t, carry)
            if _shell_gone(t):
                left = True
                break
            continue
        try:
            data = os.read(fd, 65536)
        except BlockingIOError:
            continue
        except OSError:  # EIO: the shell and everything holding its terminal are gone
            data = b""
        if not data:
            break
        _take(t, data)
    if left:  # what the shell printed last, then its session is hung up and reaped
        while True:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            _take(t, data)
    if not t.stop.is_set():  # the shell exited by itself
        _finish(t, "exited", hang_up=left)


# --- opening, typing, closing ------------------------------------------------------------------------------------------------
def _row(action: str, args: dict, outcome: str, detail: str, started: float) -> None:
    from . import room

    try:
        room._record(action, args, outcome, detail, started)
    except Exception as e:  # noqa: BLE001 - the run log never takes a terminal down
        log.debug("run log row not written: %s", e.__class__.__name__)


def _name_for(owner: str, wanted: str | None) -> str:
    names = {t.name for t in _registry().values()}
    if owner == "person" and not wanted:
        n = 1
        while f"Terminal {n}" in names:
            n += 1
        return f"Terminal {n}"
    base = (wanted or "Rooks").strip()[:40] or "Rooks"
    name, n = base, 1
    while name in names:
        n += 1
        name = f"{base} {n}"
    return name


def _spawn(t: RoomTerminal, argv: list[str], home: Path, env: dict) -> None:
    """In a worker thread: the shell on a fresh pseudo terminal, and its reader."""
    import pty

    if t.ended:  # Stop, Start over or Close came first
        raise HTTPException(409, ENDED)
    master, slave = pty.openpty()
    # A session of its own with this terminal as its controlling terminal, so every shell gets job control (bash takes
    # it itself; dash and others do not) and the foreground process group says when a program runs. util-linux's
    # setsid -c does that in place (same pid); elsewhere a new session is all Python can give without a fork hook.
    # setsid by its full path on this computer: never one from the Room's own bins, which a Room program can write.
    setsid = _host_which("setsid") if sys.platform.startswith("linux") else None
    try:
        terminal_pty._resize(master, t.cols, t.rows)
        proc = subprocess.Popen([setsid, "-c", *argv] if setsid else argv, stdin=slave, stdout=slave, stderr=slave,
                                cwd=str(home), env=env, start_new_session=not setsid, close_fds=True)
    except OSError:
        os.close(master)
        raise
    finally:
        os.close(slave)
    os.set_blocking(master, False)
    with t.lock:  # _end_now marks a terminal ended under this lock, then hangs up whatever t.proc is
        if not t.ended:
            t.proc, t.master = proc, master
            t.reader = threading.Thread(target=_read_loop, args=(t,), name=f"room-terminal-{t.id}", daemon=True)
            t.reader.start()
            return
    # It was closed while its shell started: that shell never becomes a terminal. Hang it up, reap it, close its pty.
    terminal_pty._hang_up(proc)
    terminal_pty._reap(proc)
    os.close(master)
    raise HTTPException(409, ENDED)


def _host_which(name: str) -> str | None:
    """A program on this computer, never in the Room's folders (rooks_try's host_which; shutil's when it is older)."""
    try:
        from rooks_try.drivers.shell import host_which
    except ImportError:
        return shutil.which(name)
    return host_which(name)


def _env(room, driver, home: Path) -> dict:
    """The Room's environment over the app terminal's (both scrubs: the app's own secrets and every key or token)."""
    from rooks_try.drivers.shell import room_env

    env = room_env(home, bool(getattr(driver, "offline", False)), base=scrub_env(terminal_pty.shell_env()))
    if getattr(driver, "name", "") == "nested":  # a program it opens shows on the Room's own screen
        try:
            display = driver.status().get("display")
        except Exception:  # noqa: BLE001
            display = None
        if display:
            env["DISPLAY"] = str(display)
    return env


async def _typed(t: RoomTerminal, data: bytes) -> None:
    while data:
        if t.ended or t.master is None:
            raise HTTPException(409, ENDED)
        try:
            data = data[os.write(t.master, data):]
        except BlockingIOError:
            await asyncio.sleep(0.01)
        except OSError as e:
            raise HTTPException(409, ENDED) from e


async def open_terminal(name: str | None = None, owner: str = "person", command: str | None = None) -> RoomTerminal:
    """Open a Room terminal (or, for a command, reuse Rooks's idle one of that name) and, with a command, type it.
    Returns at once; nothing here waits for the command."""
    from . import room

    command = (command or "").strip() or None
    if command and ("\n" in command or "\r" in command):  # bash marks each line's end: one line, one end, one code
        raise HTTPException(400, ONE_LINE)
    if room.remote():
        raise HTTPException(501, NO_TERMINAL)
    tryroom = room._import_room()
    if tryroom is None:
        raise HTTPException(503, NOT_INSTALLED)
    if not terminal_pty.enabled():
        raise HTTPException(409, SWITCHED_OFF)
    st = await room.perform("status")
    if not (st.get("can") or {}).get("terminal"):
        raise HTTPException(501, NO_TERMINAL)
    if not st.get("running"):
        raise HTTPException(409, OFF)
    if command:
        owner = "rooks"
        wanted = (name or "Rooks").strip()[:40] or "Rooks"
        for t in reversed(_ordered()):
            if t.name == wanted and t.alive and t.owner == "rooks" and not t.taken and not t.busy():
                await _start(t, command)
                return t
    started = time.monotonic()
    with _LOCK:
        if len(_registry()) >= MAX:
            raise HTTPException(429, FULL)
        folder = _DIR
        if folder is None:
            raise HTTPException(503, NOT_INSTALLED)
        tid = uuid.uuid4().hex[:8]
        t = RoomTerminal(id=tid, name=_name_for(owner, name), owner=owner, starter=owner, started=_now_iso(),
                         started_ts=time.time(), log=folder / f"{tid}.log", meta=folder / f"{tid}.json", run=_RUN)
        _TERMS[tid] = t  # holds its place under the cap while it starts
    try:
        store = room._store()
        driver = await asyncio.to_thread(tryroom.driver)
        home = store.guest_home()
        await asyncio.to_thread(store.seed_home, home)
        argv = await asyncio.to_thread(driver.terminal_argv, home)
        if not argv:
            raise HTTPException(501, NO_TERMINAL)
        env = await asyncio.to_thread(_env, tryroom, driver, home)
        env["ROOKS_MARK"] = t.nonce  # the profile keeps it, unexported, and prints it in each exit code marker
        t.shell = env.get("SHELL") or "/bin/sh"
        await asyncio.to_thread(_spawn, t, argv, home, env)
    except HTTPException:
        _forget(t)  # it never opened (or was closed while it opened): nothing of it stays
        raise
    except Exception as e:  # noqa: BLE001
        with _LOCK:
            _TERMS.pop(t.id, None)
        log.warning("room terminal did not start: %s", e.__class__.__name__)
        raise HTTPException(500, DID_NOT_START) from e
    t.save()
    _row("open terminal", {"name": t.name}, "ok", f"opened {t.name}", started)
    if command:
        await _start(t, command)
    return t


async def _ready(t: RoomTerminal) -> None:
    """Wait for a new shell's first prompt (PROMPT_WAIT_S at most). Text typed before it is echoed once by the terminal
    and again at the prompt, so a command sent to a brand new terminal showed twice."""
    deadline = time.monotonic() + PROMPT_WAIT_S
    while t.prompts == 0 and not t.ended and time.monotonic() < deadline:
        if t.total and not t.busy() and time.monotonic() - t.last_out > 0.5:
            break  # a shell without the Room's marker (not bash or zsh, or a profile the person replaced): it is waiting
        await asyncio.sleep(0.05)
    if t.ended:
        raise HTTPException(409, ENDED)


async def _start(t: RoomTerminal, command: str) -> None:
    """Type a command Rooks starts, once the shell shows its first prompt (so the end is read from the right marker)."""
    from .redact import redact

    await _ready(t)
    with t.lock:
        t.command = redact(command)[:500]
        t.command_ts, t.command_mono, t.command_code, t.done_ts = time.time(), time.monotonic(), None, None
        t.command_mark = t.total
        t.pending = t.prompts > 0  # without the profile's marker, busy is the foreground process group alone
    t.save()
    _row("start", {"name": t.name, "command": command}, "ok", f"started in {t.name}", time.monotonic())
    await _typed(t, (command + "\n").encode())


def _end_now(t: RoomTerminal, reason: str, hang_up: bool = True) -> bool:
    """Synchronous end of a shell: hang it up, reap its session, close its terminal, write the record. False when it
    had already ended."""
    with t.lock:
        if t.ended:
            return False
        t.ended, t.ended_reason, t.ended_ts, t.pending = True, reason, time.time(), False
        t.stop.set()
        attached, t.attached = t.attached, None
    proc = t.proc
    if proc is not None:
        if hang_up:
            terminal_pty._hang_up(proc)
        terminal_pty._reap(proc)
        rc = proc.returncode
        t.exit_code = (128 - rc) if rc is not None and rc < 0 else rc
    if t.reader is not None and t.reader is not threading.current_thread():
        t.reader.join(timeout=2)
    if t.master is not None:
        try:
            os.close(t.master)
        except OSError:
            pass
        t.master = None
    if t.log_fh is not None:
        try:
            t.log_fh.close()
        except OSError:
            pass
        t.log_fh = None
    t.save()
    if attached:
        try:
            attached.loop.call_soon_threadsafe(attached.q.put_nowait, ("close", EXITED))
        except RuntimeError:
            pass
    return True


def _finish(t: RoomTerminal, reason: str, hang_up: bool = True) -> bool:
    started = time.monotonic()
    if not _end_now(t, reason, hang_up):
        return False
    _row("close terminal", {"name": t.name, "exit_code": t.exit_code, "reason": reason}, "ok",
         f"{t.name} ended ({reason}), code {t.exit_code}", started)
    return True


async def close(t: RoomTerminal, reason: str) -> bool:
    return await asyncio.to_thread(_finish, t, reason)


async def close_all(reason: str, forget: bool = False) -> int:
    """End every live Room terminal (Stop: "stop", Start over: "start over"). Their records stay, greyed, unless forget
    (Start over: the folder they stood in is replaced). Returns how many were live."""
    terms = list(_registry().values())
    ended = await asyncio.gather(*(close(t, reason) for t in terms if t.alive))
    if forget:
        for t in terms:
            _forget(t)
    return sum(1 for e in ended if e)


def _forget(t: RoomTerminal) -> None:
    with _LOCK:
        _TERMS.pop(t.id, None)
    for path in (t.log, t.meta):
        try:
            path.unlink()
        except OSError:
            pass


def hidden_input(t: RoomTerminal) -> bool:
    """The terminal is waiting for an answer it does not show (sudo, passwd, ssh, read -s): echo off in line mode. A
    shell's own line editor (readline, zle) also turns echo off, but reads key by key, so it is not counted."""
    import termios

    master = t.master
    if master is None:
        return False
    try:
        lflag = termios.tcgetattr(master)[3]
    except (OSError, termios.error, TypeError, ValueError):
        return False
    return not lflag & termios.ECHO and bool(lflag & termios.ICANON)


async def send(t: RoomTerminal, text: str, enter: bool = True) -> tuple[int, bool]:
    """Type a line into a terminal. Returns the bytes typed and whether the terminal was waiting for hidden input."""
    if t.ended:
        raise HTTPException(409, ENDED)
    if t.owner == "rooks" and not t.taken and t.busy():
        raise HTTPException(409, ROOKS_BUSY)
    await _ready(t)
    hidden = hidden_input(t)
    data = (text + ("\r" if enter else "")).encode()
    await _typed(t, data)
    return len(data), hidden


def tail(t: RoomTerminal, lines: int = TAIL_DEFAULT) -> dict:
    """A terminal's last lines as plain text (no escape sequences), with whether it is busy and how it ended."""
    lines = max(1, min(int(lines or TAIL_DEFAULT), TAIL_MAX))
    text = "\n".join(plain(t.text()).split("\n")[-lines:])
    out = {"id": t.id, "name": t.name, "text": text, "alive": t.alive, "busy": t.busy(), "exit_code": t.code(),
           "owner": t.owner, "taken": t.taken, "elapsed_s": t.elapsed(), "started": t.started,
           "ended_reason": t.ended_reason}
    if t.taken:
        out["note"] = TAKEN_NOTE
    return out


def newest_rooks() -> RoomTerminal | None:
    rooks = [t for t in _ordered() if t.starter == "rooks"]
    return rooks[-1] if rooks else None


# --- routes ------------------------------------------------------------------------------------------------------------------
async def _body(request: Request) -> dict:
    try:
        body = await request.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


@terminal.get("/terminals")
async def list_route():
    return {"terminals": [t.row(extra=True) for t in _ordered()], "max": MAX}


@terminal.post("/terminals")
async def open_route(request: Request):
    body = await _body(request)
    command = str(body.get("command") or "").strip() or None
    name = str(body.get("name") or "").strip()[:40] or None
    t = await open_terminal(name=name, owner="rooks" if command else "person", command=command)
    return {"id": t.id, "name": t.name, "owner": t.owner, "alive": t.alive, "started": t.started}


@terminal.get("/terminals/{tid}/tail")
async def tail_route(tid: str, lines: int = TAIL_DEFAULT):
    return tail(_need(tid), lines)


@terminal.post("/terminals/{tid}/send")
async def send_route(tid: str, request: Request):
    t = _need(tid)
    body = await _body(request)
    text = str(body.get("text") or "")
    started = time.monotonic()
    sent, hidden = await send(t, text, body.get("enter", True) is not False)
    # An answer typed where the terminal does not show it (a password prompt) is never written down, only its length.
    shown = HIDDEN_LINE.format(n=len(text)) if hidden else text
    _row("send", {"name": t.name, "text": shown}, "ok", f"sent a line to {t.name}", started)
    return {"ok": True, "bytes": sent}


@terminal.delete("/terminals/{tid}")
async def delete_route(tid: str):
    """Close a terminal (what it runs stops) and remove it; an ended one is removed with its text."""
    t = _need(tid)
    closed = await close(t, "closed") if t.alive else False
    _forget(t)
    return {"ok": True, "exit_code": t.exit_code, "closed": closed}


@router.post("/terminals/{tid}/take")
async def take_route(tid: str, request: Request):
    """The person takes a terminal Rooks works in (their typing is theirs from now), or hands it back."""
    t = _need(tid)
    who = str((await _body(request)).get("owner") or "person")
    if who not in ("person", "rooks"):
        raise HTTPException(400, "Say who takes the terminal: you or Rooks.")
    with t.lock:
        t.owner = who
        t.taken = who == "person" and t.starter == "rooks"
    t.save()
    return {"id": t.id, "owner": t.owner, "taken": t.taken}


@router.patch("/terminals/{tid}")
async def rename_route(tid: str, request: Request):
    t = _need(tid)
    name = str((await _body(request)).get("name") or "").strip()
    if not 1 <= len(name) <= 40:
        raise HTTPException(400, BAD_NAME)
    t.name = name
    t.save()
    return {"id": t.id, "name": t.name}


def _refusal(ws: WebSocket) -> tuple[int, str] | None:
    """terminal_pty's rules, without the app terminal's own count."""
    tp = terminal_pty
    if not tp.enabled():
        return 4403, WS_OFF
    if not tp.check_session(ws.cookies.get(tp.COOKIE)):
        return 4401, "Not signed in"
    if not tp._same_origin(ws):
        return 4403, "Wrong origin"
    if not tp._is_local(ws):
        return 4403, WS_NOT_LOCAL
    return None


@sockets.websocket("/api/room/terminals/{tid}/ws")
async def attach(ws: WebSocket, tid: str):
    no = _refusal(ws)
    t = None
    if no is None:
        t = get(tid)
        no = (4404, WS_NO_SUCH) if t is None else (4409, WS_ENDED) if t.ended else None
    if no:
        await ws.accept()  # accept-then-close so the page can show the reason
        await ws.close(code=no[0], reason=no[1])
        return
    await ws.accept()
    sock = _Socket(object(), asyncio.Queue(), asyncio.get_running_loop())
    with t.lock:
        ended = t.ended  # it ended while this socket was being accepted: its text, then the reason, never a hang
        before = None
        if not ended:
            before, t.attached = t.attached, sock
        first = t.frame()
    if ended:
        await ws.send_text(first)
        await ws.close(code=4409, reason=WS_ENDED)
        return
    if before:  # one window at a time: the earlier one is told why it closed
        try:
            before.loop.call_soon_threadsafe(before.q.put_nowait, ("close", ELSEWHERE))
        except RuntimeError:
            pass
    attached_at, typed, resized = time.monotonic(), False, False

    async def pump() -> None:
        await ws.send_text(first)
        while True:
            item = await sock.q.get()
            if isinstance(item, tuple) and item[0] == "close":
                await ws.close(code=1000, reason=item[1])
                return
            text = item[1] if isinstance(item, tuple) else item  # ("frame", scrollback) after the socket fell behind
            await ws.send_text(text)
            with t.lock:
                sock.queued = max(0, sock.queued - len(text))

    sender = asyncio.create_task(pump())
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            if not isinstance(msg, dict):
                continue
            if msg.get("type") == "input":
                if t.owner == "rooks" and not t.taken and t.busy():
                    continue  # Rooks is working here; the page says so and offers Take this one
                await _typed(t, str(msg.get("data", "")).encode())
                typed = True
            elif msg.get("type") == "resize" and t.master is not None:
                cols, rows = int(msg.get("cols") or COLS), int(msg.get("rows") or ROWS)
                if not resized and (cols, rows) == (t.cols, t.rows) and rows > 2:
                    terminal_pty._resize(t.master, cols, rows - 1)  # the same size: nudge it, so a full screen redraws
                terminal_pty._resize(t.master, cols, rows)
                t.cols, t.rows, resized = max(2, min(cols, 1000)), max(2, min(rows, 500)), True
    except Exception:  # noqa: BLE001 - a socket that went away, or a frame that was not ours
        pass
    finally:
        sender.cancel()
        with t.lock:
            if t.attached is sock:
                t.attached = None  # the shell keeps running
        if typed:  # one coarse row; what was typed is never recorded
            minutes = max(1, round((time.monotonic() - attached_at) / 60))
            _row("used terminal", {"name": t.name}, "ok", f"You used the terminal for {minutes} min", attached_at)


def _register_exit() -> None:
    global _ATEXIT
    if not _ATEXIT:
        atexit.register(_at_exit)
        _ATEXIT = True


_register_exit()
