"""Microsoft 365 through Microsoft Graph for the work account (design 0012, section 2.2): OneDrive and SharePoint,
Teams, meeting transcripts, Planner and To Do. Every call is the person's own (delegated) access.

* `call` refreshes the access token when needed and retries once after a 401 (as cloud_mail does), waits out a 429 or
  503 with Retry-After (up to 30 s, twice), and turns Graph's errors into plain words. httpx is wrapped by egress.py,
  so every request is a row in the outbound record; tokens travel only in the Authorization header, never in a URL.
* A file's content and a large upload go to the short-lived address Graph hands out, without the Graph token.
* Reads never wait for a yes. Every write here (upload, new version, share, cell edit, post, task change) is reached
  only through a tool that always waits in Needs you (work_suite.WRITES), with the stored arguments, on a yes.

Refs: a file is "<drive id>/<item id>", a chat "chat:<id>", a channel "channel:<team id>/<channel id>".
API base: GRAPH_API_BASE (tests point it at tests/fake_graph.py).
"""

from __future__ import annotations

import json
import re
import shutil
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from html import unescape
from pathlib import Path
from urllib.parse import quote

import httpx
from fastapi import HTTPException

from . import cloud_mail, connect, db, work_suite

MAX_READ = 100 * 1024 * 1024        # a file read or saved from work: 100 MB at most
SMALL_UPLOAD = 4 * 1024 * 1024      # Graph's simple upload limit; larger files go through an upload session
CHUNK = 10 * 320 * 1024             # upload session chunks must be multiples of 320 KiB
MAX_PAGES = 20


def graph() -> str:
    return cloud_mail.graph()


def _explain(r: httpx.Response) -> str:
    try:
        err = (r.json() or {}).get("error") or {}
        code = err.get("code", "") if isinstance(err, dict) else ""
    except ValueError:
        code = ""
    if r.status_code == 403:
        return ("Microsoft said your account does not allow that. Your company may need to approve it, or you may not "
                "have access to that item.")
    if r.status_code == 404:
        return "Microsoft could not find that. It may have been moved or deleted, or you may not have access."
    if r.status_code == 409:
        return "Microsoft said that conflicts with something already there (a file with the same name, or a newer change)."
    if r.status_code == 412:
        return "Someone changed it in the meantime. Look at it again, then try once more."
    if r.status_code == 429:
        return "Microsoft is busy with too many requests right now. Try again in a minute."
    if r.status_code == 423:
        return "That file is locked: someone has it open or it is checked out."
    return f"Microsoft could not do that right now ({code or r.status_code})."


def call(acct: dict, method: str, path: str, *, ok: tuple[int, ...] = (), **kw) -> httpx.Response:
    """One Graph request as the work account. `path` is a Graph path or a full nextLink."""
    url = path if path.startswith("http") else graph() + path
    headers = kw.pop("headers", {}) or {}
    refreshed, throttled, r = False, 0, None
    while True:
        token = connect.access_token(acct["id"], force=refreshed)
        try:
            r = httpx.request(method, url, headers={"Authorization": f"Bearer {token}", **headers}, timeout=60,
                              follow_redirects=False, **kw)
        except httpx.HTTPError as e:
            raise HTTPException(502, "Couldn't reach Microsoft. Check your connection and try again.") from e
        if r.status_code == 401 and not refreshed:
            refreshed = True
            continue
        if r.status_code in (429, 503) and throttled < 2:
            throttled += 1
            work_suite.sleep(work_suite.wait_s(r.headers.get("retry-after")))
            continue
        break
    if r.status_code == 401:
        connect.mark_reauth(acct["id"], "Microsoft rejected the access token")
        raise HTTPException(401, f"{acct['email']} needs to sign in again, in Work apps.")
    if r.status_code >= 400 and r.status_code not in ok:
        raise HTTPException(403 if r.status_code == 403 else (404 if r.status_code == 404 else 502), _explain(r))
    return r


def pages(acct: dict, path: str, params: dict | None = None, limit: int = 200) -> list[dict]:
    out, url = [], path
    for _ in range(MAX_PAGES):
        j = call(acct, "GET", url, params=params).json()
        out += j.get("value") or []
        nxt = j.get("@odata.nextLink")
        if not nxt or len(out) >= limit:
            break
        url, params = nxt, None
    return out[:limit]


