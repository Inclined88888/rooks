"""The Room's browser in the app (design 0007, sections 1.3, 1.4, 1.6 and 1.7): a real Chromium inside the Room.

The engine and its walls are rooks_try.browser (where it comes from, how it starts over a pipe, the request rule that
refuses files outside the Room's home and this app's own address). This module keeps the one running browser for the
Room on this computer, as room_terminal keeps its shells: it outlives any socket, it starts when the Room is on and the
Browser window opens (or the rooks terminal or the assistant opens a page), and it reopens the saved tabs. Stop closes
it; Save a point closes it for the copy and opens it again; Start over closes it before the Room's home is replaced;
the app's exit closes it and writes that a restart did, and the next start (and the cut-off chat's note) says so.

Who may watch and drive: the socket follows the Room terminal's rules (signed in, same origin, loopback peer and page),
the browser not switched off in Settings, one window at a time. Frames are JPEG binary messages, newest wins, and
none are made while no one watches; state is JSON. The rooks terminal's key may open a page, list the tabs and read a
page (`/room browse`, `/room tabs`, `/room page`); a bridge key only reads, and reads never start the browser. The
phone's still and taps are the person's.

What is written down (channel room, tool use_room): opening and closing the browser, every page the rooks terminal
or a route opens (host and path, never the query), and one coarse "You used the browser for N min" row when a window
that sent input closes. Keystrokes and typed text are never recorded.
"""

from __future__ import annotations

import asyncio
import atexit
import json
import logging
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket
from fastapi.responses import Response

from . import db, terminal_pty
from .security import require_user, require_user_or_terminal

log = logging.getLogger("room.browser")

terminal = APIRouter(prefix="/api/room/browser", dependencies=[Depends(require_user_or_terminal)])
router = APIRouter(prefix="/api/room/browser", dependencies=[Depends(require_user)])
sockets = APIRouter()

TAB_MAX = 8
ENGINE_KEEP_S = 30.0
TABS_FULL = "Eight tabs are open. Close one to open another."
OFF = "The Room is off. Start it first."
CLOSED = "The Room's browser is closed. Open a page first."
NOT_INSTALLED = "The Room is not installed on this computer."
NO_BROWSER_HERE = "This Room has no browser of its own. Use its screen."
HELPER = "The Room runs elsewhere, so its browser is not here."
DID_NOT_START = "The Room's browser could not start."
NO_SUCH_TAB = "No such tab."
SAY_WHERE = "Say which page to open."
BAD_ACT = "The browser cannot do that."
RESTARTED = "The app restarted, so the browser closed. Your tabs and sign-ins are kept."
SAVING = "Saving a point. The browser closes for a moment."
ELSEWHERE = "This browser was opened in another window."
WS_NOT_LOCAL = "The browser only opens on the computer running Rooks"
CLOSE_WORDS = {
    "stop": "The Room is off. Everything in it is kept.",
    "save point": SAVING,
    "start over": "The Room started over from a saved point.",
    "restart": RESTARTED,
    "memory": "The browser used too much memory, so it closed. Your tabs are kept.",
    "exited": "The Room's browser stopped.",
}

_LOCK = threading.RLock()
_S = None                          # the running (or last) rooks_try.browser.Session
_HOME: Path | None = None          # the Room home it belongs to
_VIEWER: _Viewer | None = None
_PORTS: set[int] = set()           # where this app is reached: the browser's requests there are refused
_NOTE: str | None = None           # why the browser had closed, said by the next start
_REOPENED: list[str] = []
_LAST_NOTES: list[str] = []        # what a closed browser said last
_ENGINE: tuple[float, object] | None = None
_RUN = uuid.uuid4().hex            # this run of the app
_ATEXIT = False
_memory_reader = None              # tests put a fake reader here; None reads the process tree


def _rb():
    from rooks_try import browser as rb  # importable once room._import_room() found the package

    return rb


def _platform() -> str:
    return sys.platform


