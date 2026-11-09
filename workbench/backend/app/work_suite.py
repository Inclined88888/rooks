"""The work account (design 0012): one Microsoft 365 or Google Workspace account per person, its switches, and the gate
every work tool passes before it calls anything.

* The account is an ordinary linked account (connect.py) with work = 1, its company (`tenant`, Microsoft's `tid`) and
  who signed in (`subject`, Microsoft's `oid`), both read from the ID token the token endpoint returned.
* `features` holds which switches are on and which wait for the company's IT team. A switch's tools check it on every
  call (require), not only the permissions the token holds, so turning a switch off stops them at once.
* Every write to the outside service (upload, new version, share, cell edit, post, task change) is a tool with effect
  "external" and a confirm reason, so it always waits in Needs you and runs exactly the stored arguments on a yes
  (assistant.decide). A background job's key can never answer Needs you (security.require_user_or_terminal).
* Names of files, chats and sites seen in listings are kept in `work_refs`, so a card in Needs you says "Share
  Budget.csv with lee@contoso.com" without asking Microsoft again.

Microsoft's calls are in work_graph.py. Google Workspace has the same switches and tool names (work_scopes.py) and is
built next: until then its sign-in says so.
"""

from __future__ import annotations

import json
import time
from urllib.parse import quote, urlencode

from fastapi import HTTPException

from . import db, work_scopes

STATE_WORDS = {"on": "On", "off": "Off", "signin": "Sign in to allow this", "waiting": "Waiting for your IT team",
               "signing_in": "Finish signing in, in your browser"}
ASKS_FIRST = "Rooks always asks you first"
WAITING = ("Your company asks an IT admin to approve apps before they can read Teams or files. Rooks has prepared a request. "
           "Send it to your IT team; once they approve, turn this on again.")
WAITING_GOOGLE = "Your company's Google admin needs to allow Rooks. Rooks has prepared a request for your IT team."
NO_ACCOUNT = "Connect your work account first, in Work apps."
PERSONAL = ("That is a personal Microsoft account. Work apps need the account your company gave you. Personal accounts "
            "connect under Mail and calendar.")
GOOGLE_LATER = "Google Workspace comes next. For now, connect Gmail and Google Calendar under Mail and calendar."
CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad"  # Microsoft's tenant for personal accounts (outlook.com, hotmail)
OFF = {  # what a tool says when its switch is off
    "mail": "Mail is off. Turn it on in Work apps.", "calendar": "Calendar is off. Turn it on in Work apps.",
    "files_read": "Reading files is off. Turn it on in Work apps.",
    "files_change": "Changing files is off. Turn it on in Work apps.",
    "chats_read": "Reading chats is off. Turn it on in Work apps.", "chats_post": "Posting in chats is off. Turn it on in Work apps.",
    "transcripts": "Meeting transcripts are off. Turn them on in Work apps.", "tasks": "Tasks are off. Turn them on in Work apps.",
}
SIGN_IN_AGAIN = "Rooks needs your OK for this at Microsoft. Turn it on again in Work apps to sign in."

REFS_SQL = """CREATE TABLE IF NOT EXISTS work_refs (
  ref TEXT PRIMARY KEY,            -- drive/item, chat:<id>, channel:<team>/<channel>, site:<id>, drive:<id>
  name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',   -- file | folder | chat | channel | site | drive
  web_url TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
)"""
_refs_ready: set[str] = set()


# --- the account ---------------------------------------------------------------------------------------------------
def account() -> dict | None:
    return db.one("SELECT * FROM linked_accounts WHERE work = 1 ORDER BY id LIMIT 1")


def features_of(row: dict | None) -> dict:
    try:
        f = json.loads((row or {}).get("features") or "{}")
    except ValueError:
        f = {}
    return {"on": list(f.get("on") or []), "waiting": list(f.get("waiting") or [])}


def _save_features(aid: int, f: dict) -> None:
    db.run("UPDATE linked_accounts SET features = ? WHERE id = ?",
           json.dumps({"on": sorted(set(f["on"])), "waiting": sorted(set(f["waiting"]))}), aid)


def granted(row: dict) -> set[str]:
    """What the provider granted, as kept beside the account (no keychain read: `when` asks this every turn)."""
    return {work_scopes.short(s) for s in (row.get("scopes") or "").split()}


def state(row: dict | None, fid: str, have: set[str] | None = None) -> str:
    if not row:
        return "off"
    f = features_of(row)
    if fid in f["waiting"]:
        return "waiting"
    if fid not in f["on"]:
        return "off"
    return "on" if work_scopes.has(row["provider"], fid, have if have is not None else granted(row)) else "signin"