def _split(ref: str) -> tuple[str, str]:
    ref = str(ref or "").strip()
    if "/" not in ref or ref.startswith(("chat:", "channel:")):
        raise HTTPException(400, "That is not a work file. Use the file's reference from work_files or work_search.")
    d, i = ref.split("/", 1)
    if not d or not i or "/" in i:
        raise HTTPException(400, "That is not a work file. Use the file's reference from work_files or work_search.")
    return d, i


def _item_path(ref: str) -> str:
    d, i = _split(ref)
    return f"/drives/{quote(d, safe='!')}/items/{quote(i, safe='!')}"


def _where(drive: str) -> str:
    return work_suite.name_of(f"drive:{drive}", "OneDrive or SharePoint")


def _item(it: dict, where: str = "") -> dict:
    remote = it.get("remoteItem") or {}
    src = remote if remote.get("id") else it
    drive = (src.get("parentReference") or {}).get("driveId", "")
    ref = f"{drive}/{src['id']}" if drive else ""
    is_folder = bool(src.get("folder") or it.get("folder"))
    out = {"file": ref, "name": it.get("name") or src.get("name", ""), "folder": is_folder, "size": src.get("size") or it.get("size"),
           "modified": src.get("lastModifiedDateTime") or it.get("lastModifiedDateTime"),
           "where": where or _where(drive), "web_url": it.get("webUrl") or src.get("webUrl", "")}
    work_suite.remember(ref, out["name"], "folder" if is_folder else "file", out["web_url"])
    return out


# --- OneDrive and SharePoint: read -------------------------------------------------------------------------------------
def search(acct: dict, query: str, kind: str = "files", limit: int = 20) -> dict:
    query = (query or "").strip()
    if not query:
        raise HTTPException(400, "Say what to look for.")
    limit = max(1, min(int(limit or 20), 100))
    if kind == "chats":
        entity = ["chatMessage"]
    else:
        entity = ["driveItem"]
    hits, start = [], 0
    for _ in range(10):
        body = {"requests": [{"entityTypes": entity, "query": {"queryString": query}, "from": start, "size": min(25, limit)}]}
        j = call(acct, "POST", "/search/query", json=body).json()
        cont = ((j.get("value") or [{}])[0].get("hitsContainers") or [{}])[0]
        page = cont.get("hits") or []
        hits += page
        start += len(page)
        if not cont.get("moreResultsAvailable") or not page or len(hits) >= limit:
            break
    if kind == "chats":
        out = []
        for h in hits[:limit]:
            res = h.get("resource") or {}
            out.append({"chat": f"chat:{res.get('chatId')}" if res.get("chatId") else "", "from": ((res.get("from") or {}).get("user") or {}).get("displayName", ""),
                        "text": _plain((res.get("body") or {}).get("content") or h.get("summary") or "")[:500]})
        return {"messages": out}
    return {"items": [{**_item(h.get("resource") or {}), "match": _plain(h.get("summary") or "")[:200]} for h in hits[:limit]]}


def sites(acct: dict) -> list[dict]:
    out = []
    for s in pages(acct, "/me/followedSites", limit=100):
        name = s.get("displayName") or s.get("name") or "SharePoint site"
        work_suite.remember(f"site:{s['id']}", name, "site", s.get("webUrl", ""))
        out.append({"id": s["id"], "name": name})
    return out