def _engine():
    """The engine found here, looked up at most every 30 s (status asks often)."""
    global _ENGINE
    now = time.monotonic()
    if _ENGINE and now - _ENGINE[0] < ENGINE_KEEP_S:
        return _ENGINE[1]
    try:
        found = _rb().find_engine()
    except Exception as e:  # noqa: BLE001
        log.debug("no engine: %s", e.__class__.__name__)
        found = None
    _ENGINE = (now, found)
    return found


def enabled() -> bool:
    return db.get_setting("room_browser", "1") == "1"


def can(driver, remote: bool) -> dict:
    """Whether the Room has a browser here, and why not: "helper", "windows", "switched_off", "no_engine", or None
    (a Room with a screen of its own: use its screen)."""
    if remote:
        return {"browser": False, "browser_off_reason": "helper"}
    if driver is None or getattr(driver, "name", "") not in ("shell", "nested"):
        return {"browser": False, "browser_off_reason": None}
    if _platform() == "win32":
        return {"browser": False, "browser_off_reason": "windows"}
    if not enabled():
        return {"browser": False, "browser_off_reason": "switched_off"}
    if _engine() is None:
        return {"browser": False, "browser_off_reason": "no_engine"}
    return {"browser": True, "browser_off_reason": None}


def _new_session(engine, home: Path, **kw):
    return _rb().Session(engine, home, **kw)


def session():
    """The running browser, or None."""
    s = _S
    return s if s is not None and s.alive() else None


def _store_home() -> Path | None:
    from . import room

    if room.remote() or room._import_room() is None:
        return None
    return room._store().guest_home()


def _learn(scope) -> None:
    """Where this app is reached (the server's port, and the Host header's): the Room's browser refuses those."""
    ports = set()
    server = scope.get("server") if isinstance(scope, dict) else None
    if server and len(server) > 1 and server[1]:
        ports.add(int(server[1]))
    for name, value in scope.get("headers") or []:
        if name == b"host":
            try:
                port = urlsplit("http://" + value.decode("latin-1")).port
            except ValueError:
                port = None
            if port:
                ports.add(port)
    with _LOCK:
        new = ports - _PORTS
        _PORTS.update(ports)
    s = session()
    if new and s is not None:
        try:
            s.set_app_ports(_PORTS)
        except Exception:  # noqa: BLE001
            pass


def closed_at_restart() -> bool:
    """Whether the Room's browser was open when the app last stopped (restart.py's note says so)."""
    try:
        home = _store_home()
        return bool(home) and _S is None and _rb().closed_by_restart(home, _RUN)
    except Exception:  # noqa: BLE001
        return False


# --- start, close ----------------------------------------------------------------------------------------------------------------
def _row(action: str, args: dict, outcome: str, detail: str, started: float) -> None:
    from . import room

    try:
        room._record(action, args, outcome, detail, started)
    except Exception as e:  # noqa: BLE001 - the run log never takes the browser down
        log.debug("run log row not written: %s", e.__class__.__name__)


def _quiet(url: str) -> str:
    try:
        return _rb()._quiet_url(url)
    except Exception:  # noqa: BLE001
        return ""


async def ensure():
    """The Room's browser, started (and its saved tabs reopened) when it is not running. Plain errors otherwise."""
    from . import room

    s = session()
    if s is not None:
        return s
    if room.remote():
        raise HTTPException(501, HELPER)
    tryroom = room._import_room()
    if tryroom is None:
        raise HTTPException(503, NOT_INSTALLED)
    if _platform() == "win32":
        raise HTTPException(501, _rb().OFF_WORDS["windows"])
    if not enabled():
        raise HTTPException(409, _rb().OFF_WORDS["switched_off"])
    engine = _engine()
    if engine is None:
        raise HTTPException(501, _rb().OFF_WORDS["no_engine"])
    st = await room.perform("status")
    if not st.get("running"):
        raise HTTPException(409, OFF)
    driver = await asyncio.to_thread(tryroom.driver)
    if getattr(driver, "name", "") not in ("shell", "nested"):
        raise HTTPException(501, NO_BROWSER_HERE)
    return await asyncio.to_thread(_start, engine, bool(getattr(driver, "offline", False)))


