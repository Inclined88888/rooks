"""#7: a real terminal inside the app (and the browser on the same machine).

One WebSocket per terminal tab, one login shell per WebSocket, on a pseudo terminal. The page (xterm.js) sends
{"type": "input", "data": "..."} and {"type": "resize", "cols": N, "rows": N}; the server sends the shell's output as
text. Closing the tab ends the shell's whole process group.

Who may open one, all of these:
  - a signed-in session (the same cookie as every /api page)
  - the page's own origin (a WebSocket carries cookies cross-site, so another site must not open a shell)
  - a client on this machine (loopback): a self-hosted server reached over the network never hands out a shell
  - not switched off in Settings (app_terminal = 0)
The shell gets the user's environment minus the app's own secrets (APP_SECRET, provider keys, tokens).
On Windows (design 0011, section 1) the shell is PowerShell on a pseudo console (ConPTY, rooks_try.winproc) in a job of
its own, so closing the tab ends it and everything it started. Windows older than 10 1809 has no pseudo console: there
the terminal is off, and status says why.
"""

from __future__ import annotations

import asyncio
import codecs
import json
import os
import re
import signal
import struct
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect

from . import db
from .security import COOKIE, check_session, require_user

router = APIRouter()

MAX_SESSIONS = 6
_open: set[int] = set()  # pids of live shells
_SECRET = re.compile(r"(SECRET|PASSWORD|PASSWD|_KEY$|_TOKEN$|^TOKEN|API_KEY|CREDENTIAL)", re.I)
_APP_ONLY = ("APP_SECRET", "TOOLS_API_KEY", "DATA_DIR", "STATIC_DIR", "DATABASE_URL", "WORKBENCH_DESKTOP_TOKEN")
LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def conpty() -> bool:
    """Windows: whether this computer has pseudo consoles (and rooks_try, which drives them, is installed)."""
    try:
        from rooks_try import winproc
    except ImportError:
        return False
    return winproc.conpty_available()


def available() -> bool:
    """A terminal can exist on this system at all: POSIX, or Windows with pseudo consoles."""
    return sys.platform != "win32" or conpty()


def enabled() -> bool:
    return db.get_setting("app_terminal", "1") == "1" and available()


def windows_argv() -> list[str]:
    """The app terminal's shell on Windows: PowerShell 7 when installed, else Windows PowerShell, by its full path."""
    from rooks_try.drivers.shell import windows_powershell

    ps = windows_powershell()
    if not ps:
        raise OSError("PowerShell is not on this computer")
    return [ps, "-NoLogo"]


def shell_env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not _SECRET.search(k) and k not in _APP_ONLY}
    env.update(TERM="xterm-256color", COLORTERM="truecolor", AI_WORKSPACE_TERMINAL="1")
    return env


def _is_local(ws: WebSocket) -> bool:
    """Peer on loopback, and the page itself served from a loopback name: a DNS rebinding page (evil.example
    resolving to 127.0.0.1) has neither the cookie nor a loopback Origin."""
    origin_host = urlsplit(ws.headers.get("origin", "")).hostname or ""
    return bool(ws.client) and ws.client.host in LOOPBACK and origin_host in LOOPBACK


def _same_origin(ws: WebSocket) -> bool:
    origin = ws.headers.get("origin", "")
    host = ws.headers.get("host", "")
    return bool(origin) and urlsplit(origin).netloc == host


def refusal(ws: WebSocket) -> tuple[int, str] | None:
    if not enabled():
        return 4403, "The app terminal is off (Settings) or not available on this system"
    if not check_session(ws.cookies.get(COOKIE)):
        return 4401, "Not signed in"
    if not _same_origin(ws):
        return 4403, "Wrong origin"
    if not _is_local(ws):
        return 4403, "The terminal only opens on the computer running Rooks"
    if len(_open) >= MAX_SESSIONS:
        return 4429, f"At most {MAX_SESSIONS} terminals at once"
    return None


