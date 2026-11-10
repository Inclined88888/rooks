"""The Room (design 0003, sections 4 and 8): Rooks's own computer inside the app.

It is the rooks-try package: a Linux guest when QEMU and an image exist, a private desktop (an X display of its own
with a real terminal in it) when Xvfb exists, else a private folder and shell. It runs in this process when the package
is installed (the usual desktop install; the checkout next to the app also works), or through a separate `rooks-try
serve` when TRY_URL is set. Every blocking call runs off the event loop.

Honesty rules (design section 4): status carries screen, pointer, isolation, a plain label and a note, and the app
shows a picture only when screen is true and input controls only when pointer is true; the drawn terminal is never
chosen on its own and is not a real Room (use_room is not offered for it); a saved point and a start over are checked
against the store before they are reported done; a hand-off out of the Room waits as a held action in Needs you and
copies only after a yes, which the chat tool cannot give itself; and every up, down, checkpoint, reset, run and
hand-off is a row in the run log, on channel "room".

Design 0006 makes the Room a small computer: terminals that live on the server (room_terminal.py), Files
(room_files.py), and status saying what this Room can do (`can`) and which terminals it has. Stop and Start over close
the terminals first; a quick command keeps its two-minute limit and its cut-off note points to a terminal.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sys
import time
import uuid
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response

from . import actions, config, db
from .security import require_user, require_user_or_terminal

log = logging.getLogger("room")
router = APIRouter(prefix="/api/room", dependencies=[Depends(require_user)])
# What the rooks terminal's /room uses (status, start, stop, run) also takes its own key; everything else is the app's.
terminal = APIRouter(prefix="/api/room", dependencies=[Depends(require_user_or_terminal)])

CHANNEL = "room"
TOOL = "use_room"
HANDOFF_REASON = "Copying a file out of the Room always needs your approval."
NOT_INSTALLED = "The Room is not installed on this computer."
NOT_INSTALLED_NOTE = "Install Rooks with its installer to add it. Chat, the browser and this computer still work."
OFF = "The Room is off. Start it to see its screen."
NO_SCREEN = "This Room has no screen. It is a private folder on this computer."
# What each kind of Room is called on a normal screen: plain words that stay true for that kind. The driver's own label
# (which may say shell or terminal) is kept as label_detail, for Advanced.
PLAIN_LABELS = {
    "shell": "A private folder on this computer",
    "nested": "A private desktop on this computer",
    "qemu": "A separate computer inside this one",
    "display": "A picture of a screen, not a computer",
}
PLAIN_FALLBACK = "Rooks's own space on this computer"
_TECH_WORDS = re.compile(r"\b(shell|terminal|bash)\b", re.I)


def plain_label(st: dict | None) -> str:
    """The Room's label in plain words: by its kind, else its own words when they are plain, else a plain line."""
    st = st or {}
    known = PLAIN_LABELS.get(str(st.get("driver") or ""))
    if known:
        return known
    label = str(st.get("label") or "").strip()
    return label if label and not _TECH_WORDS.search(label) else (PLAIN_FALLBACK if label else "")


def _plain_out(out):
    """A driver's own answer (up, down) with the plain label, the exact one kept for Advanced."""
    if isinstance(out, dict) and "label" in out and out.get("driver"):
        out = {**out, "label": plain_label(out), "label_detail": out.get("label") or ""}
    return out
UNREACHABLE = "The Room helper could not be reached."
HELPER_KEY = "The Room helper did not accept the app's key. Check its key under Advanced."
HELPER_FAILED = "The Room helper ran into a problem."
ROOM_OFF = "The Room is off. Start it first."
NEEDS_ON = {"run", "click", "drag", "scroll", "type", "key"}  # actions that work in a Room that is on, never start it
RUN_MAX_S = 120          # a quick command in the Room stops after this; a Room terminal has no limit
TERMINAL_MAX = 4         # Room terminals, live or ended, counted apart from the app terminal's six (room_terminal.MAX)
REMOTE_TIMEOUT_S = 150   # a helper call may carry a whole command
STATUS_KEEP_S = 5.0      # the cheap readers (presence, surfaces) reuse a helper's status answer this long

_ROOM = None                                # the in-process TryRoom, once imported
_REMOTE: tuple[float, dict] | None = None   # (when, status) the helper last answered
_REMOTE_MISS: float | None = None            # when the helper last failed to answer the cheap readers