def _start(engine, offline: bool):
    global _S, _HOME, _NOTE, _REOPENED
    rb = _rb()
    with _LOCK:
        s = session()
        if s is not None:
            return s
        started = time.monotonic()
        home = _store_home()
        if home is None:
            raise HTTPException(503, NOT_INSTALLED)
        restarted = rb.closed_by_restart(home, _RUN)
        s = _new_session(engine, home, offline=offline, app_ports=set(_PORTS), on_frame=_on_frame,
                         on_change=_on_change, tab_max=TAB_MAX, run=_RUN,
                         memory_reader=lambda pid: (_memory_reader or rb.tree_memory)(pid))
        try:
            s.start()
        except Exception as e:  # noqa: BLE001
            log.warning("room browser did not start: %s", e.__class__.__name__)
            _row("open browser", {}, "tool_error", DID_NOT_START, started)
            raise HTTPException(500, DID_NOT_START) from e
        _S, _HOME = s, home
        saved, active = rb.load_tabs(home)
        try:
            reopened = s.restore(saved, active) if saved else []
            if not s.tabs:
                s.new_tab()
        except Exception as e:  # noqa: BLE001 - a browser without its old tabs still opens
            log.debug("tabs not reopened: %s", e.__class__.__name__)
            reopened = []
        _NOTE = RESTARTED if restarted else None
        _REOPENED = reopened
        _LAST_NOTES.clear()
    words = "opened the browser" + (f"; reopened {len(reopened)} tabs" if reopened else "")
    if restarted:
        words += " after a restart"
    _row("open browser", {"tabs": len(reopened)}, "ok", words, started)
    _on_change("tabs")
    return s


def _close_sync(reason: str) -> bool:
    global _LAST_NOTES
    s = _S
    if s is None or not s.alive():
        return False
    started = time.monotonic()
    s.close(reason)
    _LAST_NOTES = list(s.notes)[-20:]
    _row("close browser", {"reason": reason}, "ok", f"closed the browser ({reason})", started)
    v = _VIEWER
    if v is not None:
        v.post(close=CLOSE_WORDS.get(reason, "The Room's browser is closed."))
    return True


async def close(reason: str) -> bool:
    """Close the browser (Stop, Start over, Save a point, the person's Close). Its tabs and profile are kept."""
    return await asyncio.to_thread(_close_sync, reason)


async def pause(reason: str = "save point") -> bool:
    """Close the browser for a moment (Save a point copies its profile). True when it was open."""
    return await close(reason)


async def resume() -> None:
    try:
        await ensure()
    except HTTPException as e:
        log.debug("browser not reopened: %s", e.detail)


def _at_exit() -> None:
    """The app is going away: the browser closes and its record says a restart did it. Called from the app's shutdown
    (uvicorn ends on SIGTERM by raising the signal again, so atexit alone does not run) and from atexit."""
    s = _S
    if s is not None and s.alive():
        try:
            s.close("restart")
        except Exception:  # noqa: BLE001
            pass


def reset_for_tests() -> None:
    """Forget the browser as a new run of the app would (it is closed quietly when it still runs)."""
    global _S, _HOME, _VIEWER, _NOTE, _REOPENED, _ENGINE, _RUN, _LAST_NOTES
    s = _S
    if s is not None and s.alive():
        s.close("closed")
    with _LOCK:
        _S, _HOME, _VIEWER, _NOTE, _REOPENED, _ENGINE = None, None, None, None, [], None
        _LAST_NOTES = []
        _PORTS.clear()
        _RUN = uuid.uuid4().hex