def listing(acct: dict, folder: str = "", site: str = "", shared: bool = False, limit: int = 100) -> dict:
    limit = max(1, min(int(limit or 100), 500))
    if shared:
        return {"items": [_item(x, "Shared with you") for x in pages(acct, "/me/drive/sharedWithMe", limit=limit)]}
    if site:
        drives = pages(acct, f"/sites/{quote(site, safe=',')}/drives", limit=20)
        lib = next((d for d in drives if d.get("driveType") == "documentLibrary"), drives[0] if drives else None)
        if not lib:
            return {"items": []}
        where = work_suite.name_of(f"site:{site}", "SharePoint")
        work_suite.remember(f"drive:{lib['id']}", where, "drive")
        rows = pages(acct, f"/drives/{quote(lib['id'], safe='!')}/root/children", limit=limit)
        return {"items": [_item(x, where) for x in rows]}
    if folder:
        rows = pages(acct, _item_path(folder) + "/children", limit=limit)
        return {"items": [_item(x) for x in rows]}
    rows = pages(acct, "/me/drive/root/children", limit=limit)
    for x in rows[:1]:
        drive = (x.get("parentReference") or {}).get("driveId")
        if drive:
            work_suite.remember(f"drive:{drive}", "OneDrive", "drive")
    return {"items": [_item(x, "OneDrive") for x in rows]}


def meta(acct: dict, ref: str) -> dict:
    it = call(acct, "GET", _item_path(ref)).json()
    _item(it)
    return it


def download(acct: dict, ref: str) -> tuple[dict, bytes]:
    it = meta(acct, ref)
    if it.get("folder"):
        raise HTTPException(400, "That is a folder. List what is in it with work_files.")
    if (it.get("size") or 0) > MAX_READ:
        raise HTTPException(413, "That file is larger than 100 MB, too large to read here. Open it instead.")
    r = call(acct, "GET", _item_path(ref) + "/content", ok=(302,))
    if r.status_code == 302:  # a pre-signed address: the Graph token is never sent there
        try:
            r = httpx.get(str(r.url.join(r.headers["location"])), timeout=120, follow_redirects=True)
        except (httpx.HTTPError, KeyError) as e:
            raise HTTPException(502, "Couldn't download that file from Microsoft. Try again.") from e
        if r.status_code >= 400:
            raise HTTPException(502, "Couldn't download that file from Microsoft. Try again.")
    data = r.content
    if len(data) > MAX_READ:
        raise HTTPException(413, "That file is larger than 100 MB, too large to read here. Open it instead.")
    return it, data


def read(acct: dict, ref: str, part: int = 1, query: str = "") -> dict:
    from . import analysis, config, files

    it, data = download(acct, ref)
    tmp = Path(tempfile.mkdtemp(prefix="work-", dir=str(config.DATA_DIR)))
    try:
        p = tmp / analysis._safe_name(it.get("name") or "file")
        p.write_bytes(data)
        d = files.extract(p, it.get("name") or p.name)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    drive = (it.get("parentReference") or {}).get("driveId", "")
    return {**analysis.read_extract(d, int(part or 1), query or ""), "file": ref, "from": _where(drive)}


def save(acct: dict, ref: str) -> dict:
    from . import analysis

    it, data = download(acct, ref)
    where = _where((it.get("parentReference") or {}).get("driveId", ""))
    f = analysis.add(it.get("name") or "file", data=data, source="onedrive" if where == "OneDrive" else "sharepoint", remote=ref)
    return {**{k: f[k] for k in ("id", "name", "kind", "summary", "source")}, "remote": ref, "from": where}


def open_address(acct: dict, ref: str) -> dict:
    it = meta(acct, ref)
    return {"address": it.get("webUrl", ""), "name": it.get("name", "")}


# --- OneDrive and SharePoint: change (always after a yes) --------------------------------------------------------------
def _parent(folder: str) -> str:
    return _item_path(folder) if folder else "/me/drive/root"