# --- where the Room is -------------------------------------------------------------------------------------------------
def remote() -> bool:
    return bool(getattr(config, "TRY_URL", "") or "")


def reset() -> None:
    """Forget the in-process Room and the helper's last answer (tests: a new home, driver or address)."""
    global _ROOM, _REMOTE, _REMOTE_MISS
    _ROOM, _REMOTE, _REMOTE_MISS = None, None, None


def _import_room():
    """The in-process Room: the installed package, or the checkout next to the app. None when neither exists."""
    global _ROOM
    if _ROOM is not None:
        return _ROOM
    try:
        from rooks_try.room import TryRoom
    except ImportError:
        root = Path(__file__).resolve().parents[3] / "rooks-try"
        if not (root / "rooks_try").is_dir():
            return None
        if str(root) not in sys.path:
            sys.path.insert(0, str(root))
        try:
            from rooks_try.room import TryRoom
        except ImportError:
            return None
    prefer = os.environ.get("ROOKS_TRY_DRIVER", "").strip() or "auto"
    offline = os.environ.get("ROOKS_TRY_OFFLINE", "").strip().lower() in {"1", "true", "yes", "on"}
    _ROOM = TryRoom(prefer=prefer, offline=offline)
    return _ROOM


def _driver():
    room = _import_room()
    return room.driver() if room else None


def _store():
    import rooks_try.store as store  # importable once _import_room succeeded

    return store


def available() -> bool:
    """The Room exists here: the package is importable, or a helper address is set."""
    return remote() or _import_room() is not None


def enabled() -> bool:
    """A real Room is here: a virtual machine, a private desktop or a private folder and shell, never the drawn
    terminal. The chat tool is offered only when this is true."""
    if remote():  # a helper that only draws a terminal is no Room either
        st = _remote_status_sync()
        return st is not None and st.get("driver") != "display"
    try:
        d = _driver()
    except Exception as e:  # noqa: BLE001 - a driver that cannot start is no Room
        log.debug("room driver unavailable: %s", e.__class__.__name__)
        return False
    return d is not None and d.name != "display"


def running() -> bool:
    """Whether the Room is on. Cheap and never raises: the presence strip asks every second. Through a helper it is
    the helper's last answer."""
    if remote():
        return bool(_REMOTE and _REMOTE[1].get("running"))
    try:
        room = _import_room()
        return bool(room and room.driver().status().get("running"))
    except Exception as e:  # noqa: BLE001
        log.debug("room status unavailable: %s", e.__class__.__name__)
        return False


def describe() -> dict:
    """For /api/surfaces: whether a real Room is here, what it is, and how separate it is. Starts nothing."""
    if remote():
        st = _remote_status_sync()
        if st is None:
            return {"available": False, "label": "", "isolation": "none"}
        return {"available": st.get("driver") != "display", "label": plain_label(st), "isolation": st.get("isolation") or "none"}
    try:
        d = _driver()
    except Exception:  # noqa: BLE001
        d = None
    if d is None:
        return {"available": False, "label": "", "isolation": "none"}
    try:
        st = d.status()
    except Exception:  # noqa: BLE001
        st = {}
    return {"available": d.name != "display", "label": plain_label({"driver": d.name, **st}), "isolation": st.get("isolation") or "none"}


# --- the helper (TRY_URL) --------------------------------------------------------------------------------------------------
def _headers() -> dict:
    key = getattr(config, "TRY_API_KEY", "") or ""
    return {"Authorization": f"Bearer {key}"} if key else {}


def _remote_status_sync() -> dict | None:
    """The helper's status for the cheap readers, kept STATUS_KEEP_S; a helper that did not answer is not asked again
    for as long, so a tool list or a prompt built on the event loop never waits on it twice in a row."""
    global _REMOTE, _REMOTE_MISS
    if _REMOTE and time.monotonic() - _REMOTE[0] < STATUS_KEEP_S:
        return _REMOTE[1]
    if _REMOTE_MISS and time.monotonic() - _REMOTE_MISS < STATUS_KEEP_S:
        return None
    try:
        with httpx.Client(timeout=2.0) as c:
            r = c.get(f"{config.TRY_URL}/api/status", headers=_headers())
        r.raise_for_status()
        st = r.json()
    except (httpx.HTTPError, ValueError) as e:
        log.debug("room helper unavailable: %s", e.__class__.__name__)
        _REMOTE_MISS = time.monotonic()
        return None
    _REMOTE_MISS = None
    _REMOTE = (time.monotonic(), st)
    return st