def on(fid: str) -> bool:
    """For the assistant's `when`: whether the tools of a switch are offered this turn (no network)."""
    try:
        return state(account(), fid) == "on"
    except Exception:  # noqa: BLE001 - a broken record offers nothing rather than failing the turn
        return False


def require(fid: str) -> dict:
    """The work account, when this switch is on and its permissions are granted; else the plain reason (409)."""
    row = account()
    if not row:
        raise HTTPException(409, NO_ACCOUNT)
    st = state(row, fid)
    if st == "on":
        return row
    if st == "signin":
        raise HTTPException(409, SIGN_IN_AGAIN)
    raise HTTPException(409, OFF[fid])


def set_feature(fid: str, turn_on: bool) -> dict:
    """Turn a switch off at once, or on: at once when the permissions are already granted, else a sign-in that asks
    only for this switch's permissions (the caller opens its address)."""
    if fid not in work_scopes.BY_ID:
        raise HTTPException(404, "There is no such switch.")
    row = account()
    if not row:
        raise HTTPException(409, NO_ACCOUNT)
    f = features_of(row)
    if not turn_on:
        f["on"] = [x for x in f["on"] if x != fid]
        f["waiting"] = [x for x in f["waiting"] if x != fid]
        _save_features(row["id"], f)
        _mail_calendar_rows(row, fid, False)
        return {"id": fid, "state": "off", "state_words": STATE_WORDS["off"]}
    if work_scopes.has(row["provider"], fid, granted(row)):
        f["on"] = [*f["on"], fid]
        f["waiting"] = [x for x in f["waiting"] if x != fid]
        _save_features(row["id"], f)
        _mail_calendar_rows(row, fid, True)
        return {"id": fid, "state": "on", "state_words": STATE_WORDS["on"]}
    return {"id": fid, "state": "signing_in", "state_words": STATE_WORDS["signing_in"], "sign_in": True}


def _mail_calendar_rows(row: dict, fid: str, turn_on: bool) -> None:
    """Mail and Calendar of the work account are its ordinary mailbox and calendar: there when on, gone when off."""
    from . import connect

    if fid == "mail":
        if turn_on:
            connect.save_mailbox(row["id"], row["provider"], row["email"], row["name"])
        else:
            db.run("DELETE FROM mail_accounts WHERE linked_account_id = ?", row["id"])
    elif fid == "calendar":
        if turn_on:
            connect.save_calendar(row["id"], row["provider"], row["email"])
        else:
            db.run("DELETE FROM calendars WHERE linked_account_id = ?", row["id"])


def sign_in_scopes(provider: str, fid: str = "") -> list[str]:
    """What a work sign-in asks for: who you are, plus one switch's permissions when turning that switch on."""
    out = list(work_scopes.IDENTITY[provider])
    if fid:
        out += [s for s in work_scopes.scopes(provider, fid) if s not in out]
    return out


def finish_sign_in(provider: str, me: dict, claims: dict, record: dict, feature: str) -> int:
    """After a work sign-in: one work account (the same person as before when turning a switch on), its switch on."""
    from . import connect

    if provider == "microsoft" and claims.get("tid") == CONSUMER_TENANT:
        raise HTTPException(400, PERSONAL)
    row = account()
    subject = str(claims.get("oid") or claims.get("sub") or "")
    if feature and row and row["subject"] and subject and row["subject"] != subject:
        raise HTTPException(400, f"You signed in as {me['email']}, but the work account here is {row['email']}. "
                                 "Sign in with that account, or disconnect it first.")
    record = {**record, "work": True}
    aid = connect.save_account(provider, me["email"], me.get("name", ""), record, False, False)
    db.run("UPDATE linked_accounts SET work = 0 WHERE id != ? AND work = 1", aid)
    db.run("UPDATE linked_accounts SET work = 1, tenant = ?, subject = ? WHERE id = ?",
           str(claims.get("tid") or claims.get("hd") or ""), subject, aid)
    fresh = db.one("SELECT * FROM linked_accounts WHERE id = ?", aid)
    f = features_of(fresh) if fresh["features"] else {"on": [], "waiting": []}
    if feature:
        f["on"] = [*f["on"], feature]
        f["waiting"] = [x for x in f["waiting"] if x != feature]
    _save_features(aid, f)
    fresh = db.one("SELECT * FROM linked_accounts WHERE id = ?", aid)
    for fid in ("mail", "calendar"):
        if state(fresh, fid) == "on":
            _mail_calendar_rows(fresh, fid, True)
    return aid


def mark_waiting(feature: str) -> None:
    row = account()
    if row and feature:
        f = features_of(row)
        f["waiting"] = [*f["waiting"], feature]
        f["on"] = [x for x in f["on"] if x != feature]
        _save_features(row["id"], f)