def upload(acct: dict, file_id, folder: str = "", replace: bool = False) -> dict:
    from . import analysis

    f = analysis.get(int(str(file_id).lstrip("#")))
    path = Path(f["path"])
    if not path.is_file():
        raise HTTPException(400, "Only a single file can be uploaded, not a folder.")
    data = path.read_bytes()
    name = f["name"]
    conflict = "replace" if replace else "rename"
    target = f"{_parent(folder)}:/{quote(name, safe='')}:"
    if len(data) <= SMALL_UPLOAD:
        r = call(acct, "PUT", f"{target}/content", params={"@microsoft.graph.conflictBehavior": conflict}, content=data,
                 headers={"Content-Type": "application/octet-stream"})
        it = r.json()
    else:
        s = call(acct, "POST", f"{target}/createUploadSession",
                 json={"item": {"@microsoft.graph.conflictBehavior": conflict}}).json()
        url, it = s["uploadUrl"], {}
        for start in range(0, len(data), CHUNK):
            chunk = data[start:start + CHUNK]
            try:  # the upload address carries its own authorisation: the Graph token is never sent there
                r = httpx.put(url, content=chunk, timeout=120, headers={
                    "Content-Length": str(len(chunk)), "Content-Range": f"bytes {start}-{start + len(chunk) - 1}/{len(data)}"})
            except httpx.HTTPError as e:
                raise HTTPException(502, "The upload to Microsoft stopped part way. Nothing was replaced; try again.") from e
            if r.status_code >= 400:
                raise HTTPException(502, _explain(r))
            if r.status_code in (200, 201):
                it = r.json()
    out = _item(it) if it.get("id") else {"name": name}
    return {"uploaded": True, "name": out.get("name", name), "file": out.get("file", ""), "size": len(data)}


def share(acct: dict, ref: str, people: str = "", access: str = "view") -> dict:
    access = "edit" if str(access).lower() in ("edit", "write", "can edit") else "view"
    who = [p.strip() for p in re.split(r"[,;\s]+", people or "") if p.strip()]
    for p in who:
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", p):
            raise HTTPException(400, f"{p} is not an email address.")
    name = work_suite.name_of(ref, "the file")
    if who:
        body = {"recipients": [{"email": p} for p in who], "roles": ["write" if access == "edit" else "read"],
                "requireSignIn": True, "sendInvitation": True}
        call(acct, "POST", _item_path(ref) + "/invite", json=body)
        return {"shared": True, "name": name, "with": who, "access": access}
    j = call(acct, "POST", _item_path(ref) + "/createLink", json={"type": access, "scope": "organization"}).json()
    return {"shared": True, "name": name, "link": (j.get("link") or {}).get("webUrl", ""), "access": access,
            "who": "people in your company"}


_RANGE = re.compile(r"^[A-Za-z]{1,3}[0-9]{1,7}(:[A-Za-z]{1,3}[0-9]{1,7})?$")


def edit(acct: dict, ref: str, changes) -> dict:
    if isinstance(changes, str):
        try:
            changes = json.loads(changes)
        except ValueError:
            changes = {"text": changes}
    it = meta(acct, ref)
    name = it.get("name", "")
    low = name.lower()
    if low.endswith((".xlsx", ".xlsm")):
        rows = changes if isinstance(changes, list) else (changes or {}).get("cells") or [changes]
        done = []
        for c in rows:
            if not isinstance(c, dict) or not _RANGE.match(str(c.get("range", ""))) or not isinstance(c.get("values"), list):
                raise HTTPException(400, "Each change needs a sheet, a range like B2:C4 and its new values as rows.")
            sheet = str(c.get("sheet") or "Sheet1")
            if not sheet or len(sheet) > 31 or re.search(r"[\[\]:*?/\\]", sheet):
                raise HTTPException(400, f"{sheet} is not a sheet name.")
            call(acct, "PATCH", f"{_item_path(ref)}/workbook/worksheets/{quote(sheet, safe='')}/range(address='{c['range']}')",
                 json={"values": c["values"]})
            done.append(f"{sheet}!{c['range']}")
        return {"changed": True, "name": name, "cells": done}
    if low.endswith(".docx"):
        from . import analysis

        text = (changes or {}).get("text") if isinstance(changes, dict) else None
        if not text or not str(text).strip():
            raise HTTPException(400, "For a Word file, give the new text; Rooks saves it as a new version.")
        made = analysis.make_word(Path(name).stem, str(text))
        data = Path(analysis.get(made["id"])["path"]).read_bytes()
        call(acct, "PUT", _item_path(ref) + "/content", content=data,
             headers={"Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"})
        return {"changed": True, "name": name, "new_version": True,
                "note": "OneDrive keeps the earlier version in the file's version history."}
    raise HTTPException(400, "Rooks can change cells in an Excel file or make a new version of a Word file. This file is neither.")