async def _remote(method: str, path: str, json: dict | None = None, timeout: float = REMOTE_TIMEOUT_S) -> httpx.Response:
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.request(method, f"{config.TRY_URL}{path}", json=json, headers=_headers())
    except httpx.HTTPError as e:
        raise HTTPException(502, UNREACHABLE) from e
    if r.status_code >= 400:
        # The helper's own sign-in is not the person's: a 401 passed through would sign them out of the app.
        if r.status_code in (401, 403):
            raise HTTPException(502, HELPER_KEY)
        if r.status_code >= 500:
            raise HTTPException(502, HELPER_FAILED)
        try:
            detail = r.json().get("detail", r.text)
        except (ValueError, AttributeError):
            detail = r.text
        raise HTTPException(r.status_code if r.status_code in (400, 404, 409) else 502, str(detail)[:300])
    return r


# --- status shape and actions ----------------------------------------------------------------------------------------------
def _shape(st: dict, available: bool = True) -> dict:
    """The /api/room/status contract (design section 8), from a driver's status."""
    return {
        "available": available,
        "running": bool(st.get("running")),
        "screen": bool(st.get("screen")),
        "pointer": bool(st.get("pointer")),
        "isolation": st.get("isolation") or "none",
        "label": plain_label(st) if st.get("driver") else (st.get("label") or ""),  # plain words, every screen
        "label_detail": st.get("label") or "",  # advanced only: the kind's own exact label
        # design 0011, section 3: "job" on Windows (every Room program in a job: they stop together; not a wall)
        "containment": st.get("containment") or "none",
        "note": st.get("note") or "",
        "driver": st.get("driver"),          # advanced only
        "home": st.get("home"),              # advanced only
        "shell": st.get("shell"),            # advanced only: "sh", or "cmd" (Windows Command Prompt); the terminal sees the same
        "offline": bool(st.get("offline")),
        "last_checkpoint": st.get("last_checkpoint"),
        "checkpoints": st.get("checkpoints") or [],
        "checkpoint_limit": st.get("checkpoint_limit"),
        "pruned": st.get("pruned"),
        "error": st.get("error"),
        # design 0006: what this Room can do here (and why it has no terminal: "switched_off" in Settings, "helper",
        # "windows", or None when there is no reason to give), and its terminals (the in-process Room fills these in).
        # terminal_count is the one count: live and ended, what the cap of terminal_max counts.
        # design 0007: the Room's own browser here (can.browser) and why not ("no_engine", "windows", "helper",
        # "switched_off"); `browser` says whether it is open, its tabs and what it last said.
        # run: Rooks can run commands here (use_room run is offered: a real Room, never a drawing)
        "can": {"terminal": False, "files": False, "terminal_off_reason": None, "browser": False,
                "browser_off_reason": None, "run": available and st.get("driver") not in (None, "display")},
        "browser": {"open": False, "tabs": []},
        "terminals": [],
        "terminal_count": 0,
        "terminal_max": TERMINAL_MAX,
    }


def run_cut_note(seconds: float) -> str:
    """What a quick command that hit the limit says (design 0006, section 4.3)."""
    n = int(round(float(seconds)))
    return f"Stopped after {n} second{'' if n == 1 else 's'}. For something long, start it in a Room terminal."


def _unavailable() -> dict:
    return _shape({"label": NOT_INSTALLED, "note": NOT_INSTALLED_NOTE}, available=False)


def _local(room, action: str, body: dict) -> dict:
    """One action on the in-process Room, in a worker thread."""
    if action == "status":
        return _shape(room.status())
    if action == "up":
        return _plain_out(room.up())
    if action == "down":
        return _plain_out(room.down())
    if action == "checkpoint":
        return room.checkpoint(str(body.get("label") or ""))
    if action == "reset":
        return room.reset(str(body.get("name") or "") or None)
    if action == "run":
        return room.run(body["command"], body["timeout"])
    if action == "click":
        return room.click(body["x"], body["y"], body.get("button") or "left", int(body.get("count") or 1))
    if action == "drag":
        return room.drag(body["x1"], body["y1"], body["x2"], body["y2"])
    if action == "scroll":
        return room.scroll(body["x"], body["y"], int(body["dy"]) if body.get("dy") is not None else -3)
    if action == "type":
        return room.type_text(str(body.get("text") or ""))
    if action == "key":
        return room.key(str(body.get("keys") or ""))
    if action == "handoff":  # only perform_handoff gets here, after a person's yes
        return room.handoff(body["src"], body["dest"], approve=True)
    raise HTTPException(404, "The Room cannot do that.")


