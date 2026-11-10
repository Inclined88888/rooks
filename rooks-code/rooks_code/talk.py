"""`rooks talk`: the same assistant as the app, in the terminal.

One-off:  rooks talk "what's on today"
Stay:     rooks talk
It talks to the Rooks running on this computer. WORKBENCH_URL may be a private tunnel
back to that same computer. There is no hosted multi-user service.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

from . import config, words
from .agent import RESUMED, SUMMARISED

MOODS = {
    "writing": "(thinking)",
    "tool_call": "(working)",
    "watch": "(working)",
    "approval_required": "(needs you)",
    "message": "(done)",
    "card": "(done)",
    "error": "(needs you)",
}


def mood_line(event_type: str) -> str:
    return MOODS.get(event_type, "")


def link_from(url: str | None, key: str | None) -> dict | None:
    if url and key:
        return {"url": url.rstrip("/"), "key": key}
    env_url = os.environ.get("WORKBENCH_URL", "").rstrip("/")
    env_key = os.environ.get("WORKBENCH_API_KEY", "")
    if env_url and env_key:
        return {"url": env_url, "key": env_key}
    found = config.app_link()
    if found.get("url") and found.get("key"):
        return found
    return None


def _request(link: dict, method: str, path: str, body: dict | None = None, timeout: int = 30):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        f"{link['url'].rstrip('/')}{path}",
        data=data,
        headers={"Authorization": f"Bearer {link['key']}", "Content-Type": "application/json", "X-Workbench": "1"},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    return json.loads(raw) if raw else {}


def _print_mood(kind: str, shown: set[str]) -> None:
    line = mood_line(kind)
    if line and line not in shown:
        print(line, flush=True)
        shown.add(line)


def _approve(link: dict, event: dict, tty: bool) -> None:
    step = words.plain_step(str(event.get("tool") or ""), event.get("args") or {})
    reason = event.get("reason") or ""
    print(f"Needs your OK: {step}. {reason}".rstrip(), flush=True)
    if not tty:
        print("It waits in Needs you in the app: Approve or Deny it there. Nothing was sent.", flush=True)
        return
    try:
        answer = input("[y] Approve  [n] Deny: ").strip().lower()
    except EOFError:
        answer = ""
    allow = answer in ("y", "yes")
    try:
        _request(link, "POST", f"/api/approvals/{event.get('id')}", {"approve": allow})
    except (OSError, ValueError) as exc:
        print("Could not send that answer. It still waits in Needs you in the app.", flush=True)


def turn(link: dict, message: str, conversation_id: int | None, tty: bool) -> int:
    """Stream one assistant turn. Returns 0, or 2 when it needs a person and nobody is here."""
    body = json.dumps({"message": message, "conversation_id": conversation_id, "channel": "cli"}).encode()
    req = urllib.request.Request(
        f"{link['url'].rstrip('/')}/api/assistant/chat",
        data=body,
        headers={"Authorization": f"Bearer {link['key']}", "Content-Type": "application/json", "X-Workbench": "1"},
        method="POST",
    )
    shown: set[str] = set()
    needs = False
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                try:
                    event = json.loads(line[5:])
                except json.JSONDecodeError:
                    continue
                kind = str(event.get("type") or "")
                if kind == "writing":
                    _print_mood("writing", shown)
                elif kind in ("tool_call", "watch"):
                    _print_mood(kind, shown)
                    if kind == "tool_call":
                        print(f"  {words.plain_step(str(event.get('name') or ''), event.get('args') or {})}", flush=True)
                elif kind == "resumed":  # the app restarted during this chat's last turn
                    print(RESUMED, flush=True)
                elif kind == "compacted":
                    print(SUMMARISED, flush=True)
                elif kind == "approval_required":
                    _print_mood(kind, shown)
                    needs = True
                    _approve(link, event, tty)
                elif kind == "card" and event.get("kind") == "routine":
                    _print_mood("card", shown)
                    print(event.get("sentence") or "Saved.", flush=True)
                elif kind == "message":
                    _print_mood("message", shown)
                    text = str(event.get("content") or "").strip()
                    if text:
                        print(text, flush=True)
                elif kind == "error":
                    _print_mood("error", shown)
                    print(str(event.get("error") or "Something went wrong."), flush=True)
                    return 1
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        try:
            said = json.loads(detail).get("detail")
        except (ValueError, AttributeError):
            said = None
        print("The app did not accept this terminal's key." if exc.code in (401, 403)
              else (said if isinstance(said, str) and said else "The app could not answer that."), flush=True)
        return 1
    except (OSError, ValueError) as exc:
        print("Can't reach the Rooks app on this computer. Is it open?", flush=True)
        return 1
    return 2 if needs and not tty else 0


def _routines(link: dict) -> int:
    try:
        rows = _request(link, "GET", "/api/assistant/routines").get("routines") or []
    except (OSError, ValueError, urllib.error.HTTPError) as exc:
        print(f"Can't list routines: {exc}", flush=True)
        return 1
    if not rows:
        print("No routines yet. Say “every weekday morning, summarise my inbox”.", flush=True)
        return 0
    for row in rows:
        state = "on" if row.get("enabled") else "paused"
        print(f"{row.get('kind')} {row.get('id')}  {state}  {row.get('sentence')}", flush=True)
    return 0


def _pause(link: dict, words: list[str]) -> int:
    if len(words) < 2:
        print("Use /pause schedule 3  or  /pause automation 2", flush=True)
        return 1
    kind, rid = words[0], words[1]
    try:
        row = _request(link, "POST", "/api/assistant/routines/pause", {"kind": kind, "id": int(rid), "enabled": False})
    except (OSError, ValueError, urllib.error.HTTPError) as exc:
        print(f"Couldn't pause that: {exc}", flush=True)
        return 1
    print("Paused." if not row.get("enabled", True) else "Still on.", flush=True)
    return 0


def main_conversation(link: dict) -> int | None:
    try:
        return int(_request(link, "GET", "/api/assistant/main")["id"])
    except (OSError, ValueError, KeyError, TypeError, urllib.error.HTTPError):
        return None


def repl(link: dict) -> int:
    cid = main_conversation(link)
    print("Rooks  ·  terminal", flush=True)
    print("Same chat as the app. No desktop window needed.", flush=True)
    print("/routines   /pause schedule 3   /quit", flush=True)
    print(flush=True)
    while True:
        try:
            line = input("you> ").strip()
        except EOFError:
            print(flush=True)
            return 0
        if not line:
            continue
        if line in ("/quit", "/exit"):
            return 0
        if line == "/routines":
            _routines(link)
            continue
        if line.startswith("/pause"):
            _pause(link, line.split()[1:])
            continue
        code = turn(link, line, cid, sys.stdin.isatty())
        if code == 1:
            return code


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    url = key = None
    prompt: list[str] = []
    i = 0
    while i < len(argv):
        if argv[i] == "--url" and i + 1 < len(argv):
            url = argv[i + 1]
            i += 2
            continue
        if argv[i] == "--key" and i + 1 < len(argv):
            key = argv[i + 1]
            i += 2
            continue
        prompt.append(argv[i])
        i += 1
    found = link_from(url, key)
    if not found:
        print("Open Rooks on this computer. WORKBENCH_URL is only for a private tunnel back to that same computer.", flush=True)
        return 2
    if prompt:
        cid = main_conversation(found)
        return turn(found, " ".join(prompt), cid, sys.stdin.isatty())
    return repl(found)
