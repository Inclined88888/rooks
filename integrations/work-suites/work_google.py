"""Google Workspace for the work account (design 0012, section 2.3): Drive (My Drive, shared drives and files shared with
the person), Docs and Sheets, Google Chat, Meet transcripts and Google Tasks. Every call is the person's own access.

The functions and their arguments are the same as work_graph.py's, so the tools, /api/work and the terminal's /work do
not know which suite answers (work_suite.calls).

* `call` refreshes the access token when needed and retries once after a 401, waits out a 429 or 503 and Google's
  rate-limit 403 (rateLimitExceeded, userRateLimitExceeded) with Retry-After (up to 30 s, twice), and turns Google's
  errors into plain words. httpx is wrapped by egress.py, so every request is a row in the outbound record; the token
  travels only in the Authorization header, never in a URL, and never to a resumable upload's own address.
* Reads never wait for a yes. Every write here (upload, new version, share, Docs edit, Sheets edit, post, task change)
  is reached only through a tool that always waits in Needs you (work_suite.WRITES), with the stored arguments, on a yes.
* A Docs change is written on top of the revision Rooks just read (writeControl.requiredRevisionId): if someone typed
  in between, Google refuses it and nothing is overwritten. Sheets values are written as given (RAW), never as formulas.
* Docs, Sheets and Slides are exported for reading as .docx, .xlsx and .pptx when the files add-on can read those, else
  as plain text or CSV, so reading works without it too.

Refs: a file is its Drive id, a shared drive "gdrive:<id>" in the names kept, a Chat space "space:<id>".
API bases: DRIVE_API_BASE, DRIVE_UPLOAD_BASE, DOCS_API_BASE, SHEETS_API_BASE, GCHAT_API_BASE, MEET_API_BASE,
GTASKS_API_BASE and GCAL_API_BASE (tests point them at tests/fake_google.py).
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

import httpx
from fastapi import HTTPException

from . import cloud_mail, connect, db, work_suite

MAX_READ = 100 * 1024 * 1024        # a file read or saved from work: 100 MB at most
SMALL_UPLOAD = 5 * 1024 * 1024      # Drive's multipart upload limit; larger files go through a resumable upload
CHUNK = 16 * 256 * 1024             # resumable chunks must be multiples of 256 KiB (4 MiB)
MAX_PAGES = 20
G = "application/vnd.google-apps."
DOC, SHEET, SLIDES, FOLDER, DRAWING = G + "document", G + "spreadsheet", G + "presentation", G + "folder", G + "drawing"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
FIELDS = "id,name,mimeType,size,modifiedTime,webViewLink,driveId,parents"
_ID = re.compile(r"^[A-Za-z0-9_-]{1,200}$")
_MSG = re.compile(r"^[A-Za-z0-9_.-]{1,200}$")
RATE = ("rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded")


def _base(env: str, default: str) -> str:
    return os.getenv(env, default).rstrip("/")


def drive() -> str:
    return _base("DRIVE_API_BASE", "https://www.googleapis.com/drive/v3")


def upload_base() -> str:
    return _base("DRIVE_UPLOAD_BASE", "https://www.googleapis.com/upload/drive/v3")


def docs() -> str:
    return _base("DOCS_API_BASE", "https://docs.googleapis.com/v1")


def sheets() -> str:
    return _base("SHEETS_API_BASE", "https://sheets.googleapis.com/v4")


def gchat() -> str:
    return _base("GCHAT_API_BASE", "https://chat.googleapis.com/v1")


def meet() -> str:
    return _base("MEET_API_BASE", "https://meet.googleapis.com/v2")


def gtasks() -> str:
    return _base("GTASKS_API_BASE", "https://tasks.googleapis.com/tasks/v1")


def _error(r: httpx.Response) -> tuple[str, str]:
    """(status, reason) from Google's error body: {"error": {"status": ..., "errors": [{"reason": ...}]}}."""
    try:
        err = (r.json() or {}).get("error") or {}
    except ValueError:
        return "", ""
    if not isinstance(err, dict):
        return str(err), ""
    reasons = [e.get("reason", "") for e in err.get("errors") or [] if isinstance(e, dict)]
    return str(err.get("status") or ""), (reasons[0] if reasons else "")


def _explain(r: httpx.Response) -> str:
    status, reason = _error(r)
    if r.status_code == 429 or reason in RATE:
        return "Google is busy with too many requests right now. Try again in a minute."
    if status == "FAILED_PRECONDITION" or r.status_code == 412:
        return "Someone changed it in the meantime. Look at it again, then try once more."
    if r.status_code == 403:
        return ("Google said your account does not allow that. Your company may need to allow it, or you may not have "
                "access to that item.")
    if r.status_code == 404:
        return "Google could not find that. It may have been moved or deleted, or you may not have access."
    return f"Google could not do that right now ({reason or status or r.status_code})."