async def perform(action: str, body: dict | None = None) -> dict:
    """One Room action, in process (off the event loop) or through the helper. Errors are plain, one line."""
    global _REMOTE
    body = dict(body or {})
    if action == "run":
        command = str(body.get("command") or "").strip()
        if not command:
            raise HTTPException(400, "Say what command to run in the Room.")
        try:
            timeout = float(body.get("timeout") or RUN_MAX_S)
        except (TypeError, ValueError) as e:
            raise HTTPException(400, "The time limit must be a number of seconds.") from e
        body.update(command=command, timeout=max(1.0, min(timeout, RUN_MAX_S)))
    if action in NEEDS_ON and not (await perform("status")).get("running"):
        raise HTTPException(409, ROOM_OFF)  # only up starts the Room: it is in the run log and on the presence strip
    if remote():
        if action == "status":
            st = (await _remote("GET", "/api/status", timeout=10)).json()
            _REMOTE = (time.monotonic(), st)
            out = _shape(st)
            out["can"]["terminal_off_reason"] = "helper"  # a helper's Room has no terminal hosted here yet
            out["can"]["browser_off_reason"] = "helper"  # nor a browser
            return out
        out = (await _remote("POST", f"/api/{action}", body)).json()
        if action in ("up", "down") and isinstance(out, dict) and "running" in out:
            _REMOTE = (time.monotonic(), out)
            out = _plain_out(out)
        return _cut_note(action, out, body)
    room = _import_room()
    if room is None:
        if action == "status":
            return _unavailable()
        raise HTTPException(503, NOT_INSTALLED)
    try:
        out = await asyncio.to_thread(_local, room, action, body)
        if action == "status":
            from . import room_browser, room_files, room_terminal

            driver = room.driver()
            out["can"] = await asyncio.to_thread(room_files.can, driver, False)
            out["can"].update(await asyncio.to_thread(room_browser.can, driver, False))
            out["can"]["run"] = getattr(driver, "name", "") not in ("", "display")  # use_room run is offered (enabled())
            out["browser"] = room_browser.overview()
            out["terminals"] = room_terminal.listing()
            out["terminal_count"] = len(out["terminals"])
        return _cut_note(action, out, body)
    except HTTPException:
        raise
    except KeyError as e:
        raise HTTPException(400, f"Missing {e}") from e
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except (ValueError, TypeError) as e:
        raise HTTPException(400, str(e)[:300]) from e
    except Exception as e:  # noqa: BLE001 - the driver's own one-line message
        raise HTTPException(500, str(e)[:300] or e.__class__.__name__) from e


def _cut_note(action: str, out, body: dict):
    """A quick command that hit the limit says so, and where something long belongs."""
    if action == "run" and isinstance(out, dict) and out.get("code") == 124:
        out["error"] = out["note"] = run_cut_note(body.get("timeout") or RUN_MAX_S)
    return out


async def stop() -> dict:
    """Stop the Room: its browser closes and every Room terminal is hung up first (tabs, text and files stay), then
    the Room itself."""
    from . import room_browser, room_terminal

    await room_browser.close("stop")
    closed = await room_terminal.close_all("stop")
    out = await perform("down")
    if isinstance(out, dict):
        out["terminals_closed"] = closed
    return out


async def start_over(name: str | None = None) -> dict:
    """Start over from a saved point: the terminals close first (no shell may stand in a folder being replaced), the
    restore is checked as before, and when the Room is on afterwards one new terminal opens in it. The browser closes
    first too: its profile is in the folder being replaced (sign-ins made since that point are gone)."""
    from . import room_browser, room_terminal

    await room_browser.close("start over")
    closed = await room_terminal.close_all("start over", forget=True)
    meta = await reset_to(name)
    meta["terminals_closed"] = closed
    meta["terminal"] = None
    if not remote():
        st = await perform("status")
        if st.get("running") and (st.get("can") or {}).get("terminal"):
            try:
                t = await room_terminal.open_terminal(owner="person")
                meta["terminal"] = {"id": t.id, "name": t.name}
            except HTTPException as e:  # the Room is back; a terminal that could not open is said, not hidden
                meta["terminal_error"] = str(e.detail)
    return meta