# --- what the browser shows ------------------------------------------------------------------------------------------------------
def overview(history: bool = False) -> dict:
    """The status shape: open, tabs (saved ones when closed), the front tab, notes, why it had closed. history=True also
    asks the browser whether back and forward are possible (a call: not for status)."""
    s = _S
    open_ = s is not None and s.alive()
    out = {"open": open_, "tabs": [], "active": None, "notes": [], "note": _NOTE, "reopened": list(_REOPENED),
           "walled": bool(s and s.walled), "back": False, "forward": False, "max": TAB_MAX}
    if open_:
        out.update(tabs=s.rows(), active=s.active, notes=list(s.notes)[-20:], view=list(s.view))
        if history and s.active:
            try:
                h = s.history(s.active)
                out.update(back=bool(h.get("back")), forward=bool(h.get("forward")))
            except Exception:  # noqa: BLE001
                pass
        return out
    out["notes"] = list(_LAST_NOTES)
    try:
        home = _store_home()
        saved, active = _rb().load_tabs(home) if home else ([], 0)
    except Exception:  # noqa: BLE001
        saved, active = [], 0
    out["tabs"] = [{"id": f"saved-{i}", "url": t.get("url"), "title": t.get("title") or "", "asleep": True,
                    "loading": False, "blocked": None} for i, t in enumerate(saved)]
    out["active"] = f"saved-{active}" if saved else None
    return out


def _need_open():
    s = session()
    if s is None:
        raise HTTPException(409, CLOSED)
    return s


# --- the one window watching ------------------------------------------------------------------------------------------------------
@dataclass
class _Viewer:
    loop: asyncio.AbstractEventLoop
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    frame: bytes | None = None
    dirty: bool = True
    closing: str | None = None
    copy: str | None = None

    def post(self, frame: bytes | None = None, dirty: bool = False, close: str | None = None) -> None:
        def apply() -> None:
            if frame is not None:
                self.frame = frame  # newest wins: a window that lags skips frames, never queues them
            if dirty:
                self.dirty = True
            if close and not self.closing:
                self.closing = close
            self.wake.set()

        try:
            self.loop.call_soon_threadsafe(apply)
        except RuntimeError:  # its loop is gone
            pass


def _on_frame(jpeg: bytes, meta: dict) -> None:
    v = _VIEWER
    if v is not None and jpeg:
        v.post(frame=jpeg)


def _on_change(what: str) -> None:
    v = _VIEWER
    if v is not None:
        v.post(dirty=True)


def _refusal(ws: WebSocket) -> tuple[int, str] | None:
    """The Room terminal's rules (signed in, same origin, loopback), with the browser's own switch."""
    tp = terminal_pty
    if not enabled():
        return 4403, "The Room's browser is switched off in Settings"
    if not tp.check_session(ws.cookies.get(tp.COOKIE)):
        return 4401, "Not signed in"
    if not tp._same_origin(ws):
        return 4403, "Wrong origin"
    if not tp._is_local(ws):
        return 4403, WS_NOT_LOCAL
    return None


def _input(s, msg: dict, person: bool = True) -> dict | None:
    """One message from the window (or the phone), as calls to the browser. Returns an answer for the window, if any."""
    kind = msg.get("type") or msg.get("kind")
    num = lambda k, d=0.0: float(msg.get(k) or d)  # noqa: E731
    if kind == "mouse":
        s.mouse(str(msg.get("event") or "move"), num("x"), num("y"), str(msg.get("button") or "left"),
                int(msg.get("clicks") or 1), int(msg.get("modifiers") or 0))
    elif kind == "click":
        s.click(num("x"), num("y"), str(msg.get("button") or "left"), int(msg.get("clicks") or 1))
    elif kind in ("wheel", "scroll"):
        x, y = (num("x", s.view[0] / 2), num("y", s.view[1] / 2))
        s.wheel(x, y, num("dx"), num("dy"))
    elif kind == "key" and msg.get("event"):
        s.key(str(msg.get("event")), str(msg.get("key") or ""), str(msg.get("code") or ""), str(msg.get("text") or ""),
              int(msg.get("keyCode") or 0), int(msg.get("modifiers") or 0))
    elif kind == "key":
        s.press(str(msg.get("key") or "Enter"))
    elif kind in ("text", "type"):
        s.insert_text(str(msg.get("text") or ""))
    elif kind == "resize":
        w, h = s.resize(int(msg.get("width") or 0), int(msg.get("height") or 0))
        return {"type": "view", "width": w, "height": h}
    elif kind == "nav":
        action = str(msg.get("action") or "go")
        if action == "go":
            address = str(msg.get("address") or "").strip()
            if not address:
                raise HTTPException(400, SAY_WHERE)
            if not s.tabs:
                s.new_tab()
            out = s.navigate(None, address)
            if out.get("blocked"):
                return {"type": "note", "text": out["blocked"]}
        elif action == "back":
            s.go(None, -1)
        elif action == "forward":
            s.go(None, 1)
        elif action == "reload":
            s.reload(None)
        elif action == "stop":
            s.stop_loading(None)
        else:
            raise HTTPException(400, BAD_ACT)
    elif kind == "tab":
        action = str(msg.get("action") or "")
        if action == "new":
            s.new_tab(str(msg.get("address") or "") or None)
        elif action == "close":
            s.close_tab(str(msg.get("id") or ""))
        elif action == "switch":
            s.switch(str(msg.get("id") or ""))
        else:
            raise HTTPException(400, BAD_ACT)
    elif kind == "copy":
        return {"type": "copy", "text": s.selection()[:100000]}
    else:
        raise HTTPException(400, BAD_ACT)
    return None