# --- Teams -------------------------------------------------------------------------------------------------------------
def _plain(html: str) -> str:
    t = re.sub(r"<br\s*/?>|</p>|</div>", "\n", html or "", flags=re.I)
    t = re.sub(r"<[^>]+>", "", t)
    return re.sub(r"\n{3,}", "\n\n", unescape(t)).strip()


def chats(acct: dict, kind: str = "all", limit: int = 50) -> dict:
    out = []
    me = (acct.get("name") or "").strip().lower()
    if kind in ("chats", "all"):
        for c in pages(acct, "/me/chats", {"$expand": "members", "$top": 50}, limit=limit):
            others = [m.get("displayName") or "" for m in c.get("members") or [] if (m.get("displayName") or "").strip().lower() != me]
            name = c.get("topic") or ", ".join(o for o in others if o) or "Chat"
            ref = f"chat:{c['id']}"
            work_suite.remember(ref, name, "chat")
            out.append({"chat": ref, "name": name, "kind": "chat"})
    if kind in ("channels", "all"):
        for t in pages(acct, "/me/joinedTeams", limit=50):
            for ch in pages(acct, f"/teams/{quote(t['id'], safe='')}/channels", limit=50):
                name = f"{t.get('displayName', 'Team')}, {ch.get('displayName', 'Channel')}"
                ref = f"channel:{t['id']}/{ch['id']}"
                work_suite.remember(ref, name, "channel")
                out.append({"chat": ref, "name": name, "kind": "channel"})
    return {"chats": out}


def _chat_path(chat: str) -> str:
    chat = str(chat or "").strip()
    if chat.startswith("chat:") and len(chat) > 5:
        return f"/chats/{quote(chat[5:], safe=':@')}/messages"
    if chat.startswith("channel:") and "/" in chat:
        team, ch = chat[8:].split("/", 1)
        return f"/teams/{quote(team, safe='')}/channels/{quote(ch, safe=':@')}/messages"
    raise HTTPException(400, "That is not a chat or a channel. Use one from work_chats.")


def chat_read(acct: dict, chat: str, since: str = "", limit: int = 20) -> dict:
    limit = max(1, min(int(limit or 20), 50))
    rows = pages(acct, _chat_path(chat), {"$top": limit}, limit=limit)
    msgs = []
    for m in rows:
        if m.get("messageType", "message") != "message" or m.get("deletedDateTime"):
            continue
        when = m.get("createdDateTime") or ""
        if since and when and when < since:
            continue
        sender = ((m.get("from") or {}).get("user") or {}).get("displayName") or "Someone"
        msgs.append({"id": m.get("id"), "from": sender, "when": when, "text": _plain((m.get("body") or {}).get("content", ""))[:4000]})
    msgs.sort(key=lambda x: x["when"] or "")
    return {"chat": chat, "name": work_suite.name_of(chat, "the chat"), "messages": msgs}


def chat_post(acct: dict, chat: str, text: str, reply_to: str = "") -> dict:
    text = str(text or "")
    if not text.strip():
        raise HTTPException(400, "There is nothing to post.")
    path = _chat_path(chat)
    if reply_to:
        if not chat.startswith("channel:"):
            raise HTTPException(400, "Replies are for channel messages; in a chat, just post.")
        path = f"{path}/{quote(str(reply_to), safe='')}/replies"
    call(acct, "POST", path, json={"body": {"contentType": "text", "content": text}})
    return {"posted": True, "where": work_suite.name_of(chat, "the chat"), "text": text}


# --- meeting transcripts -----------------------------------------------------------------------------------------------
def _join_url(acct: dict, event) -> tuple[str, str]:
    """(Teams join address, title) of a calendar event: a local event id, or the event's id at Microsoft."""
    ev_id, title, local = str(event or "").strip(), "", None
    if ev_id.lstrip("#").isdigit():
        local = db.one("SELECT e.uid, e.title, e.location, e.description FROM events e JOIN calendars c ON c.id = e.calendar_id "
                       "WHERE e.id = ? AND c.linked_account_id = ?", int(ev_id.lstrip("#")), acct["id"])
        if not local:
            raise HTTPException(404, "That meeting is not in your work calendar.")
        ev_id, title = local["uid"].split("|", 1)[0], local["title"]
    if work_suite.state(acct, "calendar") == "on":
        ev = call(acct, "GET", f"/me/events/{quote(ev_id, safe='=')}", params={"$select": "subject,onlineMeeting"}).json()
        return ((ev.get("onlineMeeting") or {}).get("joinUrl") or "", ev.get("subject") or title)
    found = re.search(r"https://teams\.microsoft\.com/l/meetup-join/\S+", f"{(local or {}).get('location', '')} {(local or {}).get('description', '')}")
    return (found.group(0) if found else "", title)