async def list_files(path: str = "") -> dict:
    """The Room's folder, on or off (design 0006, section 3.2). Not in the run log: it only reads."""
    from . import room_files

    if remote():
        raise HTTPException(501, room_files.NOT_HERE)
    room = _import_room()
    if room is None:
        raise HTTPException(503, NOT_INSTALLED)
    driver = await asyncio.to_thread(room.driver)
    if not room_files.can(driver, False)["files"]:
        raise HTTPException(501, room_files.NOT_HERE)
    return await asyncio.to_thread(room_files.listing, path)


async def checkpoint(label: str = "") -> dict:
    """Save a point, and check it is really in the store before saying so (design section 4, rule 4). An open browser
    closes for the copy (its profile is copied whole, its caches left out) and opens again with its tabs after."""
    from . import room_browser

    paused = False if remote() else await room_browser.pause("save point")
    try:
        meta = await _checkpoint(label)
    finally:
        if paused:
            await room_browser.resume()
    meta["browser_reopened"] = bool(paused and room_browser.session() is not None)
    return meta


async def _checkpoint(label: str) -> dict:
    meta = await perform("checkpoint", {"label": label})
    name = meta.get("name") if isinstance(meta, dict) else None
    st = await perform("status")
    there = bool(name) and name in [c.get("name") for c in st.get("checkpoints") or [] if isinstance(c, dict)]
    if there and not remote():
        there = Path(str(meta.get("path") or "")).is_dir()
    if not there:
        raise HTTPException(500, "The point could not be confirmed, so it is not saved. Try again.")
    meta.update(verified=True, evidence=f"point {name} is in the store")
    return meta


async def reset_to(name: str | None = None) -> dict:
    """Start over from a saved point, and check the store really restored it before saying so."""
    meta = await perform("reset", {"name": name or ""})
    restored = meta.get("name") if isinstance(meta, dict) else None
    ok = bool(restored) and bool(meta.get("restored"))
    if ok and not remote():
        state = await asyncio.to_thread(_store().load_state)
        ok = (state.get("last_restore") or {}).get("name") == restored and _store().guest_home().is_dir()
    if not ok:
        raise HTTPException(500, "Starting over could not be confirmed. The Room was left as it was.")
    meta.update(verified=True, evidence=f"the Room's folder is back at point {restored}")
    return meta


# --- hand-off: out of the Room only after a yes ------------------------------------------------------------------------------
def _waiting_handoff(src: str, dest: str) -> dict | None:
    """A hand-off for the same file and place that still waits for an answer, anywhere: the Room is one."""
    for a in actions.pending():
        if a["tool"] != TOOL:
            continue
        try:
            args = json.loads(a["args"] or "{}")
        except ValueError:
            continue
        if not isinstance(args, dict) or args.get("action") != "handoff":
            continue
        if (str(args.get("src") or "").strip(), str(args.get("dest") or "").strip()) == (src, dest) and args.get("request_id"):
            return {"action_id": a["id"], "request_id": str(args["request_id"])}
    return None


def request_handoff(src: str, dest: str, conversation_id: int | None = None, channel: str = CHANNEL) -> dict:
    """Hold the copy as an approval in Needs you (a held use_room call in the run log). Nothing is copied here.
    Asking again for the same file and place before the answer joins the request that is already waiting (B3):
    Needs you shows it once."""
    src, dest = str(src or "").strip(), str(dest or "").strip()
    if not src or not dest:
        raise HTTPException(400, "Say which file to copy out of the Room and where to put it.")
    from . import front_door, push

    waiting = _waiting_handoff(src, dest)
    if waiting:
        return {"ok": False, "held": True, "request_id": waiting["request_id"], "action_id": waiting["action_id"],
                "needs_you_id": f"a:{waiting['action_id']}", "already_asked": True,
                "summary": f"Copy {src} from the Room to {dest} on this computer?",
                "note": "Nothing was copied. That copy is already waiting for your OK in Needs you; it was not asked for twice."}
    rid = "room:" + uuid.uuid4().hex
    args = json.dumps({"action": "handoff", "src": src, "dest": dest, "request_id": rid})
    cid = conversation_id or front_door.main_conversation()
    aid = actions.add("tool_call", "held", trace={"channel": channel, "conversation_id": cid}, tool=TOOL, effect="external",
                      payload=args, args=args, detail=HANDOFF_REASON, request_id=rid)
    try:
        push.approval_needed(aid, TOOL)
    except Exception:  # noqa: BLE001 - a missing phone is no reason to lose the request
        pass
    return {"ok": False, "held": True, "request_id": rid, "action_id": aid, "needs_you_id": f"a:{aid}",
            "summary": f"Copy {src} from the Room to {dest} on this computer?",
            "note": "Nothing was copied. It waits for your OK in Needs you."}