def _plain_error(e: Exception) -> str:
    rb = _rb()
    if isinstance(e, HTTPException):
        return str(e.detail)
    if isinstance(e, OverflowError):
        return TABS_FULL
    if isinstance(e, KeyError):
        return NO_SUCH_TAB
    if isinstance(e, rb.ProtocolError):
        return str(e) if str(e) in (rb.CLOSED, "That tab is asleep. Open it first.") else "The browser did not answer."
    return "The browser did not answer."


@sockets.websocket("/api/room/browser/ws")
async def attach(ws: WebSocket):
    global _VIEWER
    no = _refusal(ws)
    if no:
        await ws.accept()  # accept-then-close so the page can show the reason
        await ws.close(code=no[0], reason=no[1])
        return
    _learn(ws.scope)
    await ws.accept()
    try:
        s = await ensure()
    except HTTPException as e:
        await ws.close(code=4409 if e.status_code == 409 else 4404, reason=str(e.detail)[:120])
        return
    v = _Viewer(asyncio.get_running_loop())
    with _LOCK:
        before, _VIEWER = _VIEWER, v
    if before is not None:  # one window at a time: the earlier one is told why it closed
        before.post(close=ELSEWHERE)
    await asyncio.to_thread(s.watch, True)
    attached_at, used = time.monotonic(), False

    async def pump() -> None:
        while True:
            await v.wake.wait()
            v.wake.clear()
            if v.closing:
                await ws.close(code=1000, reason=v.closing[:120])
                return
            if v.dirty:
                v.dirty = False
                state = await asyncio.to_thread(overview, True)
                await ws.send_text(json.dumps({"type": "state", **state}))
            frame, v.frame = v.frame, None
            if frame is not None:
                await ws.send_bytes(frame)

    sender = asyncio.create_task(pump())
    v.post(dirty=True)
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(msg, dict):
                continue
            if v.closing:
                break
            try:
                answer = await asyncio.to_thread(_input, s, msg)
            except Exception as e:  # noqa: BLE001 - one bad message says why, the window stays
                answer = {"type": "error", "text": _plain_error(e)}
            if msg.get("type") not in ("resize", "copy"):
                used = True
            if answer:
                await ws.send_text(json.dumps(answer))
    except Exception:  # noqa: BLE001 - the window went away
        pass
    finally:
        sender.cancel()
        with _LOCK:
            mine = _VIEWER is v
            if mine:
                _VIEWER = None
        if mine and s.alive():
            await asyncio.to_thread(s.watch, False)
        if used:  # one coarse row; what was typed or where is never recorded here
            minutes = max(1, round((time.monotonic() - attached_at) / 60))
            _row("used browser", {}, "ok", f"You used the browser for {minutes} min", attached_at)