def _resize(fd: int, cols: int, rows: int) -> None:
    import fcntl
    import termios

    cols, rows = max(2, min(int(cols), 1000)), max(2, min(int(rows), 500))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def _session_pids(sid: int) -> list[int]:
    """Every process still in the shell's session, background jobs included (they get their own process groups)."""
    try:
        out = subprocess.run(["pgrep", "-s", str(sid)], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    return [int(p) for p in out.split() if p.isdigit()]


def _hang_up(proc: subprocess.Popen) -> None:
    """Synchronous and quick, so it runs even when the handler is being cancelled: SIGHUP the shell's session."""
    for pid in [proc.pid, *_session_pids(proc.pid)]:
        try:
            os.killpg(pid, signal.SIGHUP) if pid == proc.pid else os.kill(pid, signal.SIGHUP)
        except (ProcessLookupError, PermissionError):
            pass


def _reap(proc: subprocess.Popen) -> None:
    """In a worker thread: give the session a moment to exit on SIGHUP, then SIGKILL whatever is left of it."""
    try:
        proc.wait(timeout=1.5)
    except subprocess.TimeoutExpired:
        pass
    for pid in _session_pids(proc.pid) + ([proc.pid] if proc.poll() is None else []):
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass


@router.websocket("/api/terminal/ws")
async def terminal(ws: WebSocket):
    no = refusal(ws)
    if no:
        await ws.accept()  # accept-then-close so the page can show the reason
        await ws.close(code=no[0], reason=no[1])
        return
    if sys.platform == "win32":
        await _windows_terminal(ws)
        return
    import pty

    await ws.accept()
    master, slave = pty.openpty()
    shell = os.environ.get("SHELL") or "/bin/sh"
    proc = subprocess.Popen([shell, "-l"], stdin=slave, stdout=slave, stderr=slave, cwd=os.path.expanduser("~"),
                            env=shell_env(), start_new_session=True, close_fds=True)
    os.close(slave)
    _open.add(proc.pid)
    os.set_blocking(master, False)
    loop = asyncio.get_running_loop()
    out: asyncio.Queue[bytes | None] = asyncio.Queue()

    def readable() -> None:
        try:
            data = os.read(master, 65536)
        except BlockingIOError:
            return
        except OSError:  # EIO: the shell is gone
            data = b""
        if not data:
            loop.remove_reader(master)
        out.put_nowait(data or None)

    loop.add_reader(master, readable)

    async def pump_out() -> None:
        while (chunk := await out.get()) is not None:
            await ws.send_text(chunk.decode("utf-8", "replace"))
        await ws.close(code=1000, reason="The shell exited")

    sender = asyncio.create_task(pump_out())
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            if msg.get("type") == "input":
                data = str(msg.get("data", "")).encode()
                while data:
                    try:
                        data = data[os.write(master, data):]
                    except BlockingIOError:
                        await asyncio.sleep(0.01)
            elif msg.get("type") == "resize":
                _resize(master, msg.get("cols", 80), msg.get("rows", 24))
    except (WebSocketDisconnect, RuntimeError, ValueError, OSError):
        pass
    finally:
        # no awaits before the bookkeeping: a cancelled handler must still end the shell and free its slot
        sender.cancel()
        try:
            loop.remove_reader(master)
        except (ValueError, OSError):
            pass
        _hang_up(proc)
        os.close(master)
        _open.discard(proc.pid)
        threading.Thread(target=_reap, args=(proc,), name="terminal-reap", daemon=True).start()


async def _windows_terminal(ws: WebSocket) -> None:
    """The same terminal on Windows: PowerShell on a pseudo console, in a job, read by a thread."""
    from rooks_try import winproc

    await ws.accept()
    try:
        # the person's own terminal, not the Room's: no Room job, no UI limits
        term = await asyncio.to_thread(lambda: winproc.Terminal(windows_argv(), shell_env(), os.path.expanduser("~"),
                                                                room=False))
    except OSError:
        await ws.close(code=1011, reason="The terminal could not start")
        return
    _open.add(term.pid)
    loop = asyncio.get_running_loop()
    out: asyncio.Queue[bytes | None] = asyncio.Queue()

    def reader() -> None:
        while True:
            data = term.read()
            try:
                loop.call_soon_threadsafe(out.put_nowait, data or None)
            except RuntimeError:  # the loop is gone
                return
            if not data:
                return

    def watcher() -> None:  # a pseudo console outlives its shell: close it when the shell exits
        try:
            term.proc.wait()
        except Exception:  # noqa: BLE001
            return
        time.sleep(0.2)
        term.close_console_async()

    read_thread = threading.Thread(target=reader, name="terminal-read", daemon=True)
    read_thread.start()
    threading.Thread(target=watcher, name="terminal-watch", daemon=True).start()
    decoder = codecs.getincrementaldecoder("utf-8")("replace")

    async def pump_out() -> None:
        while (chunk := await out.get()) is not None:
            text = decoder.decode(chunk)
            if text:
                await ws.send_text(text)
        await ws.close(code=1000, reason="The shell exited")

    sender = asyncio.create_task(pump_out())
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            if msg.get("type") == "input":
                await asyncio.to_thread(term.write, str(msg.get("data", "")).encode())
            elif msg.get("type") == "resize":
                term.resize(msg.get("cols", 80), msg.get("rows", 24))
    except (WebSocketDisconnect, RuntimeError, ValueError, OSError):
        pass
    finally:
        sender.cancel()
        term.kill_now()  # the shell and everything it started, at once (the slot frees now, as on POSIX)
        _open.discard(term.pid)

        def finish() -> None:
            term.end(grace=0.5)
            term.close(reader=read_thread)

        threading.Thread(target=finish, name="terminal-reap", daemon=True).start()


@router.get("/api/terminal/status", dependencies=[Depends(require_user)])
def status():
    """For the page: can a terminal open here, and why not."""
    return {"enabled": enabled(), "platform": sys.platform, "open": len(_open), "max": MAX_SESSIONS}