def handoff_request(request_id: str) -> dict | None:
    """A held hand-off and where it stands (pending, approved with the copy still to make, done, failed, denied),
    with the file and place the request was for."""
    if not request_id:
        return None
    row = db.one("SELECT id FROM actions WHERE request_id = ? AND kind = 'tool_call' AND tool = ? AND outcome = 'held'",
                 request_id, TOOL)
    if not row:
        return None
    a = actions.approval(row["id"])
    try:
        args = json.loads(a["args"] or "{}")
    except ValueError:
        args = {}
    args = args if isinstance(args, dict) else {}
    return {"action_id": row["id"], "status": a["status"], "src": str(args.get("src") or ""), "dest": str(args.get("dest") or "")}


def approved(request_id: str) -> bool:
    """Whether a person said yes to this hand-off and the copy is still to be made."""
    req = handoff_request(request_id)
    return bool(req and req["status"] == "approved")


async def perform_handoff(src: str, dest: str, request_id: str) -> dict:
    """Copy out of the Room under a request a person approved in Needs you, once. Refuses anything else."""
    req = handoff_request(request_id)
    if not req:
        raise HTTPException(404, "No such request.")
    src, dest = str(src or "").strip(), str(dest or "").strip()
    if (req["src"], req["dest"]) != (src, dest):
        raise HTTPException(409, "That OK was for a different file or place.")
    if req["status"] == "pending":
        return {"ok": False, "held": True, "request_id": request_id, "action_id": req["action_id"],
                "needs_you_id": f"a:{req['action_id']}", "note": "Still waiting for your OK in Needs you."}
    if req["status"] == "denied":
        raise HTTPException(409, "You said no to that copy.")
    if req["status"] == "done":
        return {"ok": True, "already": True, "request_id": request_id, "note": "That file was already copied after your OK."}
    if req["status"] == "failed":
        raise HTTPException(409, "That copy failed after your OK. Ask for it again.")
    out = await perform("handoff", {"src": src, "dest": dest, "approve": True})  # the yes is on record: this is the copy
    if not isinstance(out, dict) or not out.get("ok"):
        raise HTTPException(400, (out or {}).get("error") or "The file could not be copied.")
    out["request_id"] = request_id
    return out


# --- the run log --------------------------------------------------------------------------------------------------------------
def _summary(action: str, out) -> str:
    if not isinstance(out, dict):
        return ""
    if action in ("up", "down"):
        closed = f"; {out['terminals_closed']} terminals closed" if out.get("terminals_closed") else ""
        return f"running: {out.get('running')}; {out.get('label') or ''}{closed}"
    if action == "run":
        return f"exit {out.get('code')}; {(out.get('stdout') or out.get('error') or '')[:200]}"
    if action == "checkpoint":
        return f"point {out.get('name')}"
    if action == "reset":
        closed = f"; {out['terminals_closed']} terminals closed" if out.get("terminals_closed") else ""
        return f"back at point {out.get('name')}{closed}"
    if action == "handoff":
        return f"copied {out.get('from')} to {out.get('to')}"
    return ""


def _record(action: str, args: dict, outcome: str, detail: str, started: float, verified: bool | None = None,
            evidence: str = "", failure: str = "") -> int:
    return actions.add("tool_call", outcome, trace={"channel": CHANNEL}, tool=TOOL, effect="external",
                       args=actions.args_preview(json.dumps({"action": action, **args}, ensure_ascii=False, default=str)),
                       detail=detail[:500], latency_ms=int((time.monotonic() - started) * 1000),
                       verified=None if verified is None else int(verified), evidence=evidence, failure_reason=failure[:500])


