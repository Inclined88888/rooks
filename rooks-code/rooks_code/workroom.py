"""/room, /needs and the app's half of /jobs: the Workroom from the terminal, through the Rooks app on this computer.

The terminal uses the key it already has: the app.json bridge key, or the Terminal access token from the app's
settings. The app lets either reach exactly these routes (room status, start, stop and run; Needs you; the Jobs board),
with the terminal's channel header. An older app refuses them, and the terminal says so in plain words instead of
pretending. Nothing here runs the Room or answers an approval itself: the app does, and records it like a click in
the app.
"""

from __future__ import annotations

import importlib
import json
import re
import shlex
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

from . import talk

RUN_WAIT_S = 330  # the Room's quick path stops a command after 120 s; a Room terminal has no limit


class Refused(Exception):
    """The app did not accept this terminal's key for that route (an app older than the terminal's Workroom access)."""


class Unreachable(Exception):
    pass


class Said(Exception):
    """The app answered with a reason (its reasons are plain words by design)."""


OLDER_ROUTE = "The Rooks app on this computer does not have that yet. Update the app, then try again."


def link_of(agent) -> dict | None:
    s = agent.s
    if getattr(s, "provider", "") == "workbench" and getattr(s, "base_url", "") and getattr(s, "api_key", ""):
        return {"url": s.base_url.rstrip("/").removesuffix("/v1"), "key": s.api_key}
    return talk.link_from(None, None)