# --- the note for the IT team ------------------------------------------------------------------------------------------
def admin_consent_url(fid: str = "") -> str:
    from . import connect

    row = account()
    cfg = connect.client_config("microsoft")
    tenant = (row or {}).get("tenant") or cfg["tenant"] or "organizations"
    base = connect._url("MICROSOFT_LOGIN_BASE", "https://login.microsoftonline.com")
    feats = [fid] if fid else [f["id"] for f in work_scopes.FEATURES]
    scope = " ".join(f"https://graph.microsoft.com/{s}" for f in feats for s in work_scopes.scopes("microsoft", f))
    return f"{base}/{tenant}/v2.0/adminconsent?" + urlencode({"client_id": cfg["client_id"], "scope": scope,
                                                                "redirect_uri": "http://localhost"})


def it_note(fid: str) -> str:
    if fid not in work_scopes.BY_ID:
        raise HTTPException(404, "There is no such switch.")
    row = account()
    provider = (row or {}).get("provider") or "microsoft"
    feat = work_scopes.BY_ID[fid]
    if provider == "google":
        from . import connect

        return ("Hello IT team,\n\nI use Rooks, a personal assistant that runs on my own computer. To let it "
                f"{feat['says']['google'][len('Rooks can '):].rstrip('.')}, our Google Workspace needs to allow the app with this "
                f"client ID: {connect.client_config('google')['client_id']}\nIt asks for:\n"
                + "\n".join(f"- {s}" for s in feat["google"]) + "\n\nEverything runs on my own computer; nothing is kept on a "
                "Rooks server. Thank you.")
    lines = [f"- {s}: {work_scopes.WHY.get(s, 'needed for this feature')}" + (" (needs an administrator)" if s in work_scopes.ADMIN["microsoft"] else "")
             for s in feat["microsoft"]]
    who = f" for {row['email']}" if row else ""
    return ("Hello IT team,\n\nI use Rooks, a personal assistant that runs on my own computer. To let it "
            f"{feat['says']['microsoft'][len('Rooks can '):].rstrip('.')}, it needs these Microsoft 365 permissions{who}, "
            "for my account only (delegated, never the whole company's data):\n" + "\n".join(lines) +
            "\n\nEverything runs on my own computer; nothing is kept on a Rooks server. Anything that sends, posts, shares "
            "or changes something waits for my yes first.\n\nAn administrator can approve it for our company here:\n"
            f"{admin_consent_url(fid)}\n\nThank you.")


# --- what the Work apps page and /work show ----------------------------------------------------------------------------
def status() -> dict:
    from . import connect

    row = account()
    have = granted(row) if row else set()
    provider = (row or {}).get("provider") or "microsoft"
    feats = []
    for f in work_scopes.FEATURES:
        st = state(row, f["id"], have)
        item = {"id": f["id"], "label": f["label"], "says": f["says"][provider], "asks_first": f["asks_first"],
                "state": st, "state_words": STATE_WORDS[st]}
        if st == "waiting":
            item["waiting_words"] = WAITING_GOOGLE if provider == "google" else WAITING
        feats.append(item)
    ms = connect.providers_info()["microsoft"]
    out = {"account": ({"provider": row["provider"], "email": row["email"], "name": row["name"],
                        "status": row["status"], "needs_sign_in": row["status"] == "reauth"} if row else None),
           "suites": {"microsoft": {"ready": ms["configured"], "words": "" if ms["configured"] else
                                    "Sign-in with Microsoft is not set up on this computer yet. Your IT team or the person "
                                    "who installed Rooks can add it under Advanced."},
                      "google": {"ready": False, "words": GOOGLE_LATER}},
           "features": feats, "words": {"asks_first": ASKS_FIRST, "waiting": WAITING, "states": STATE_WORDS},
           "advanced": {"tenant": (row or {}).get("tenant", ""), "client_id_hint": ms["client_id_hint"],
                        "granted": sorted(have), "permissions": {f["id"]: f[provider] for f in work_scopes.FEATURES},
                        "admin_consent": admin_consent_url() if provider == "microsoft" and ms["configured"] else ""}}
    return out


# --- names seen in listings, for the cards in Needs you ----------------------------------------------------------------
def _refs() -> None:
    from . import config

    key = str(config.DB_PATH)
    if key not in _refs_ready:
        db.conn().execute(REFS_SQL)
        _refs_ready.add(key)


def forget() -> None:
    """After the work account is disconnected: its tasks and the names it saw leave Rooks' lists (Microsoft keeps them)."""
    _refs()
    db.run("DELETE FROM tasks WHERE origin IN ('planner', 'todo')")
    db.run("DELETE FROM work_refs")