def _rate_limited(r: httpx.Response) -> bool:
    return r.status_code in (429, 503) or (r.status_code == 403 and _error(r)[1] in RATE)


def call(acct: dict, method: str, url: str, *, ok: tuple[int, ...] = (), **kw) -> httpx.Response:
    """One Google request as the work account. `url` is a full address (one of the bases above plus a path)."""
    headers = kw.pop("headers", {}) or {}
    refreshed, throttled, r = False, 0, None
    while True:
        token = connect.access_token(acct["id"], force=refreshed)
        try:
            r = httpx.request(method, url, headers={"Authorization": f"Bearer {token}", **headers}, timeout=60,
                              follow_redirects=False, **kw)
        except httpx.HTTPError as e:
            raise HTTPException(502, "Couldn't reach Google. Check your connection and try again.") from e
        if r.status_code == 401 and not refreshed:
            refreshed = True
            continue
        if _rate_limited(r) and throttled < 2:
            throttled += 1
            work_suite.sleep(work_suite.wait_s(r.headers.get("retry-after")))
            continue
        break
    if r.status_code == 401:
        connect.mark_reauth(acct["id"], "Google rejected the access token")
        raise HTTPException(401, f"{acct['email']} needs to sign in again, in Work apps.")
    if r.status_code >= 400 and r.status_code not in ok:
        status, _ = _error(r)
        code = 409 if status == "FAILED_PRECONDITION" else 403 if r.status_code == 403 else 404 if r.status_code == 404 else 502
        raise HTTPException(code, _explain(r))
    return r


def _paged(acct: dict, url: str, key: str, params: dict | None = None, limit: int = 200, size_param: str = "pageSize") -> list[dict]:
    out: list[dict] = []
    params = dict(params or {})
    params.setdefault(size_param, min(100, max(1, limit)))
    for _ in range(MAX_PAGES):
        j = call(acct, "GET", url, params=params).json()
        out += j.get(key) or []
        nxt = j.get("nextPageToken")
        if not nxt or len(out) >= limit:
            break
        params["pageToken"] = nxt
    return out[:limit]


# --- Drive: names and references ---------------------------------------------------------------------------------------
def _fid(ref: str) -> str:
    ref = str(ref or "").strip()
    if not _ID.match(ref):
        raise HTTPException(400, "That is not a work file. Use the file's reference from work_files or work_search.")
    return ref


def _q(words: str) -> str:
    """Words inside a Drive query's quotes: a backslash and a quote are escaped, so words never change the query."""
    return str(words).replace("\\", "\\\\").replace("'", "\\'")


def _drive_name(acct: dict, drive_id: str) -> str:
    name = work_suite.name_of(f"gdrive:{drive_id}")
    if not name:  # a shared drive not listed yet: list them once, so the place has its name
        try:
            sites(acct)
        except HTTPException:
            pass
        name = work_suite.name_of(f"gdrive:{drive_id}", "a shared drive")
    return name


def _item(acct: dict, it: dict, where: str = "") -> dict:
    is_folder = it.get("mimeType") == FOLDER
    out = {"file": it.get("id", ""), "name": it.get("name", ""), "folder": is_folder,
           "size": int(it["size"]) if str(it.get("size") or "").isdigit() else None, "modified": it.get("modifiedTime"),
           "where": where or (_drive_name(acct, it["driveId"]) if it.get("driveId") else "My Drive"),
           "web_url": it.get("webViewLink", "")}
    work_suite.remember(out["file"], out["name"], "folder" if is_folder else "file", out["web_url"])
    return out


def _files(acct: dict, q: str, corpora: str, drive_id: str = "", limit: int = 100) -> list[dict]:
    params = {"q": q, "fields": f"nextPageToken,files({FIELDS})", "supportsAllDrives": "true",
              "includeItemsFromAllDrives": "true", "corpora": corpora}
    if drive_id:
        params["driveId"] = drive_id
    return _paged(acct, f"{drive()}/files", "files", params, limit)


# --- Drive: read -------------------------------------------------------------------------------------------------------
def search(acct: dict, query: str, kind: str = "files", limit: int = 20) -> dict:
    query = (query or "").strip()
    if not query:
        raise HTTPException(400, "Say what to look for.")
    limit = max(1, min(int(limit or 20), 100))
    if kind == "chats":
        return chat_search(acct, query, limit)
    rows = _files(acct, f"fullText contains '{_q(query)}' and trashed = false", "allDrives", limit=limit)
    return {"items": [{**_item(acct, x), "match": ""} for x in rows]}


