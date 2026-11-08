"""One approval, two places: the terminal prompt and the Rooks app's Approvals list.

When rooks is linked to an app conversation (provider workbench), every change it asks about is also posted to the app
(/v1/rooks/approvals) with its diff or command. The first answer wins: typed here, or clicked in the app (browser, app
window or phone). The other side is told, so the app's card closes or the terminal goes ahead. Each request has its
own id, so an earlier answer can never approve a later change.

Not linked, or the app unreachable: the plain local prompt, exactly as before.

Only the person's Terminal access token (`rooks login`) records an answer in the app. The open app's key (app.json) can
be read by any program on this computer, a command the agent ran included, so the app never takes an answer with it.
Without the token, an answer typed here still stands, and the terminal withdraws its request so the app's card closes.
"""

from __future__ import annotations

import json
import os
import select
import sys
import time
import urllib.error
import urllib.request

ANSWERS = {"y": "y", "yes": "y", "n": "n", "no": "n", "a": "a", "always": "a", "h": "h", "here": "h"}


def _answer(line: str, plan) -> str:
    """'y', 'n', 'a' or 'h' (only when the question offers it), or '' for anything else."""
    a = ANSWERS.get(line.strip().lower(), "")
    return "" if a == "h" and not getattr(plan, "here", False) else a


def _hint(plan) -> str:
    return "  Type y, n, a or h, then Enter." if getattr(plan, "here", False) else "  Type y, n or a, then Enter."
POLL_S = 1.0
REMOTE_WAIT_S = 900  # no keyboard (piped input ran out): wait this long for an answer from the app, then deny


class Link:
    def __init__(self, base_url: str, api_key: str, conversation_id: int, answer_key: str = ""):
        self.base = base_url.rstrip("/")  # ends in /v1
        self.hdr = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json", "X-Workbench": "1"}
        self.cid = conversation_id
        # the keys tried, in order, to record the person's answer: the Terminal access token first when rooks login kept one
        self.answer_keys = [k for k in dict.fromkeys([answer_key, api_key]) if k]
        self.withdrawn = False

    @classmethod
    def of(cls, ui) -> "Link | None":
        if os.environ.get("ROOKS_SHARED_APPROVALS", "1") == "0":
            return None
        if getattr(ui, "conversation_id", None) and getattr(ui, "base_url", None) and getattr(ui, "api_key", None):
            from .config import stored_keys

            return cls(ui.base_url, ui.api_key, ui.conversation_id, stored_keys().get("workbench", ""))
        return None

    def _call(self, method: str, path: str, body: dict | None = None, key: str = "") -> dict:
        hdr = {**self.hdr, "Authorization": f"Bearer {key}"} if key else self.hdr
        req = urllib.request.Request(f"{self.base}/rooks/approvals{path}", method=method, headers=hdr,
                                     data=json.dumps(body).encode() if body is not None else None)
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())

    def create(self, plan) -> int | None:
        try:
            return int(self._call("POST", "", {"conversation_id": self.cid, "tool": getattr(plan, "tool", "") or plan.effect, "effect": plan.effect,
                                                "summary": plan.summary, "preview": plan.preview or ""})["id"])
        except (OSError, ValueError, KeyError):
            return None

    def status(self, aid: int) -> str:
        try:
            return self._call("GET", f"/{aid}")["status"]
        except (OSError, ValueError, KeyError):
            return "pending"

    def answer(self, aid: int, approve: bool) -> str:
        """Record the local answer. Returns the status that stands (the app's, if it answered first). When the app
        refuses every key this terminal holds (no rooks login), the request is withdrawn so the app's card closes."""
        local = "approved" if approve else "denied"
        for key in self.answer_keys:
            try:
                return self._call("POST", f"/{aid}", {"approve": approve}, key=key)["status"]
            except urllib.error.HTTPError as e:
                if e.code == 409:
                    return self.status(aid)
                if e.code in (401, 403):
                    continue
                return local
            except (OSError, ValueError, KeyError):
                return local
        return self.withdraw(aid) or local

    def withdraw(self, aid: int) -> str:
        """Close the app's card without answering it. Returns the app's answer if it answered first, else ''."""
        try:
            st = self._call("POST", f"/{aid}/withdraw", {})["status"]
        except urllib.error.HTTPError as e:
            return self.status(aid) if e.code == 409 else ""
        except (OSError, ValueError, KeyError):
            return ""
        self.withdrawn = st == "withdrawn"
        return "" if self.withdrawn else st


def _ready(timeout: float) -> bool:
    """A line can be read from stdin without blocking (POSIX). Elsewhere: always try to read."""
    if os.name != "posix":
        return True
    try:
        return bool(select.select([sys.stdin], [], [], timeout)[0])
    except (ValueError, OSError):  # stdin closed or not selectable
        return True


def ask(ui, plan, show_prompt, read_line) -> str:
    """Return 'y', 'n', 'a' or 'h' (h only when plan.here). show_prompt() prints the question; read_line() reads one line ('' at end of input)."""
    link = Link.of(ui)
    aid = link.create(plan) if link else None
    if aid:
        ui.p(ui.c("dim", "  Also waiting in Needs you in the app. Answer here or there."))
    show_prompt()
    if not aid or link is None:
        return _local(ui, plan, show_prompt, read_line)
    keyboard = True
    deadline = None
    while True:
        if keyboard and _ready(POLL_S):
            line = read_line()
            if line == "":  # end of input: with the app linked, its answer still counts
                keyboard = False
                deadline = time.monotonic() + REMOTE_WAIT_S
                ui.p(ui.c("dim", "  No keyboard input: waiting for an answer in the app."))
                continue
            if line is None:
                continue
            a = _answer(line, plan)
            if not a:
                ui.p(ui.c("dim", _hint(plan)))
                show_prompt()
                continue
            stood = link.answer(aid, a in ("y", "a", "h"))
            if link.withdrawn:
                ui.p(ui.c("dim", "  Your answer here counts. The app closed its card; run rooks login so the app records "
                                 "answers typed here."))
                return a
            if stood == "denied" and a != "n":
                ui.p(ui.c("error", "  Already denied in the app."))
                return "n"
            if stood == "approved" and a == "n":
                ui.p(ui.c("ok", "  Already approved in the app."))
                return "y"
            return a
        if not keyboard:
            time.sleep(POLL_S)
            if deadline and time.monotonic() > deadline:
                link.answer(aid, False)
                ui.p(ui.c("error", "  No answer in time: denied."))
                return "n"
        st = link.status(aid)
        if st == "approved":
            ui.p(ui.c("ok", "  Approved in the app."))
            return "y"
        if st == "denied":
            ui.p(ui.c("error", "  Denied in the app."))
            return "n"
        if st == "withdrawn":  # nobody can answer it any more: a no
            ui.p(ui.c("error", "  The request was closed before anyone answered: denied."))
            return "n"


def _local(ui, plan, show_prompt, read_line) -> str:
    while True:
        line = read_line()
        if line == "":
            ui.p("n (no input: denied)")
            return "n"
        a = _answer(line, plan)
        if a:
            return a
        ui.p(ui.c("dim", _hint(plan)))
        show_prompt()