def transcript(acct: dict, event="", meeting: str = "") -> dict:
    from . import meetings

    title = ""
    url = str(meeting or "").strip()
    if not url:
        if not str(event or "").strip():
            raise HTTPException(400, "Say which meeting: one from your calendar, or its Teams link.")
        url, title = _join_url(acct, event)
    if not url:
        raise HTTPException(404, "This meeting was not held in Teams.")
    if not url.startswith("https://teams.microsoft.com/"):
        raise HTTPException(400, "That is not a Teams meeting link.")
    found = call(acct, "GET", "/me/onlineMeetings", params={"$filter": f"JoinWebUrl eq '{url}'"}).json().get("value") or []
    if not found:
        raise HTTPException(404, "Teams did not find this meeting for your account. Only meetings you organised or joined can be read.")
    m = found[0]
    trs = call(acct, "GET", f"/me/onlineMeetings/{quote(m['id'], safe='')}/transcripts").json().get("value") or []
    if not trs:
        raise HTTPException(404, "This meeting has no transcript.")
    vtt = call(acct, "GET", f"/me/onlineMeetings/{quote(m['id'], safe='')}/transcripts/{quote(trs[-1]['id'], safe='')}/content",
               params={"$format": "text/vtt"}).text
    made = meetings.create_from_transcript(title or m.get("subject") or "Teams meeting", vtt, source="teams")
    speakers = sorted({s.get("speaker") for s in made.get("segments") or [] if s.get("speaker")})
    return {"meeting_id": made["id"], "title": made["title"], "speakers": speakers, "segments": len(made.get("segments") or [])}


def meetings_list(acct: dict, days: int = 14) -> list[dict]:
    """Recent and coming meetings from the work calendar, each saying whether it was held in Teams."""
    now = datetime.now(timezone.utc)
    rows = pages(acct, "/me/calendarView", {"startDateTime": (now - timedelta(days=days)).isoformat(),
                                            "endDateTime": (now + timedelta(days=2)).isoformat(),
                                            "$select": "id,subject,start,onlineMeeting", "$top": 100}, limit=200)
    return [{"event": r["id"], "title": r.get("subject") or "(no title)", "start": (r.get("start") or {}).get("dateTime", ""),
             "teams": bool((r.get("onlineMeeting") or {}).get("joinUrl"))} for r in rows]


# --- Planner and To Do -------------------------------------------------------------------------------------------------
def _status_planner(pc) -> str:
    return "done" if (pc or 0) >= 100 else ("doing" if (pc or 0) > 0 else "todo")


def _upsert(origin: str, rid: str, title: str, status: str, due: str | None, meta_: dict) -> int:
    now = db.now()
    row = db.one("SELECT id FROM tasks WHERE origin = ? AND remote_id = ?", origin, rid)
    if row:
        db.run("UPDATE tasks SET title = ?, status = ?, due = ?, remote_meta = ?, updated_at = ?, "
               "completed_at = CASE WHEN ? = 'done' THEN COALESCE(completed_at, ?) ELSE NULL END WHERE id = ?",
               title, status, due, json.dumps(meta_), now, status, now, row["id"])
        return row["id"]
    return db.run("INSERT INTO tasks(title, status, due, origin, remote_id, remote_meta, created_at, updated_at, completed_at) "
                  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", title, status, due, origin, rid, json.dumps(meta_), now, now,
                  now if status == "done" else None)