def sites(acct: dict) -> list[dict]:
    """The shared drives the person can open (Drive's own word for what SharePoint calls sites)."""
    out = []
    for d in _paged(acct, f"{drive()}/drives", "drives", limit=100):
        work_suite.remember(f"gdrive:{d['id']}", d.get("name") or "Shared drive", "drive")
        out.append({"id": d["id"], "name": d.get("name") or "Shared drive"})
    return out


def listing(acct: dict, folder: str = "", site: str = "", shared: bool = False, limit: int = 100) -> dict:
    limit = max(1, min(int(limit or 100), 500))
    if shared:
        rows = _files(acct, "sharedWithMe and trashed = false", "user", limit=limit)
        return {"items": [_item(acct, x, "Shared with you") for x in rows]}
    if site:
        d = _fid(site)
        where = _drive_name(acct, d)
        rows = _files(acct, f"'{d}' in parents and trashed = false", "drive", drive_id=d, limit=limit)
        return {"items": [_item(acct, x, where) for x in rows]}
    if folder:
        rows = _files(acct, f"'{_fid(folder)}' in parents and trashed = false", "allDrives", limit=limit)
        return {"items": [_item(acct, x) for x in rows]}
    rows = _files(acct, "'root' in parents and trashed = false", "user", limit=limit)
    return {"items": [_item(acct, x, "My Drive") for x in rows]}


def meta(acct: dict, ref: str) -> dict:
    it = call(acct, "GET", f"{drive()}/files/{_fid(ref)}", params={"fields": FIELDS, "supportsAllDrives": "true"}).json()
    _item(acct, it)
    return it


def _export_as(mime: str) -> tuple[str, str] | None:
    """How a Google Docs, Sheets or Slides file is read: the Office format when the files add-on reads it, else text."""
    has = lambda m: importlib.util.find_spec(m) is not None  # noqa: E731
    if mime == DOC:
        return (DOCX, ".docx") if has("docx") else ("text/plain", ".txt")
    if mime == SHEET:
        return (XLSX, ".xlsx") if has("openpyxl") else ("text/csv", ".csv")
    if mime == SLIDES:
        return (PPTX, ".pptx") if has("pptx") else ("text/plain", ".txt")
    if mime == DRAWING:
        return ("application/pdf", ".pdf")
    return None


def download(acct: dict, ref: str) -> tuple[dict, bytes, str]:
    """(metadata, bytes, the name to read it by) of a Drive file; Google's own files are exported."""
    it = meta(acct, ref)
    mime = it.get("mimeType", "")
    if mime == FOLDER:
        raise HTTPException(400, "That is a folder. List what is in it with work_files.")
    name = it.get("name") or "file"
    if mime.startswith(G):
        how = _export_as(mime)
        if not how:
            raise HTTPException(400, "That kind of Google file cannot be read here. Open it instead.")
        r = call(acct, "GET", f"{drive()}/files/{_fid(ref)}/export", params={"mimeType": how[0]})
        if not name.lower().endswith(how[1]):
            name += how[1]
    else:
        if int(it.get("size") or 0) > MAX_READ:
            raise HTTPException(413, "That file is larger than 100 MB, too large to read here. Open it instead.")
        r = call(acct, "GET", f"{drive()}/files/{_fid(ref)}", params={"alt": "media", "supportsAllDrives": "true"})
    data = r.content
    if len(data) > MAX_READ:
        raise HTTPException(413, "That file is larger than 100 MB, too large to read here. Open it instead.")
    return it, data, name


def _where_of(acct: dict, it: dict) -> str:
    return _drive_name(acct, it["driveId"]) if it.get("driveId") else "My Drive"


def read(acct: dict, ref: str, part: int = 1, query: str = "") -> dict:
    from . import analysis, config, files

    it, data, name = download(acct, ref)
    tmp = Path(tempfile.mkdtemp(prefix="work-", dir=str(config.DATA_DIR)))
    try:
        p = tmp / analysis._safe_name(name)
        p.write_bytes(data)
        d = files.extract(p, name)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return {**analysis.read_extract(d, int(part or 1), query or ""), "file": ref, "from": _where_of(acct, it)}


def save(acct: dict, ref: str) -> dict:
    from . import analysis

    it, data, name = download(acct, ref)
    f = analysis.add(name, data=data, source="gdrive", remote=ref)
    return {**{k: f[k] for k in ("id", "name", "kind", "summary", "source")}, "remote": ref, "from": _where_of(acct, it)}