def call(link: dict, method: str, path: str, body: dict | None = None, timeout: float = 30):
    req = urllib.request.Request(
        link["url"].rstrip("/") + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {link['key']}", "Content-Type": "application/json", "X-Workbench": "1",
                 "X-Workbench-Channel": "rooks-code"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
        return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise Refused() from None
        try:
            detail = json.loads(e.read() or b"{}").get("detail")
        except (ValueError, AttributeError):
            detail = None
        if e.code == 404 and str(detail or "").strip().lower() == "not found":  # the app has no such route at all
            raise Said(OLDER_ROUTE) from None
        raise Said(detail if isinstance(detail, str) and detail else "The app could not do that.") from None
    except (urllib.error.URLError, OSError, ValueError):
        raise Unreachable() from None


UNREACHABLE = "  Can't reach the Rooks app right now. Is it open on this computer?"
# A key the app refuses: an app older than this terminal, or a key from another app. Said plainly, never faked.
OLDER_APP = ("  The Rooks app did not let this terminal {what}. Starting the Room or answering Needs you from here needs the"
             " terminal's own sign in: in the app open Settings, Terminal access, then run rooks login. If the app is older"
             " than this terminal, update it. Or {where} in the app.")


# --- /room ------------------------------------------------------------------------------------------------------------
# The words match the Room page in the app (workbench/frontend/src/room/words.ts and design record 0006): On, Off, Save
# a point, Start over, Needs you, Hand off a file, and the honest line.
ISOLATION = {"none": "It runs as you; it is not locked off.", "namespace": "It runs in a space of its own on this computer.",
             "vm": "It is a separate computer."}
HONEST_LINE = "Commands run as you, in a folder of its own. It is not a locked off computer."
VM_LINE = "A separate computer. Commands run inside it, apart from your files."
OFF_KEPT = "The Room is off. Everything in it is kept."
NOT_HERE = "  The Room's terminal opens in the app on this computer."
CUT_OFF = "Stopped after 120 seconds. For something long: /room open COMMAND"
ROOM_USE = ("  /room start  ·  /room stop  ·  /room open COMMAND  ·  /room tail  ·  /room files  ·  /room points  ·  /room shell"
            "  ·  /help lists every one")
TAIL_LINES = 60

# What the status line shows: whether a command Rooks started in a Room terminal is still running, as last seen by a
# /room verb (asked when the person next runs one; never polled).
_SEEN = {"working": False, "last_rooks": None}


def room_working() -> bool:
    """True while the last /room verb saw a command Rooks started in a Room terminal still running."""
    return bool(_SEEN["working"])


def _note_terminals(terms: list) -> None:
    _SEEN["working"] = any(t.get("owner") == "rooks" and t.get("alive") and t.get("busy") for t in terms)


def honest_line(st: dict) -> str:
    """The page's honest line (commandViewLine): the same words, never under Advanced."""
    if st.get("isolation") == "vm":
        return (st.get("note") or "").strip() or VM_LINE
    return HONEST_LINE


def _plural(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


def _elapsed(seconds) -> str:
    s = int(seconds or 0)
    if s < 60:
        return "under a minute"
    m = s // 60
    if m < 60:
        return f"{m} min"
    h, m = divmod(m, 60)
    return f"{h} h {m} min" if m else f"{h} h"


_POINT = re.compile(r"^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})-(.+)$")


def point_line(name: str) -> str:
    """A saved point as the page says it (pointLine): its label, then the day and time it was saved."""
    m = _POINT.match(name or "")
    if not m:
        return re.sub(r"[-_]+", " ", name or "").strip()
    label = re.sub(r"[-_]+", " ", re.sub(r"-\d{2}$", "", m.group(7))).strip() or "save"
    try:
        when = datetime(*(int(m.group(i)) for i in range(1, 7)))
    except ValueError:
        return label
    return f"{label} · {when.day} {when.strftime('%b')}, {when:%H:%M}"


def terminal_line(t: dict) -> str:
    """One Room terminal in plain words: "Terminal 1 · yours", "Rooks · running, 3 min", "Rooks · ended, code 0"."""
    words = ["yours"] if t.get("owner") == "person" else []
    if not t.get("alive"):
        if t.get("ended_reason") == "restart":
            words.append("ended when the app restarted")
        else:
            words.append("ended" + (f", code {t['exit_code']}" if t.get("exit_code") is not None else ""))
    elif t.get("busy"):
        words.append("running" + (f", {_elapsed(t.get('elapsed_s'))}" if t.get("owner") == "rooks" else ""))
    elif t.get("owner") == "rooks":
        words.append("open")
    return f"{t.get('name') or 'A terminal'} · {', '.join(words)}"


def _room_status(ui, st: dict) -> None:
    if not st.get("available", True):
        ui.p("  " + (st.get("label") or "The Room is not on this computer."))
        if st.get("note"):
            ui.p(ui.c("dim", "  " + st["note"]))
        return
    on = bool(st.get("running"))
    ui.p("  The Room  ·  " + (ui.c("accent", "On") if on else "Off"))
    if st.get("label"):
        ui.p("  " + st["label"])
    honest = honest_line(st)
    note = st.get("note") or ISOLATION.get(st.get("isolation") or "", "")
    if note and note.strip() not in honest:
        ui.p(ui.c("dim", "  " + note))
    ui.p(ui.c("dim", "  " + honest))
    if not st.get("screen"):
        ui.p(ui.c("dim", "  No screen to watch here: what it does shows as text."))
    terms = st.get("terminals")
    if isinstance(terms, list):
        _note_terminals(terms)
        if terms:
            ui.p(f"  Terminals  ·  {len(terms)} of {st.get('terminal_max') or 4}")
            for t in terms:
                line = "    " + terminal_line(t)
                ui.p(line if t.get("alive") else ui.c("dim", line))
    if st.get("last_checkpoint"):
        last = st["last_checkpoint"]
        said = (point_line(last["name"]) if last.get("name") else last.get("label")) if isinstance(last, dict) else last
        ui.p(ui.c("dim", f"  Last saved point: {said}"))
    ui.p(ui.c("dim", ROOM_USE))


def _show_run(ui, out: dict) -> None:
    text = ((out.get("stdout") or "") + (out.get("stderr") or "")).rstrip("\n")
    lines = text.splitlines()
    for line in lines[:60]:
        ui.p(ui.c("dim", "    ") + line)
    if len(lines) > 60:
        ui.p(ui.c("dim", f"    … {len(lines) - 60} more lines"))
    if out.get("code") == 124:  # the quick path's two minutes ran out; a Room terminal has no limit
        ui.p(ui.c("error", "  " + CUT_OFF))
    elif out.get("error"):
        ui.p(ui.c("error", "  " + str(out["error"])))
    elif out.get("code") not in (0, None):
        ui.p(ui.c("error", f"  It ended with an error (code {out['code']})."))
    elif not lines:
        ui.p(ui.c("dim", "  Done, nothing printed."))


def _yes(ui, question: str) -> bool:
    """Ask first, the way the page's inline confirm does: only y or yes goes ahead."""
    ui.p("  " + question)
    try:
        line = sys.stdin.readline()
    except (KeyboardInterrupt, EOFError, OSError, ValueError):
        line = ""
    return line.strip().lower() in ("y", "yes")


# --- the Room's terminals ---------------------------------------------------------------------------------------------
def _terminals(link: dict) -> list:
    out = call(link, "GET", "/api/room/terminals")
    terms = out.get("terminals") if isinstance(out, dict) else None
    terms = [t for t in terms or [] if isinstance(t, dict)]
    _note_terminals(terms)
    return terms


def _named(terms: list, name: str) -> dict | None:
    want = " ".join(name.split()).lower()
    return next((t for t in terms if " ".join(str(t.get("name") or "").split()).lower() == want), None) if want else None


def _name_then_text(terms: list, rest: str) -> tuple[dict | None, str]:
    """A terminal's name may have spaces ("Terminal 1"): the longest run of first words that names one wins."""
    words = list(re.finditer(r"\S+", rest))
    for i in range(len(words), 0, -1):
        t = _named(terms, " ".join(w.group() for w in words[:i]))
        if t:
            return t, rest[words[i - 1].end():].strip()
    return None, rest


def _no_such(ui, name: str) -> None:
    ui.p(f"  No terminal called {name} in the Room. /room lists them.")


def _tid(t: dict) -> str:
    return urllib.parse.quote(str(t.get("id") or ""), safe="")


def _room_open(ui, link: dict, command: str) -> None:
    if not command:
        ui.p("  Say what to run: /room open ./install.sh")
        return
    out = call(link, "POST", "/api/room/terminals", {"name": "Rooks", "command": command})
    _SEEN.update(working=True, last_rooks=out.get("id"))
    ui.p(f"  Started in the Room's terminal \"{out.get('name') or 'Rooks'}\". /room tail shows how it goes.")


def _room_tail(ui, link: dict, name: str) -> None:
    terms = _terminals(link)
    if name:
        t = _named(terms, name)
        if not t:
            _no_such(ui, name)
            return
    else:  # the one Rooks started last, else Rooks's newest, else the newest terminal
        rooks = [x for x in terms if x.get("owner") == "rooks"]
        t = next((x for x in terms if x.get("id") == _SEEN["last_rooks"]), None) or (rooks or terms or [None])[-1]
        if not t:
            ui.p("  No terminals in the Room yet. /room open COMMAND starts one.")
            return
    out = call(link, "GET", f"/api/room/terminals/{_tid(t)}/tail?lines={TAIL_LINES}")
    label = t.get("name") or "The terminal"
    ui.p(ui.c("dim", f"  {label}  ·  last lines"))
    for line in str(out.get("text") or "").splitlines()[-TAIL_LINES:]:
        ui.p(ui.c("dim", "    ") + line)
    if t.get("owner") == "rooks":
        _SEEN["working"] = bool(out.get("alive") and out.get("busy"))
    code = out.get("exit_code")
    if out.get("taken"):
        ui.p(ui.c("dim", "  You took this terminal; Rooks waits."))
    if out.get("alive") and out.get("busy"):
        ui.p("  " + ui.c("accent", f"{label}: still running ({_elapsed(out.get('elapsed_s'))})."))
    elif out.get("alive"):
        if code is None:
            ui.p(ui.c("dim", f"  {label}: waiting for a command."))
        else:
            ui.p(ui.c("dim" if code == 0 else "error", f"  {label}: the last command ended with code {code}."))
    elif out.get("ended_reason") == "restart" or t.get("ended_reason") == "restart":
        ui.p(ui.c("dim", "  The app restarted, so this terminal ended. Your files and anything you installed are still here."))
    else:
        ui.p(ui.c("dim", "  This terminal ended" + (f" with code {code}." if code is not None else ".")
                  + " Its files are still in the Room."))


def _room_send(ui, link: dict, rest: str) -> None:
    terms = _terminals(link)
    t, text = _name_then_text(terms, rest)
    if not t:
        ui.p("  Say which terminal, then what to type: /room send Terminal 1 ls. /room lists them.")
        return
    if not text:
        ui.p(f"  Say what to type: /room send {t.get('name')} ls")
        return
    call(link, "POST", f"/api/room/terminals/{_tid(t)}/send", {"text": text, "enter": True})
    ui.p(f"  Sent to {t.get('name')}. /room tail {t.get('name')} shows what it printed.")


def _room_close(ui, link: dict, name: str) -> None:
    if not name:
        ui.p("  Say which terminal: /room close Terminal 1. /room lists them.")
        return
    t = _named(_terminals(link), name)
    if not t:
        _no_such(ui, name)
        return
    label = t.get("name")
    question = (f"Close {label}? What it is running stops. (y/N)" if t.get("alive")
                else f"Close {label}? Its last lines go with it. (y/N)")
    if not _yes(ui, question):
        ui.p(f"  Kept {label}.")
        return
    call(link, "DELETE", f"/api/room/terminals/{_tid(t)}")
    if _SEEN["last_rooks"] == t.get("id"):
        _SEEN.update(last_rooks=None, working=False)
    ui.p(f"  Closed {label}.")


# --- the Room's files and saved points --------------------------------------------------------------------------------
def _size(n) -> str:
    if not isinstance(n, (int, float)):
        return ""
    if n < 1024:
        return "1 byte" if n == 1 else f"{int(n)} bytes"
    for unit in ("KB", "MB", "GB"):
        n /= 1024
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if n >= 10 or unit == "KB" else f"{n:.1f} {unit}"
    return ""


def _when(iso) -> str:
    try:
        d = datetime.fromisoformat(str(iso).replace("Z", "+00:00")).astimezone()
    except (TypeError, ValueError):
        return ""
    now = datetime.now().astimezone()
    if d.date() == now.date():
        return f"today {d:%H:%M}"
    return f"{d.day} {d.strftime('%b')}" + ("" if d.year == now.year else f" {d.year}")


def _room_files(ui, link: dict, where: str) -> None:
    where = where.strip()
    where = where[2:] if where.startswith("~/") else ("" if where == "~" else where)
    out = call(link, "GET", "/api/room/files" + (f"?path={urllib.parse.quote(where)}" if where else ""))
    crumbs = [out.get("root_label") or "Home"] + [p for p in str(out.get("path") or "").split("/") if p]
    ui.p("  Files  ·  " + " › ".join(crumbs))
    entries = [e for e in out.get("entries") or [] if isinstance(e, dict)]
    if not entries:
        ui.p(ui.c("dim", "  Nothing here yet. What you install or save in the terminal shows up here."))
        return
    width = min(max(len(str(e.get("name") or "")) for e in entries), 40)
    for e in entries:
        kind = e.get("kind")
        meta = "folder" if kind == "folder" else "link" if kind == "link" else _size(e.get("size"))
        ui.p(f"    {str(e.get('name') or ''):<{width}}  {meta:<9}  " + ui.c("dim", _when(e.get("modified"))))
    if out.get("truncated"):
        ui.p(ui.c("dim", "  Showing the first 500. Use the terminal to see more."))


def _points(st: dict) -> list[str]:
    names = [c.get("name") if isinstance(c, dict) else c for c in st.get("checkpoints") or []]
    return sorted((str(n) for n in names if n), reverse=True)  # names start with when they were saved: newest first


def _room_points(ui, link: dict) -> None:
    points = _points(call(link, "GET", "/api/room/status"))
    if not points:
        ui.p("  No saved points yet. Save one before trying something you might want to undo: /room save LABEL")
        return
    ui.p(f"  Saved points  ·  {len(points)}")
    for i, name in enumerate(points, 1):
        ui.p(f"  {i:>3}  {point_line(name)}")
    ui.p(ui.c("dim", "  /room back N starts over from one (it asks first). /room save LABEL saves a new one."))


def _room_save(ui, link: dict, label: str) -> None:
    ui.p(ui.c("dim", "  Saving a point. The Room's files are copied as they are now; a big folder can take a while."))
    out = call(link, "POST", "/api/room/checkpoint", {"label": label}, timeout=900)
    if not out.get("verified"):
        ui.p("  The point could not be confirmed, so it is not saved. Try again.")
        return
    ui.p("  " + ui.c("ok", f"Saved a point{': ' + label if label else ''}."))
    removed = out.get("removed") or []
    if removed:
        ui.p(ui.c("dim", f"  Older points are removed once there are 20; {_plural(len(removed), 'was', 'were')} removed now."))


def _pick_point(points: list[str], arg: str) -> str | None:
    if not arg:
        return points[0] if len(points) == 1 else None
    if arg.isdigit():
        n = int(arg)
        return points[n - 1] if 1 <= n <= len(points) else None
    if arg in points:
        return arg
    want = " ".join(re.sub(r"[-_]+", " ", arg).split()).lower()
    return next((p for p in points if point_line(p).split(" · ")[0].lower() == want), None)


def _room_back(ui, link: dict, arg: str) -> None:
    points = _points(call(link, "GET", "/api/room/status"))
    if not points:
        ui.p("  No saved points yet. /room save LABEL saves one.")
        return
    name = _pick_point(points, arg)
    if not name:
        ui.p("  Say which point: /room back 1 (the number from /room points).")
        return
    if not _yes(ui, f"Yes to start over from {point_line(name)}? Anything done since is lost and open terminals close. (y/N)"):
        ui.p("  Nothing changed.")
        return
    out = call(link, "POST", "/api/room/reset", {"name": name}, timeout=900)
    if not out.get("verified"):
        ui.p("  Starting over could not be confirmed. The Room was left as it was.")
        return
    closed = int(out.get("terminals_closed") or 0)
    ui.p("  " + ui.c("ok", f"The Room is back at {point_line(out.get('name') or name)}.")
         + (f" {_plural(closed, 'terminal', 'terminals')} closed." if closed else ""))
    if isinstance(out.get("terminal"), dict) and out["terminal"].get("name"):
        ui.p(ui.c("dim", f"  {out['terminal']['name']} is open again."))


def _room_handoff(ui, link: dict, arg: str) -> None:
    try:
        parts = shlex.split(arg)
    except ValueError:
        parts = []
    if len(parts) != 2:
        ui.p("  Say which file and where it goes: /room handoff Desktop/notes.txt ~/Desktop")
        return
    out = call(link, "POST", "/api/room/handoff", {"src": parts[0], "dest": parts[1]})
    if out.get("held") and out.get("already_asked"):
        ui.p("  That copy is already waiting for your OK in Needs you (/needs). It was not asked for twice.")
    elif out.get("held"):
        ui.p("  Waiting for your OK in Needs you (/needs). Nothing is copied until you say yes.")
    elif out.get("already"):
        ui.p("  That file was already copied after your OK.")
    else:
        ui.p("  " + str(out.get("note") or "The app did not say what happened to the file."))


# --- /room shell: the same login shell, right here ---------------------------------------------------------------------
def _on_this_computer(url: str) -> bool:
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    return host in ("localhost", "::1") or host.startswith("127.")


def _room_shell(ui, link: dict) -> None:
    """The Room's own login shell in this terminal: the same wrapper, home and profile the app's Room terminal uses
    (rooks_try's login_argv and room_env). A child process, so Rooks comes back after exit."""
    st = call(link, "GET", "/api/room/status")
    home = st.get("home")
    shell = None
    if (st.get("can") or {}).get("terminal") and home and _on_this_computer(link["url"]):
        try:
            shell = importlib.import_module("rooks_try.drivers.shell")
        except Exception:  # noqa: BLE001 - rooks-try not installed beside this terminal: the app has the terminal
            shell = None
    if not (shell and callable(getattr(shell, "login_argv", None)) and callable(getattr(shell, "room_env", None))):
        ui.p(NOT_HERE)
        return
    if not st.get("running"):
        ui.p("  The Room is off. Start it first: /room start")
        return
    offline = bool(st.get("offline"))
    argv = shell.login_argv(Path(home), offline)
    env = shell.room_env(Path(home), offline)
    ui.p(ui.c("dim", "  A shell inside the Room. What you install here stays. Type exit to come back to Rooks."))
    try:
        subprocess.call(argv, env=env)
    except OSError:
        ui.p("  The Room's shell could not start here." + NOT_HERE)
        return
    ui.p(ui.c("dim", "  Back in Rooks."))


def room_command(agent, ui, rest: str = "") -> None:
    parts = rest.strip().split(None, 1)
    sub = parts[0].lower() if parts else "status"
    arg = parts[1].strip() if len(parts) > 1 else ""
    link = link_of(agent)
    if not link:
        ui.p("  The Room is part of the Rooks app. Open the app on this computer, then try /room again.")
        return
    try:
        if sub in ("status", "show"):
            _room_status(ui, call(link, "GET", "/api/room/status"))
        elif sub in ("start", "up", "on"):
            out = call(link, "POST", "/api/room/up", timeout=120)
            ui.p("  The Room is " + ui.c("accent", "on") + "." if out.get("running") else "  The Room did not start.")
        elif sub in ("stop", "down", "off"):
            out = call(link, "POST", "/api/room/down", timeout=60)
            if out.get("running"):
                ui.p("  The Room is still on.")
            else:
                closed = int(out.get("terminals_closed") or 0)
                _SEEN["working"] = False
                ui.p(f"  {OFF_KEPT}" + (f" {_plural(closed, 'terminal', 'terminals')} closed." if closed else ""))
        elif sub == "run":
            if not arg:
                ui.p("  Say what to run: /room run ls")
                return
            _show_run(ui, call(link, "POST", "/api/room/run", {"command": arg}, timeout=RUN_WAIT_S))
        elif sub == "open":
            _room_open(ui, link, arg)
        elif sub == "tail":
            _room_tail(ui, link, arg)
        elif sub == "send":
            _room_send(ui, link, arg)
        elif sub == "close":
            _room_close(ui, link, arg)
        elif sub == "files":
            _room_files(ui, link, arg)
        elif sub == "points":
            _room_points(ui, link)
        elif sub == "save":
            _room_save(ui, link, arg)
        elif sub == "back":
            _room_back(ui, link, arg)
        elif sub == "handoff":
            _room_handoff(ui, link, arg)
        elif sub == "shell":
            _room_shell(ui, link)
        else:
            ui.p(ROOM_USE)
    except Refused:
        ui.p(OLDER_APP.format(what="open the Room", where="open the Room"))
    except Unreachable:
        ui.p(UNREACHABLE)
    except Said as e:
        ui.p(f"  {e}")


# --- /needs -----------------------------------------------------------------------------------------------------------
APPROVE = ("approve", "yes", "ok", "allow")
DENY = ("deny", "no", "refuse")


def _answered(answer: str, status) -> str:
    """What the app did with the answer: approved (it runs, or the asker runs it), done, failed, held again, denied."""
    if answer == "deny" or status == "denied":
        return "Denied"
    if status == "failed":
        return "Approved, but it did not work"
    if status == "held":
        return "Approved; it asks once more in Needs you"
    return "Approved"


def needs_command(agent, ui, rest: str = "") -> None:
    parts = rest.strip().split()
    verb = parts[0].lower() if parts else ""
    link = link_of(agent)
    if not link:
        ui.p("  Needs you lives in the Rooks app. Open the app on this computer, then try /needs again.")
        return
    try:
        items = call(link, "GET", "/api/needs-you")
        items = items if isinstance(items, list) else []
        if verb in APPROVE + DENY:
            n = parts[1] if len(parts) > 1 else ("1" if len(items) == 1 else "")
            if not (n.isdigit() and 1 <= int(n) <= len(items)):
                ui.p("  Nothing needs you." if not items else "  Say which one: /needs approve 1 (the number from /needs).")
                return
            item = items[int(n) - 1]
            answer = "approve" if verb in APPROVE else "deny"
            out = call(link, "POST", f"/api/needs-you/{urllib.parse.quote(str(item['id']), safe=':')}/{answer}")
            ui.p(f"  {_answered(answer, out.get('status'))}: {item.get('title') or 'that'}")
            return
        if verb:
            ui.p("  /needs lists what waits for your OK  ·  /needs approve N  ·  /needs deny N")
            return
        if not items:
            ui.p("  Nothing needs you.")
            return
        ui.p("  " + ui.c("accent", f"Needs you  ·  {len(items)}"))
        for i, it in enumerate(items[:30], 1):
            detail = " ".join(str(it.get("detail") or "").split())[:90]
            ui.p(f"  {i:>2}  {it.get('title') or 'Needs your OK'}" + (ui.c("dim", f"  {detail}") if detail else ""))
        if len(items) > 30:
            ui.p(ui.c("dim", f"  … {len(items) - 30} more in the app"))
        ui.p(ui.c("dim", "  /needs approve N or /needs deny N answers one. The app shows the same list."))
    except Refused:
        ui.p(OLDER_APP.format(what="read Needs you", where="answer it")
             + " What this terminal asks about still waits here and in the app.")
    except Unreachable:
        ui.p(UNREACHABLE)
    except Said as e:
        ui.p(f"  {e}")


# --- the app's Jobs (/jobs also lists the jobs started here) ------------------------------------------------------------
def app_jobs(agent, ui) -> None:
    link = link_of(agent)
    if not link:
        return  # no app: the terminal's own jobs are the whole list
    try:
        board = call(link, "GET", "/api/jobs")
    except Refused:
        ui.p(ui.c("dim", OLDER_APP.format(what="read its Jobs", where="open Jobs")))
        return
    except (Unreachable, Said):
        ui.p(ui.c("dim", "  Can't reach the app for its Jobs right now."))
        return
    rows = [(j, "running") for j in board.get("running") or []] + [(j, "waiting for you") for j in board.get("you") or []]
    ui.p("  In the app")
    if not rows:
        ui.p(ui.c("dim", "    No jobs running in the app."))
    for j, state in rows[:20]:
        ui.p(f"    {j.get('title') or 'A job'}  " + (ui.c("accent", state) if state != "running" else ui.c("dim", state)))


# --- /team: coworkers, the same as the app's Coworkers page --------------------------------------------------------------
TEAM_USE = "  /team shows your coworkers  ·  /team set up LINE  ·  /team create LINE  ·  /team remove LINE"
JOB_STATE = {"on": "on", "waiting": "waiting for your OK", "off": "off"}


def team_command(agent, ui, rest: str = "") -> None:
    """Coworkers from the terminal: the lines of work, the team the app proposes for one, creating and removing it.
    The app does the work and records it like a click on its Coworkers page; creating or removing a team needs the
    terminal's own sign in (the app.json key only reads). Every job a team gets starts off and waits in Needs you."""
    parts = rest.strip().split()
    if [x.lower() for x in parts[:2]] == ["set", "up"]:
        verb, line = "set up", (parts[2].lower() if len(parts) > 2 else "")
    else:
        verb, line = (parts[0].lower() if parts else ""), (parts[1].lower() if len(parts) > 1 else "")
    link = link_of(agent)
    if not link:
        ui.p("  Coworkers live in the Rooks app. Open the app on this computer, then try /team again.")
        return
    try:
        if not verb:
            _team_overview(ui, link)
        elif verb == "set up" and line:
            _team_proposal(ui, link, line)
        elif verb == "create" and line:
            call(link, "POST", "/api/starters/apply", {"profession": line})
            ui.p(f"  Your team is ready. Each job waits for your OK before it runs: /needs shows them.")
        elif verb == "remove" and line:
            call(link, "DELETE", f"/api/starters/{urllib.parse.quote(line)}")
            ui.p("  Removed. Your mail, tasks, drafts and chats are kept.")
        else:
            ui.p(TEAM_USE)
    except Refused:
        ui.p(OLDER_APP.format(what="change your coworkers", where="open Coworkers"))
    except Unreachable:
        ui.p(UNREACHABLE)
    except Said as e:
        ui.p(f"  {e}")


def _team_overview(ui, link: dict) -> None:
    cat = call(link, "GET", "/api/starters")
    profs = cat.get("professions") or [] if isinstance(cat, dict) else []
    mine = [p for p in profs if p.get("set_up")]
    if not mine:
        ui.p("  No coworkers yet. Pick a line of work and Rooks proposes a small team for it.")
    for p in mine:
        st = call(link, "GET", f"/api/starters/{urllib.parse.quote(str(p['id']))}")
        ui.p("  " + ui.c("accent", st.get("label") or p.get("label") or p["id"]))
        for a in st.get("team") or []:
            paused = "" if a.get("status", "active") == "active" else "  " + ui.c("warn", "paused")
            ui.p(f"    {a.get('name')}  " + ui.c("dim", a.get("title") or "") + paused)
        for j in st.get("schedules") or []:
            state = JOB_STATE.get(j.get("state"), j.get("state") or "")
            missing = " ".join(j.get("missing") or [])
            ui.p(f"    {j.get('name')}  " + ui.c("dim", state + (f"  {missing}" if missing else "")))
    others = [p for p in profs if not p.get("set_up")]
    if others:
        ui.p("  Lines of work you can set up:")
        for p in others:
            ui.p(f"    {p['id']:<14}" + ui.c("dim", p.get("label") or ""))
        ui.p(ui.c("dim", "  /team set up NAME (the first word of a line) shows the team Rooks proposes. The app's Coworkers page shows the same."))


def _team_proposal(ui, link: dict, line: str) -> None:
    out = call(link, "POST", "/api/starters/proposal", {"professions": [line]})
    for p in out.get("professions") or []:
        ui.p("  " + ui.c("accent", p.get("label") or line))
        for m in p.get("team") or []:
            lead = "  leads the team" if m.get("role") == "coordinator" else ""
            ui.p(f"    {m.get('name')}  " + ui.c("dim", (m.get("title") or "") + lead))
        for s in p.get("schedules") or []:
            c = s.get("card") or {}
            ui.p(f"    {s.get('name')}  " + ui.c("dim", s.get("plain_time") or ""))
            if c.get("reads") or c.get("changes"):
                ui.p(ui.c("dim", f"      Reads: {c.get('reads', '')} Changes: {c.get('changes', '')}"))
            if s.get("missing"):
                ui.p(ui.c("warn", "      Needs first: " + " ".join(s["missing"])))
    for i in out.get("integrations") or []:
        ui.p(ui.c("dim", f"    Connects to {i.get('name')}: {i.get('state_label') or ''}"))
    if out.get("costs"):
        ui.p(ui.c("dim", "  " + out["costs"]))
    ui.p(f"  If that looks right: /team create {line}. Jobs start off and each waits for your OK in Needs you.")

