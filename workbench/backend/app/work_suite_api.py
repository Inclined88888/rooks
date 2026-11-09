"""/api/work: the Work apps page and the terminal's /work (design 0012, section 3). The signed in person, or the rooks
terminal with its own Terminal access token, which a person creates; never a shared bridge key, not even to read,
since the browser and desk helpers and coding jobs hold that key and the work account reaches the company's files.

Reads answer at once. Nothing here sends, shares or changes anything outside: /hold only puts a write in Needs you,
where it runs on the person's yes (assistant.decide), exactly once.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import connect, work_graph, work_suite, work_scopes
from .security import require_user_or_terminal_token

router = APIRouter(prefix="/api/work", dependencies=[Depends(require_user_or_terminal_token)])


class SwitchIn(BaseModel):
    on: bool


class FileIn(BaseModel):
    file: str = Field(..., min_length=3, max_length=600)


class HoldIn(BaseModel):
    tool: str = Field(..., max_length=60)
    args: dict


class TranscriptIn(BaseModel):
    event: str | int = ""
    meeting: str = Field("", max_length=2000)


@router.get("/status")
def status():
    return work_suite.status()


@router.post("/connect/{provider}")
async def connect_work(provider: str):
    """The first work sign-in: who you are, nothing else (each switch asks for its own permissions later)."""
    return await connect.start(provider, work=True)


@router.delete("/account")
def disconnect():
    row = work_suite.account()
    if not row:
        raise HTTPException(404, "No work account is connected.")
    return connect.disconnect(row["id"])


@router.post("/features/{fid}")
async def switch(fid: str, data: SwitchIn):
    out = work_suite.set_feature(fid, data.on)
    if out.get("sign_in"):
        row = work_suite.account()
        started = await connect.start(row["provider"], login_hint=row["email"], work=True, feature=fid)
        out.update(url=started["url"], attempt=started["state"], opened=started["opened"])
    return out


@router.get("/features/{fid}/it-note")
def it_note(fid: str):
    return {"note": work_suite.it_note(fid), "label": work_scopes.BY_ID.get(fid, {}).get("label", "")}


@router.get("/files")
def files(query: str = "", folder: str = "", site: str = "", shared: bool = False, limit: int = 100):
    acct = work_suite.require("files_read")
    if query.strip():
        return work_graph.search(acct, query, "files", min(limit, 50))
    return work_graph.listing(acct, folder, site, shared, limit)


@router.get("/sites")
def sites():
    return {"sites": work_graph.sites(work_suite.require("files_read"))}


@router.get("/files/read")
def read(file: str, part: int = 1, query: str = ""):
    return work_graph.read(work_suite.require("files_read"), file, part, query)


@router.post("/files/save")
def save(data: FileIn):
    return work_graph.save(work_suite.require("files_read"), data.file)


@router.get("/files/open")
def open_file(file: str):
    return work_graph.open_address(work_suite.require("files_read"), file)


@router.get("/chats")
def chats(kind: str = "all"):
    return work_graph.chats(work_suite.require("chats_read"), kind if kind in ("chats", "channels", "all") else "all")


@router.get("/chats/read")
def chat_read(chat: str, limit: int = 20):
    return work_graph.chat_read(work_suite.require("chats_read"), chat, "", limit)


@router.post("/hold")
def hold(data: HoldIn):
    """A write from the terminal (/work post): it waits in Needs you, like the assistant's."""
    return work_suite.hold(data.tool, data.args)


@router.post("/tasks/sync")
def tasks_sync():
    return work_graph.sync_tasks(work_suite.require("tasks"))


@router.get("/meetings")
def meetings_list():
    acct = work_suite.require("transcripts")
    if work_suite.state(acct, "calendar") != "on":
        return {"meetings": [], "words": "Turn Calendar on in Work apps to see your Teams meetings here."}
    return {"meetings": work_graph.meetings_list(acct)}


@router.post("/transcript")
def transcript(data: TranscriptIn):
    return work_graph.transcript(work_suite.require("transcripts"), data.event, data.meeting)