def open_address(acct: dict, ref: str) -> dict:
    it = meta(acct, ref)
    return {"address": it.get("webViewLink", ""), "name": it.get("name", "")}


# --- Drive: change (always after a yes) --------------------------------------------------------------------------------
def _resumable(acct: dict, start: httpx.Response, data: bytes) -> dict:
    """Send the bytes to a resumable upload's own address, in chunks. That address carries its own authorisation: the
    Google token is never sent there. A chunk Google kept only part of is sent again from where it stopped."""
    url = start.headers.get("location")
    if not url:
        raise HTTPException(502, "Google did not start the upload. Nothing was changed; try again.")
    total, pos, tries = len(data), 0, 0
    while pos < total and tries < 4 * (total // CHUNK + 2):
        tries += 1
        chunk = data[pos:pos + CHUNK]
        try:
            r = httpx.put(url, content=chunk, timeout=120,
                          headers={"Content-Length": str(len(chunk)), "Content-Range": f"bytes {pos}-{pos + len(chunk) - 1}/{total}"})
        except httpx.HTTPError as e:
            raise HTTPException(502, "The upload to Google stopped part way. Nothing was replaced; try again.") from e
        if r.status_code == 308:
            m = re.match(r"bytes=0-(\d+)", r.headers.get("range", ""))
            pos = int(m.group(1)) + 1 if m else 0
            continue
        if r.status_code in (200, 201):
            return r.json()
        raise HTTPException(502, _explain(r))
    raise HTTPException(502, "The upload to Google did not finish. Nothing was replaced; try again.")


def upload(acct: dict, file_id, folder: str = "", replace: bool = False) -> dict:
    from . import analysis

    f = analysis.get(int(str(file_id).lstrip("#")))
    path = Path(f["path"])
    if not path.is_file():
        raise HTTPException(400, "Only a single file can be uploaded, not a folder.")
    data, name = path.read_bytes(), f["name"]
    parent = _fid(folder) if folder else "root"
    existing = None
    if replace:  # Drive allows two files with one name; replacing means a new version of the one already there
        same = _files(acct, f"name = '{_q(name)}' and '{parent}' in parents and trashed = false", "allDrives", limit=5)
        existing = next((x for x in same if not str(x.get("mimeType", "")).startswith(G)), None)
    common = {"supportsAllDrives": "true", "fields": FIELDS}
    if existing:
        target = f"{upload_base()}/files/{existing['id']}"
        if len(data) <= SMALL_UPLOAD:
            it = call(acct, "PATCH", target, params={**common, "uploadType": "media"}, content=data,
                      headers={"Content-Type": "application/octet-stream"}).json()
        else:
            s = call(acct, "PATCH", target, params={**common, "uploadType": "resumable"}, json={},
                     headers={"X-Upload-Content-Length": str(len(data))})
            it = _resumable(acct, s, data)
    elif len(data) <= SMALL_UPLOAD:
        boundary = f"rooks-{uuid.uuid4().hex}"
        body = (f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"
                f"{json.dumps({'name': name, 'parents': [parent]})}\r\n--{boundary}\r\n"
                "Content-Type: application/octet-stream\r\n\r\n").encode() + data + f"\r\n--{boundary}--\r\n".encode()
        it = call(acct, "POST", f"{upload_base()}/files", params={**common, "uploadType": "multipart"}, content=body,
                  headers={"Content-Type": f"multipart/related; boundary={boundary}"}).json()
    else:
        s = call(acct, "POST", f"{upload_base()}/files", params={**common, "uploadType": "resumable"},
                 json={"name": name, "parents": [parent]}, headers={"X-Upload-Content-Length": str(len(data))})
        it = _resumable(acct, s, data)
    out = _item(acct, it) if it.get("id") else {"name": name, "file": ""}
    return {"uploaded": True, "name": out.get("name", name), "file": out.get("file", ""), "size": len(data),
            "replaced": bool(existing)}


def share(acct: dict, ref: str, people: str = "", access: str = "view") -> dict:
    fid = _fid(ref)
    access = "edit" if str(access).lower() in ("edit", "write", "can edit") else "view"
    role = "writer" if access == "edit" else "reader"
    who = [p.strip() for p in re.split(r"[,;\s]+", people or "") if p.strip()]
    for p in who:
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", p):
            raise HTTPException(400, f"{p} is not an email address.")
    name = work_suite.name_of(fid, "the file")
    url = f"{drive()}/files/{fid}/permissions"
    if who:
        for p in who:
            call(acct, "POST", url, params={"supportsAllDrives": "true", "sendNotificationEmail": "true"},
                 json={"type": "user", "role": role, "emailAddress": p})
        return {"shared": True, "name": name, "with": who, "access": access}
    domain = str(acct.get("tenant") or "").strip()
    if not domain:
        raise HTTPException(400, "Rooks does not know your company's domain, so it cannot make a company link. Share with people by email instead.")
    call(acct, "POST", url, params={"supportsAllDrives": "true"}, json={"type": "domain", "role": role, "domain": domain})
    return {"shared": True, "name": name, "link": meta(acct, fid).get("webViewLink", ""), "access": access,
            "who": "people in your company"}


_RANGE = re.compile(r"^[A-Za-z]{1,3}[0-9]{1,7}(:[A-Za-z]{1,3}[0-9]{1,7})?$")


def _doc_edit(acct: dict, fid: str, name: str, changes) -> dict:
    if not isinstance(changes, dict):
        raise HTTPException(400, "For a Google Doc, give the new text, an append, or a list of replace pairs (find and with).")
    text, append = changes.get("text"), changes.get("append")
    pairs = [p for p in changes.get("replace") or [] if isinstance(p, dict) and str(p.get("find") or "")]
    if text and (pairs or append):
        raise HTTPException(400, "Give either the whole new text or the changes, not both.")
    doc = call(acct, "GET", f"{docs()}/documents/{fid}").json()
    requests: list[dict] = []
    if text:
        end = max([int(c.get("endIndex") or 1) for c in (doc.get("body") or {}).get("content") or []] or [1])
        if end - 1 > 1:  # everything but the last newline, which a document always keeps
            requests.append({"deleteContentRange": {"range": {"startIndex": 1, "endIndex": end - 1}}})
        requests.append({"insertText": {"location": {"index": 1}, "text": str(text)}})
    for p in pairs:
        requests.append({"replaceAllText": {"containsText": {"text": str(p["find"]), "matchCase": True}, "replaceText": str(p.get("with") or "")}})
    if append:
        requests.append({"insertText": {"endOfSegmentLocation": {}, "text": "\n" + str(append)}})
    if not requests:
        raise HTTPException(400, "Say what to change: the new text, an append, or replace pairs.")
    call(acct, "POST", f"{docs()}/documents/{fid}:batchUpdate",
         json={"requests": requests, "writeControl": {"requiredRevisionId": doc.get("revisionId", "")}})
    return {"changed": True, "name": name, "note": "Google Docs keeps the earlier text in the document's version history."}


def _sheet_edit(acct: dict, fid: str, name: str, changes) -> dict:
    rows = changes if isinstance(changes, list) else (changes or {}).get("cells") or [changes]
    data, done = [], []
    for c in rows:
        if not isinstance(c, dict) or not _RANGE.match(str(c.get("range", ""))) or not isinstance(c.get("values"), list):
            raise HTTPException(400, "Each change needs a sheet, a range like B2:C4 and its new values as rows.")
        sheet = str(c.get("sheet") or "Sheet1")
        if not sheet or len(sheet) > 100 or re.search(r"[\[\]:*?/\\]", sheet):
            raise HTTPException(400, f"{sheet} is not a sheet name.")
        data.append({"range": "'" + sheet.replace("'", "''") + "'!" + c["range"], "values": c["values"]})
        done.append(f"{sheet}!{c['range']}")
    call(acct, "POST", f"{sheets()}/spreadsheets/{fid}/values:batchUpdate", json={"valueInputOption": "RAW", "data": data})
    return {"changed": True, "name": name, "cells": done}


def edit(acct: dict, ref: str, changes) -> dict:
    if isinstance(changes, str):
        try:
            changes = json.loads(changes)
        except ValueError:
            changes = {"text": changes}
    fid = _fid(ref)
    it = meta(acct, fid)
    name, mime = it.get("name", ""), it.get("mimeType", "")
    if mime == DOC:
        return _doc_edit(acct, fid, name, changes)
    if mime == SHEET:
        return _sheet_edit(acct, fid, name, changes)
    if name.lower().endswith(".docx"):
        from . import analysis

        text = (changes or {}).get("text") if isinstance(changes, dict) else None
        if not text or not str(text).strip():
            raise HTTPException(400, "For a Word file, give the new text; Rooks saves it as a new version.")
        made = analysis.make_word(Path(name).stem, str(text))
        data = Path(analysis.get(made["id"])["path"]).read_bytes()
        call(acct, "PATCH", f"{upload_base()}/files/{fid}", params={"uploadType": "media", "supportsAllDrives": "true"},
             content=data, headers={"Content-Type": DOCX})
        return {"changed": True, "name": name, "new_version": True,
                "note": "Google Drive keeps the earlier version in the file's version history."}
    raise HTTPException(400, "Rooks can change a Google Doc or Sheet, or make a new version of a Word file. This file is none of those.")


# --- Google Chat -------------------------------------------------------------------------------------------------------
def _space(chat: str) -> str:
    chat = str(chat or "").strip()
    if chat.startswith("space:") and _ID.match(chat[6:]):
        return f"spaces/{chat[6:]}"
    raise HTTPException(400, "That is not a Google Chat space. Use one from work_chats.")


def _sender(acct: dict, s: dict) -> str:
    """Google Chat names the sender only by an id when Rooks reads as the person; so: the name when Google gives one,
    "You" for the person's own messages, else "Someone"."""
    s = s or {}
    if s.get("displayName"):
        return s["displayName"]
    if acct.get("subject") and s.get("name") == f"users/{acct['subject']}":
        return "You"
    return "Someone"


def _day(iso: str) -> str:
    try:
        d = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        return f"{d.day} {d.strftime('%b')}"
    except ValueError:
        return ""


def chats(acct: dict, kind: str = "all", limit: int = 50) -> dict:
    rows = _paged(acct, f"{gchat()}/spaces", "spaces", limit=max(limit, 100))
    dms = sum(1 for s in rows if s.get("spaceType") == "DIRECT_MESSAGE")
    out = []
    for s in rows:
        sid = str(s.get("name", "")).removeprefix("spaces/")
        if not _ID.match(sid):
            continue
        st = s.get("spaceType") or ("SPACE" if s.get("type") == "ROOM" else "DIRECT_MESSAGE")
        is_space = st == "SPACE"
        if (kind == "chats" and is_space) or (kind == "channels" and not is_space):
            continue
        if st == "DIRECT_MESSAGE":
            name = "Direct message" + (f", active {_day(s.get('lastActiveTime', ''))}" if dms > 1 and s.get("lastActiveTime") else "")
        else:
            name = s.get("displayName") or ("Space" if is_space else "Group chat")
        ref = f"space:{sid}"
        work_suite.remember(ref, name, "space" if is_space else "chat")
        out.append({"chat": ref, "name": name, "kind": "space" if is_space else "chat"})
    return {"chats": out[:limit]}


def _messages(acct: dict, space: str, limit: int, since: str = "") -> list[dict]:
    params = {"pageSize": limit, "orderBy": "createTime desc"}
    if since:
        params["filter"] = f'createTime > "{since}"'
    rows = call(acct, "GET", f"{gchat()}/{space}/messages", params=params).json().get("messages") or []
    out = []
    for m in rows:
        if m.get("deleteTime"):
            continue
        out.append({"id": str(m.get("name", "")).rsplit("/", 1)[-1], "from": _sender(acct, m.get("sender") or {}),
                    "when": m.get("createTime") or "", "text": str(m.get("text") or m.get("argumentText") or "")[:4000]})
    out.reverse()  # oldest first, as a conversation reads
    return out


def chat_read(acct: dict, chat: str, since: str = "", limit: int = 20) -> dict:
    limit = max(1, min(int(limit or 20), 50))
    if since and not re.fullmatch(r"\d{4}-\d{2}-\d{2}(T[0-9:.]+(Z|[+-]\d{2}:\d{2})?)?", since):
        raise HTTPException(400, "Give since as a date and time like 2026-11-09T09:00:00Z.")
    return {"chat": chat, "name": work_suite.name_of(chat, "the chat"), "messages": _messages(acct, _space(chat), limit, since)}


def chat_search(acct: dict, query: str, limit: int = 20) -> dict:
    """Google Chat has no search a person's own access can use, so this reads the latest messages of the person's spaces
    (up to 20 spaces, 50 messages each) and keeps those with every word."""
    words = [w for w in query.lower().split() if w]
    out = []
    for c in chats(acct, "all", 20)["chats"]:
        for m in _messages(acct, _space(c["chat"]), 50):
            if all(w in m["text"].lower() for w in words):
                out.append({"chat": c["chat"], "where": c["name"], "from": m["from"], "when": m["when"], "text": m["text"][:500]})
                if len(out) >= limit:
                    return {"messages": out}
    return {"messages": out}


def chat_post(acct: dict, chat: str, text: str, reply_to: str = "") -> dict:
    text = str(text or "")
    if not text.strip():
        raise HTTPException(400, "There is nothing to post.")
    space = _space(chat)
    body: dict = {"text": text}
    params: dict = {}
    if reply_to:
        if not _MSG.match(str(reply_to)):
            raise HTTPException(400, "That is not a message to answer. Use one from work_chat_read.")
        m = call(acct, "GET", f"{gchat()}/{space}/messages/{reply_to}").json()
        if (m.get("thread") or {}).get("name"):
            body["thread"] = {"name": m["thread"]["name"]}
            params["messageReplyOption"] = "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD"
    call(acct, "POST", f"{gchat()}/{space}/messages", params=params, json=body)
    return {"posted": True, "where": work_suite.name_of(chat, "the chat"), "text": text}


# --- Meet transcripts --------------------------------------------------------------------------------------------------
_MEET = re.compile(r"https://meet\.google\.com/([a-z]{3}-[a-z]{4}-[a-z]{3})\b")


def _meet_link(ev: dict) -> str:
    if ev.get("hangoutLink"):
        return ev["hangoutLink"]
    for e in ((ev.get("conferenceData") or {}).get("entryPoints") or []):
        if e.get("entryPointType") == "video" and _MEET.match(str(e.get("uri") or "")):
            return e["uri"]
    return ""


def _join_url(acct: dict, event) -> tuple[str, str]:
    """(Meet address, title) of a calendar event: a local event id, or the event's id at Google."""
    ev_id, title, local = str(event or "").strip(), "", None
    if ev_id.lstrip("#").isdigit():
        local = db.one("SELECT e.uid, e.title, e.location, e.description FROM events e JOIN calendars c ON c.id = e.calendar_id "
                       "WHERE e.id = ? AND c.linked_account_id = ?", int(ev_id.lstrip("#")), acct["id"])
        if not local:
            raise HTTPException(404, "That meeting is not in your work calendar.")
        ev_id, title = local["uid"].split("|", 1)[0], local["title"]
    if work_suite.state(acct, "calendar") == "on" and re.fullmatch(r"[A-Za-z0-9_@.-]{1,1024}", ev_id):
        ev = call(acct, "GET", f"{cloud_mail.gcal()}/calendars/primary/events/{quote(ev_id, safe='@')}").json()
        return _meet_link(ev), ev.get("summary") or title
    found = _MEET.search(f"{(local or {}).get('location', '')} {(local or {}).get('description', '')}")
    return (found.group(0) if found else "", title)


def _secs(iso: str, base: datetime) -> float:
    try:
        return max(0.0, (datetime.fromisoformat(str(iso).replace("Z", "+00:00")) - base).total_seconds())
    except ValueError:
        return 0.0


def transcript(acct: dict, event="", meeting: str = "") -> dict:
    from . import meetings

    title = ""
    url = str(meeting or "").strip()
    if not url:
        if not str(event or "").strip():
            raise HTTPException(400, "Say which meeting: one from your calendar, or its Meet link.")
        url, title = _join_url(acct, event)
    if not url:
        raise HTTPException(404, "This meeting was not held in Google Meet.")
    m = _MEET.match(url)
    if not m:
        raise HTTPException(400, "That is not a Google Meet link.")
    recs = call(acct, "GET", f"{meet()}/conferenceRecords", params={"filter": f'space.meeting_code = "{m.group(1)}"'}).json()
    recs = recs.get("conferenceRecords") or []
    if not recs:
        raise HTTPException(404, "Google Meet did not find this call for your account. Only calls you were in can be read.")
    rec = sorted(recs, key=lambda r: r.get("startTime") or "")[-1]
    trs = call(acct, "GET", f"{meet()}/{rec['name']}/transcripts").json().get("transcripts") or []
    if not trs:
        raise HTTPException(404, "This meeting has no transcript.")
    people = {}
    for p in _paged(acct, f"{meet()}/{rec['name']}/participants", "participants", limit=500):
        who = p.get("signedinUser") or p.get("anonymousUser") or p.get("phoneUser") or {}
        people[p.get("name", "")] = who.get("displayName") or "Someone"
    entries = _paged(acct, f"{meet()}/{trs[-1]['name']}/entries", "transcriptEntries", limit=5000)
    base = None
    try:
        base = datetime.fromisoformat(str(rec.get("startTime") or entries[0]["startTime"]).replace("Z", "+00:00"))
    except (ValueError, IndexError, KeyError):
        base = datetime.now(timezone.utc)
    segs = [{"start": _secs(e.get("startTime", ""), base), "end": _secs(e.get("endTime", ""), base),
             "speaker": people.get(e.get("participant", ""), "Someone"), "text": str(e.get("text") or "").strip()}
            for e in entries if str(e.get("text") or "").strip()]
    if not segs:
        raise HTTPException(404, "This meeting has no transcript.")
    made = meetings.create_from_transcript(title or "Meet call", json.dumps({"segments": segs}), source="meet", name="transcript.json")
    speakers = sorted({s.get("speaker") for s in made.get("segments") or [] if s.get("speaker")})
    return {"meeting_id": made["id"], "title": made["title"], "speakers": speakers, "segments": len(made.get("segments") or [])}


def meetings_list(acct: dict, days: int = 14) -> list[dict]:
    now = datetime.now(timezone.utc)
    rows = _paged(acct, f"{cloud_mail.gcal()}/calendars/primary/events", "items",
                  {"timeMin": (now - timedelta(days=days)).isoformat(), "timeMax": (now + timedelta(days=2)).isoformat(),
                   "singleEvents": "true", "orderBy": "startTime"}, limit=200, size_param="maxResults")
    out = []
    for r in rows:
        online = bool(_meet_link(r))
        out.append({"event": r["id"], "title": r.get("summary") or "(no title)",
                    "start": (r.get("start") or {}).get("dateTime") or (r.get("start") or {}).get("date", ""),
                    "online": online, "teams": False})
    return out


# --- Google Tasks ------------------------------------------------------------------------------------------------------
def _lists(acct: dict) -> list[dict]:
    return _paged(acct, f"{gtasks()}/users/@me/lists", "items", limit=100, size_param="maxResults")


def sync_tasks(acct: dict) -> dict:
    from .work_graph import _upsert

    n = 0
    for lst in _lists(acct):
        for t in _paged(acct, f"{gtasks()}/lists/{quote(lst['id'], safe='')}/tasks", "items",
                        {"showCompleted": "true", "showHidden": "true"}, limit=1000, size_param="maxResults"):
            if t.get("deleted"):
                continue
            _upsert("gtasks", t["id"], t.get("title") or "(untitled)", "done" if t.get("status") == "completed" else "todo",
                    (t.get("due") or "")[:10] or None, {"list": lst["id"], "list_name": lst.get("title", "")})
            n += 1
    return {"gtasks": n}


def _due(due: str) -> str:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(due or "")):
        raise HTTPException(400, "Give the date as YYYY-MM-DD.")
    return f"{due}T00:00:00.000Z"  # Google Tasks keeps the date only