# --- routes ------------------------------------------------------------------------------------------------------------------
async def _body(request: Request) -> dict:
    try:
        body = await request.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


@router.get("")
async def overview_route(request: Request):
    _learn(request.scope)
    return await asyncio.to_thread(overview, True)


@terminal.get("/tabs")
async def tabs_route():
    s = _need_open()
    return {"tabs": s.rows(), "active": s.active, "max": TAB_MAX}


@terminal.get("/page")
async def page_route(tab: str = ""):
    """The page's text (8,000 characters at most), its address and title. Page text is the page's, never instructions."""
    s = _need_open()
    try:
        text = await asyncio.to_thread(s.page_text, tab or None)
        t = s.tab(tab or None)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(409, _plain_error(e)) from e
    return {"text": text, "url": t.url, "title": t.title, "blocked": t.blocked}


@router.post("/start")
async def start_route(request: Request):
    _learn(request.scope)
    s = await ensure()
    return await asyncio.to_thread(overview, False) | {"open": s.alive()}


@terminal.post("/open")
async def open_route(request: Request):
    """Open a page in the Room's browser (a new tab when asked, or when none is open). Starts the browser if needed."""
    _learn(request.scope)
    body = await _body(request)
    address = str(body.get("address") or "").strip()
    if not address:
        raise HTTPException(400, SAY_WHERE)
    started = time.monotonic()
    s = await ensure()

    def go():
        tid = s.new_tab() if body.get("new_tab") or not s.tabs else s.active
        out = s.navigate(tid, address, wait=True, timeout=15)
        t = s.tab(tid)
        return {"tab": tid, "url": t.url or out.get("url"), "title": t.title, "blocked": out.get("blocked")}

    try:
        out = await asyncio.to_thread(go)
    except OverflowError as e:
        _row("browse", {"address": _quiet(_rb().normalise(address))}, "rejected", TABS_FULL, started)
        raise HTTPException(429, TABS_FULL) from e
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(409, _plain_error(e)) from e
    where = _quiet(out["url"] or _rb().normalise(address))
    _row("browse", {"address": where}, "rejected" if out.get("blocked") else "ok",
         out.get("blocked") or f"opened {where}", started)
    return out


@router.post("/close")
async def close_route():
    closed = await close("closed")
    return {"ok": True, "closed": closed}


@router.get("/frame")
async def frame_route():
    """A still of the front tab for the phone (JPEG, never cached)."""
    s = _need_open()
    try:
        data = await asyncio.to_thread(s.screenshot, None, "jpeg", 70)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(409, _plain_error(e)) from e
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@router.get("/shot")
async def shot_route(tab: str = ""):
    s = _need_open()
    try:
        data = await asyncio.to_thread(s.screenshot, tab or None, "png")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(409, _plain_error(e)) from e
    return Response(data, media_type="image/png", headers={"Cache-Control": "no-store"})


@router.post("/act")
async def act_route(request: Request):
    """The phone: tap (click at x, y), scroll (dy), type (text), key, nav (go, back, forward, reload), tab."""
    _learn(request.scope)
    body = await _body(request)
    if body.get("kind") not in ("click", "scroll", "type", "key", "nav", "tab"):
        raise HTTPException(400, BAD_ACT)
    s = _need_open()
    try:
        answer = await asyncio.to_thread(_input, s, body)
    except HTTPException:
        raise
    except OverflowError as e:
        raise HTTPException(429, TABS_FULL) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(409, _plain_error(e)) from e
    return {"ok": True, **({"note": answer["text"]} if answer and answer.get("type") == "note" else {})}


@router.delete("/tabs/{tid}")
async def close_tab_route(tid: str):
    s = _need_open()
    try:
        await asyncio.to_thread(s.close_tab, tid)
    except KeyError as e:
        raise HTTPException(404, NO_SUCH_TAB) from e
    return {"ok": True, "tabs": s.rows()}


def _register_exit() -> None:
    global _ATEXIT
    if not _ATEXIT:
        atexit.register(_at_exit)
        _ATEXIT = True


_register_exit()