def sync_tasks(acct: dict) -> dict:
    n_p = n_t = 0
    for t in pages(acct, "/me/planner/tasks", limit=500):
        due = (t.get("dueDateTime") or "")[:10] or None
        _upsert("planner", t["id"], t.get("title") or "(untitled)", _status_planner(t.get("percentComplete")), due,
                {"plan": t.get("planId", ""), "etag": t.get("@odata.etag", "")})
        n_p += 1
    for lst in pages(acct, "/me/todo/lists", limit=50):
        for t in pages(acct, f"/me/todo/lists/{quote(lst['id'], safe='=')}/tasks", limit=500):
            due = ((t.get("dueDateTime") or {}).get("dateTime") or "")[:10] or None
            _upsert("todo", t["id"], t.get("title") or "(untitled)", "done" if t.get("status") == "completed" else "todo", due,
                    {"list": lst["id"], "list_name": lst.get("displayName", "")})
            n_t += 1
    return {"planner": n_p, "todo": n_t}


def _due(due: str) -> str:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(due or "")):
        raise HTTPException(400, "Give the date as YYYY-MM-DD.")
    return due


def task_update(acct: dict, task="", done: bool | None = None, due: str = "", title: str = "") -> dict:
    if not str(task or "").strip():  # a new task in the person's To Do
        if not str(title or "").strip():
            raise HTTPException(400, "Give the new task a title.")
        lists = pages(acct, "/me/todo/lists", limit=50)
        lst = next((x for x in lists if x.get("wellknownListName") == "defaultList"), lists[0] if lists else None)
        if not lst:
            raise HTTPException(404, "There is no To Do list to add it to.")
        body: dict = {"title": str(title).strip()}
        if due:
            body["dueDateTime"] = {"dateTime": f"{_due(due)}T00:00:00", "timeZone": "UTC"}
        t = call(acct, "POST", f"/me/todo/lists/{quote(lst['id'], safe='=')}/tasks", json=body).json()
        tid = _upsert("todo", t.get("id") or uuid.uuid4().hex, body["title"], "todo", due or None,
                      {"list": lst["id"], "list_name": lst.get("displayName", "")})
        return {"added": True, "task": tid, "title": body["title"], "where": "To Do"}
    row = db.one("SELECT * FROM tasks WHERE id = ?", int(str(task).lstrip("#")))
    if not row:
        raise HTTPException(404, "There is no such task.")
    if row["origin"] not in ("planner", "todo"):
        raise HTTPException(400, "That task is kept only in Rooks. Change it with update_task.")
    m = json.loads(row["remote_meta"] or "{}")
    if row["origin"] == "planner":
        body = {}
        if done is not None:
            body["percentComplete"] = 100 if done else 0
        if due:
            body["dueDateTime"] = f"{_due(due)}T00:00:00Z"
        if title:
            body["title"] = str(title)
        if not body:
            raise HTTPException(400, "Say what to change: done, due or title.")
        fresh = call(acct, "GET", f"/planner/tasks/{quote(row['remote_id'], safe='')}").json()
        call(acct, "PATCH", f"/planner/tasks/{quote(row['remote_id'], safe='')}", json=body,
             headers={"If-Match": fresh.get("@odata.etag") or m.get("etag", "")})
        status = _status_planner(body["percentComplete"]) if "percentComplete" in body else row["status"]
        where = "Planner"
    else:
        body = {}
        if done is not None:
            body["status"] = "completed" if done else "notStarted"
        if due:
            body["dueDateTime"] = {"dateTime": f"{_due(due)}T00:00:00", "timeZone": "UTC"}
        if title:
            body["title"] = str(title)
        if not body:
            raise HTTPException(400, "Say what to change: done, due or title.")
        call(acct, "PATCH", f"/me/todo/lists/{quote(m.get('list', ''), safe='=')}/tasks/{quote(row['remote_id'], safe='=')}", json=body)
        status = ("done" if done else "todo") if done is not None else row["status"]
        where = "To Do"
    now = db.now()
    db.run("UPDATE tasks SET status = ?, due = COALESCE(?, due), title = COALESCE(?, title), updated_at = ?, "
           "completed_at = CASE WHEN ? = 'done' THEN COALESCE(completed_at, ?) ELSE NULL END WHERE id = ?",
           status, due or None, title or None, now, status, now, row["id"])
    return {"changed": True, "task": row["id"], "where": where, "title": title or row["title"], "status": status}