def task_update(acct: dict, task="", done: bool | None = None, due: str = "", title: str = "") -> dict:
    from .work_graph import _upsert

    if not str(task or "").strip():  # a new task in the person's first list
        if not str(title or "").strip():
            raise HTTPException(400, "Give the new task a title.")
        lists = _lists(acct)
        if not lists:
            raise HTTPException(404, "There is no Google Tasks list to add it to.")
        lst = lists[0]
        body: dict = {"title": str(title).strip()}
        if due:
            body["due"] = _due(due)
        t = call(acct, "POST", f"{gtasks()}/lists/{quote(lst['id'], safe='')}/tasks", json=body).json()
        tid = _upsert("gtasks", t.get("id") or uuid.uuid4().hex, body["title"], "todo", due or None,
                      {"list": lst["id"], "list_name": lst.get("title", "")})
        return {"added": True, "task": tid, "title": body["title"], "where": "Google Tasks"}
    row = db.one("SELECT * FROM tasks WHERE id = ?", int(str(task).lstrip("#")))
    if not row:
        raise HTTPException(404, "There is no such task.")
    if row["origin"] != "gtasks":
        raise HTTPException(400, "That task is not in Google Tasks. A task kept only in Rooks changes with update_task.")
    m = json.loads(row["remote_meta"] or "{}")
    body = {}
    if done is not None:
        body.update({"status": "completed"} if done else {"status": "needsAction", "completed": None})
    if due:
        body["due"] = _due(due)
    if title:
        body["title"] = str(title)
    if not body:
        raise HTTPException(400, "Say what to change: done, due or title.")
    call(acct, "PATCH", f"{gtasks()}/lists/{quote(m.get('list', ''), safe='')}/tasks/{quote(row['remote_id'], safe='')}", json=body)
    status = ("done" if done else "todo") if done is not None else row["status"]
    now = db.now()
    db.run("UPDATE tasks SET status = ?, due = COALESCE(?, due), title = COALESCE(?, title), updated_at = ?, "
           "completed_at = CASE WHEN ? = 'done' THEN COALESCE(completed_at, ?) ELSE NULL END WHERE id = ?",
           status, due or None, title or None, now, status, now, row["id"])
    return {"changed": True, "task": row["id"], "where": "Google Tasks", "title": title or row["title"], "status": status}
