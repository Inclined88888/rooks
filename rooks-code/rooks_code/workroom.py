"""/room, /needs and the app's half of /jobs: the Workroom from the terminal, through the Rooks app on this computer.

The terminal uses the key it already has: the app.json bridge key, or the Terminal access token from the app's
settings. The app lets either reach exactly these routes (room status, start, stop and run; Needs you; the Jobs board),
with the terminal's channel header. An older app refuses them, and the terminal says so in plain words instead of
pretending. Nothing here runs the Room or answers an approval itself: the app does, and records it like a click in
the app.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

from . import talk

RUN_WAIT_S = 330  # the Room's own limit on a command is 300 s


class Refused(Exception):
    """The app did not accept this terminal's key for that route (an app older than the terminal's Workroom access)."""


class Unreachable(Exception):
    pass


class Said(Exception):
    """The app answered with a reason (its reasons are plain words by design)."""


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
        raise Said(detail if isinstance(detail, str) and detail else "The app could not do that.") from None
    except (urllib.error.URLError, OSError, ValueError):
        raise Unreachable() from None


UNREACHABLE = "  Can't reach the Rooks app right now. Is it open on this computer?"
# A key the app refuses: an app older than this terminal, or a key from another app. Said plainly, never faked.
OLDER_APP = ("  The Rooks app did not let this terminal {what}. Starting the Room or answering Needs you from here needs the"
             " terminal's own sign in: in the app open Settings, Terminal access, then run rooks login. If the app is older"
             " than this terminal, update it. Or {where} in the app.")


# --- /room ------------------------------------------------------------------------------------------------------------
ISOLATION = {"none": "It runs as you; it is not locked off.", "namespace": "It runs in a space of its own on this computer.",
             "vm": "It is a separate computer."}
ROOM_USE = "  /room shows it  ·  /room start  ·  /room stop  ·  /room run COMMAND"


def _room_status(ui, st: dict) -> None:
    if not st.get("available", True):
        ui.p("  " + (st.get("label") or "The Room is not on this computer."))
        if st.get("note"):
            ui.p(ui.c("dim", "  " + st["note"]))
        return
    on = bool(st.get("running"))
    ui.p("  The Room  ·  " + (ui.c("accent", "on") if on else "off"))
    if st.get("label"):
        ui.p("  " + st["label"])
    note = st.get("note") or ISOLATION.get(st.get("isolation") or "", "")
    if note:
        ui.p(ui.c("dim", "  " + note))
    if not st.get("screen"):
        ui.p(ui.c("dim", "  No screen to watch here: what it does shows as text."))
    if st.get("last_checkpoint"):
        last = st["last_checkpoint"]
        ui.p(ui.c("dim", f"  Last saved point: {last.get('label') or last.get('name') if isinstance(last, dict) else last}"))
    ui.p(ui.c("dim", ROOM_USE))


def _show_run(ui, out: dict) -> None:
    text = ((out.get("stdout") or "") + (out.get("stderr") or "")).rstrip("\n")
    lines = text.splitlines()
    for line in lines[:60]:
        ui.p(ui.c("dim", "    ") + line)
    if len(lines) > 60:
        ui.p(ui.c("dim", f"    … {len(lines) - 60} more lines"))
    if out.get("error"):
        ui.p(ui.c("error", "  " + str(out["error"])))
    elif out.get("code") not in (0, None):
        ui.p(ui.c("error", f"  It ended with an error (code {out['code']})."))
    elif not lines:
        ui.p(ui.c("dim", "  Done, nothing printed."))


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
            ui.p("  The Room is off." if not out.get("running") else "  The Room is still on.")
        elif sub == "run":
            if not arg:
                ui.p("  Say what to run: /room run ls")
                return
            _show_run(ui, call(link, "POST", "/api/room/run", {"command": arg}, timeout=RUN_WAIT_S))
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