async def _audited(action: str, args: dict, call) -> dict:
    """Run a Room action for a route and put it in the run log (channel room, tool use_room). A request that only
    waits, or a copy already made, adds no row: the held action is the record."""
    started = time.monotonic()
    try:
        out = await call()
    except HTTPException as e:  # a refused request is "rejected", a Room that failed is "tool_error", as in a chat turn
        _record(action, args, "tool_error" if e.status_code >= 500 else "rejected", str(e.detail), started, failure=str(e.detail))
        raise
    if isinstance(out, dict) and (out.get("held") or out.get("already")):
        return out
    verified = out.get("verified") if isinstance(out, dict) else None
    evidence = str(out.get("evidence") or "") if isinstance(out, dict) else ""
    _record(action, args, "verified" if verified else "ok", _summary(action, out), started, verified, evidence)
    return out


# --- routes ------------------------------------------------------------------------------------------------------------------------
async def _body(request: Request) -> dict:
    try:
        body = await request.json()
    except ValueError as e:
        raise HTTPException(400, "The request could not be read.") from e
    return body if isinstance(body, dict) else {}


@terminal.get("/status")
async def status():
    """What the Room is and how it stands: available, running, screen, pointer, isolation, a plain label and note,
    the saved points. The driver and folder are for the Advanced view only."""
    return await perform("status")


@terminal.post("/up")
async def up():
    return await _audited("up", {}, lambda: perform("up"))


@terminal.post("/down")
async def down():
    return await _audited("down", {}, stop)


# Save a point, start over and hand off also take the rooks terminal's Terminal access token (design 0006, section 6:
# /room save, /room back, /room handoff). A bridge key still only reads; a hand-off still waits for a person's yes.
@terminal.post("/checkpoint")
async def save_point(request: Request):
    label = str((await _body(request)).get("label") or "")
    return await _audited("checkpoint", {"label": label}, lambda: checkpoint(label))


@terminal.post("/reset")
async def reset_route(request: Request):
    name = str((await _body(request)).get("name") or "")
    return await _audited("reset", {"name": name}, lambda: start_over(name or None))


@terminal.get("/files")
async def files(path: str = ""):
    """What is in the Room's folder (one level), whether the Room is on or off. Never outside it."""
    return await list_files(path)


@terminal.post("/run")
async def run(request: Request):
    body = await _body(request)
    return await _audited("run", {"command": body.get("command"), "timeout": body.get("timeout")}, lambda: perform("run", body))


@router.post("/click")
async def click(request: Request):
    return await perform("click", await _body(request))


@router.post("/drag")
async def drag(request: Request):
    return await perform("drag", await _body(request))


@router.post("/scroll")
async def scroll(request: Request):
    return await perform("scroll", await _body(request))


@router.post("/type")
async def type_text(request: Request):
    return await perform("type", await _body(request))


@router.post("/key")
async def key(request: Request):
    return await perform("key", await _body(request))


@terminal.post("/handoff")
async def handoff(request: Request):
    """Copy a file out of the Room. Without an approved request this holds the copy in Needs you and copies nothing;
    with one it copies once."""
    body = await _body(request)
    src, dest, rid = body.get("src"), body.get("dest"), str(body.get("request_id") or "").strip()
    if not rid:
        return request_handoff(src, dest)  # the held row is the record
    return await _audited("handoff", {"src": src, "dest": dest, "request_id": rid}, lambda: perform_handoff(src, dest, rid))


@router.get("/screenshot")
async def screenshot():
    """The Room's screen as a PNG (never cached), only when it has a real one and is on."""
    if remote():
        r = await _remote("GET", "/api/screenshot", timeout=20)  # the helper answers 404 without a screen or when off
        return Response(r.content, media_type="image/png", headers={"Cache-Control": "no-store"})
    room = _import_room()
    if room is None:
        raise HTTPException(404, NOT_INSTALLED)
    st = await perform("status")
    if not st["screen"]:
        raise HTTPException(404, NO_SCREEN)
    if not st["running"]:
        raise HTTPException(404, OFF)
    try:
        path = await asyncio.to_thread(room.screenshot)
    except Exception as e:  # noqa: BLE001
        if not (await perform("status"))["running"]:  # stopped between the check and the capture: off, not broken
            raise HTTPException(404, OFF) from e
        raise HTTPException(500, str(e)[:300] or "The screen could not be captured.") from e
    return Response(Path(path).read_bytes(), media_type="image/png", headers={"Cache-Control": "no-store"})