def remember(ref: str, name: str, kind: str, web_url: str = "") -> None:
    if not ref:
        return
    _refs()
    db.run("INSERT INTO work_refs(ref, name, kind, web_url, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(ref) DO UPDATE SET "
           "name = excluded.name, kind = excluded.kind, web_url = CASE WHEN excluded.web_url != '' THEN excluded.web_url ELSE "
           "work_refs.web_url END, updated_at = excluded.updated_at", ref, (name or "")[:300], kind, web_url[:2000], db.now())


def name_of(ref: str, fallback: str = "") -> str:
    _refs()
    r = db.one("SELECT name FROM work_refs WHERE ref = ?", str(ref or ""))
    return (r or {}).get("name") or fallback


def title(tool: str, args: dict) -> str:
    """What a held work call asks for, in Needs you's words: the file, the people, the chat, the task."""
    from .presence import clip

    a = args if isinstance(args, dict) else {}
    if tool == "work_file_upload":
        from . import analysis

        try:
            name = analysis.get(int(str(a.get("file_id", "")).lstrip("#")))["name"]
        except (HTTPException, ValueError):
            name = "a file"
        return f"Upload to OneDrive: {clip(name)}"
    if tool == "work_file_share":
        name = name_of(a.get("file", ""), "a file")
        people = ", ".join(p.strip() for p in str(a.get("people") or "").split(",") if p.strip())
        if people:
            return f"Share {clip(name)} with {clip(people)} ({'can edit' if a.get('access') == 'edit' else 'can view'})"
        return f"Share {clip(name)}: a link people in your company can {'edit' if a.get('access') == 'edit' else 'view'}"
    if tool == "work_file_edit":
        return f"Change {clip(name_of(a.get('file', ''), 'a file'))}"
    if tool == "work_chat_post":
        return f"Post in Teams: {clip(name_of(a.get('chat', ''), 'a chat'))}"
    if tool == "work_task_update":
        t = None
        if str(a.get("task") or "").strip().lstrip("#").isdigit():
            t = db.one("SELECT title, origin FROM tasks WHERE id = ?", int(str(a["task"]).lstrip("#")))
        if t:
            where = {"planner": "Planner", "todo": "To Do"}.get(t["origin"], "your task list")
            return f"Change a task in {where}: {clip(t['title'])}"
        return f"Add a task to To Do: {clip(str(a.get('title') or 'a task'))}"
    if tool == "work_file_save":
        return f"Save to Files: {clip(name_of(a.get('file', ''), 'a work file'))}"
    if tool == "work_file_open":
        return f"Open in the Room's browser: {clip(name_of(a.get('file', ''), 'a work file'))}"
    return ""


# --- a held write from the terminal (/work post) -----------------------------------------------------------------------
WRITES = ("work_file_upload", "work_file_share", "work_file_edit", "work_chat_post", "work_task_update")
TAINT_HOLDS = (*WRITES, "work_file_save")  # these wait for a yes once a conversation read third party content
FEATURE_OF = {"work_file_upload": "files_change", "work_file_share": "files_change", "work_file_edit": "files_change",
              "work_chat_post": "chats_post", "work_task_update": "tasks"}


def hold(tool: str, args: dict, channel: str = "cli") -> dict:
    """Put one write in Needs you without running it (the terminal's /work post). The same request already waiting is
    not asked again. It runs only on the person's yes, through assistant.decide, like any held call."""
    from . import actions, assistant, push

    if tool not in WRITES:
        raise HTTPException(400, "Only sending, sharing and changing things waits in Needs you this way.")
    require(FEATURE_OF[tool])
    conv = db.one("SELECT id FROM conversations WHERE channel = ? AND external_id = 'work' ORDER BY id DESC LIMIT 1", channel)
    cid = conv["id"] if conv else assistant.new_conversation(channel, "Work apps", external_id="work")
    raw = json.dumps(args, sort_keys=True)
    for a in actions.pending(cid):
        if a["tool"] == tool and json.dumps(json.loads(a["args"] or "{}"), sort_keys=True) == raw:
            return {"held": True, "already_asked": True, "id": f"a:{a['id']}", "title": title(tool, args)}
    t = assistant.TOOL_MAP[tool]
    reason = t.confirm(args) if t.confirm else "This needs your OK."
    aid = actions.add("tool_call", "held", trace={"channel": channel, "conversation_id": cid}, tool=tool, effect=t.effect,
                      args=raw, payload=raw, detail=reason)
    push.approval_needed(aid, tool)
    return {"held": True, "already_asked": False, "id": f"a:{aid}", "title": title(tool, args)}


def wait_s(retry_after: str | None, cap: float = 30.0) -> float:
    try:
        return max(0.0, min(cap, float(retry_after or 2)))
    except ValueError:
        return 2.0


def sleep(seconds: float) -> None:  # one place, so tests could shorten it
    time.sleep(seconds)


def quote_path(s: str) -> str:
    return quote(s, safe="")
