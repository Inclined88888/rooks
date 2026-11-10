"""The assistant's work tools (design 0012, section 2.4). The same names serve Microsoft 365 and Google Workspace: the
work account decides which one answers (work_suite.calls). assistant.py adds these to its registry with one line.

Reads (search, list, read, chats) never wait. Every call that sends, shares or changes something outside is
effect "external" with a confirm reason, so it always waits in Needs you and runs the stored arguments on a yes.
Content from files, chats and transcripts is untrusted (third parties wrote it), and so are the names in a listing of
files, folders, sites, chats and spaces (whoever shares a file or starts a chat names it), so a conversation that read it holds
every later change, and a work write after it waits with the untrusted reason (assistant.hold_reason).
Each tool checks its switch when it runs (work_suite.require), not only when it is offered.
"""

from __future__ import annotations

import asyncio

from . import work_suite

# tools whose own function checks the switch: an approved call still reaches it after the switch was turned off, so the
# answer is "Changing files is off" instead of "unknown tool"
GATED = {"work_search", "work_files", "work_file_read", "work_file_save", "work_file_open", "work_file_upload", "work_file_share",
         "work_file_edit", "work_chats", "work_chat_read", "work_chat_post", "work_transcript", "work_task_update"}


async def _run(fid: str, fn: str, *a, **kw):
    """Check the switch, then call the work account's own suite (work_graph or work_google) off the event loop."""
    acct = work_suite.require(fid)
    return await asyncio.to_thread(getattr(work_suite.calls(acct), fn), acct, *a, **kw)


def _n(key: str) -> str:
    """The work account's word for a place: OneDrive or Google Drive, Teams or Google Chat."""
    return work_suite.names()[key]


async def _search(query: str, kind: str = "files", limit: int = 20):
    kind = (kind or "files").lower()
    if kind == "all":
        out: dict = {}
        if work_suite.on("files_read"):
            out.update(await _run("files_read", "search", query, "files", limit))
        if work_suite.on("chats_read"):
            out.update(await _run("chats_read", "search", query, "chats", limit))
        if not out:
            work_suite.require("files_read")
        return out
    return await _run("chats_read" if kind == "chats" else "files_read", "search", query, kind, limit)


async def _files(folder: str = "", site: str = "", shared_with_me: bool = False, limit: int = 50):
    out = await _run("files_read", "listing", folder, site, bool(shared_with_me), limit)
    if not (folder or site or shared_with_me):
        out["sites"] = await _run("files_read", "sites")
    return out


async def _open(file: str, ctx=None):
    out = await _run("files_read", "open_address", file)
    from . import room

    if not out.get("address"):
        return {"ok": False, "message": f"{_n('company')} did not give an address for that file."}
    if not room.enabled():
        return {"ok": False, "name": out["name"], "address": out["address"],
                "message": "The Room's browser is not available here. The person can open it in their own browser."}
    from .assistant import _use_room

    from .room_browser import signed_in_as_person

    res = await _use_room(action="browse", address=out["address"], ctx=ctx)
    note = f"{_n('company')} may ask the person to sign in once in the Room's browser."
    if signed_in_as_person():  # Edge on a work PC: Windows signs it in as the person, outside the work switches
        note = ("On this work PC the Room's browser may already be signed in as the person through Windows, so it acts as "
                "them there; anything it sends waits for their yes.")
    return {"name": out["name"], "room": res, "note": note}


def build(Tool, S, I, B) -> list:  # noqa: N803 - the registry's own constructors
    def on(fid: str, ctx=None) -> bool:
        """Offered when the switch is on, and never to a turn started with the shared bridge key (rooks_link.run_turn):
        the helpers and coding jobs hold that key, and the work account reaches the company's files and chats. Nor to a
        team lead's sub-agents, which a turn (any turn, that one included) can start as background jobs."""
        if getattr(ctx, "shared_key", False) or getattr(ctx, "channel", "") == "subagent":
            return False
        return work_suite.on(fid)

    files_on = lambda ctx: on("files_read", ctx)  # noqa: E731
    change_on = lambda ctx: on("files_change", ctx)  # noqa: E731
    return [
        Tool("work_search", "Search the person's work files (OneDrive and SharePoint, or Google Drive with shared drives; kind "
             "files) or their work chats (Teams or Google Chat; kind chats, or all). Each file comes with its reference for "
             "work_file_read, work_file_save and work_file_open.",
             {"query": S(), "kind": S("files, chats or all; default files"), "limit": I("default 20")},
             lambda query, kind="files", limit=20: _search(query, kind, limit), ("query",), untrusted=True,
             when=lambda ctx: on("files_read", ctx) or on("chats_read", ctx)),
        Tool("work_files", "List work files: the person's OneDrive or My Drive (no arguments, plus the SharePoint sites they "
             "follow or their shared drives), a folder (its reference), one site's library or shared drive (site id) or files "
             "shared with them.",
             {"folder": S("a folder's reference from an earlier listing"), "site": S("a SharePoint site or shared drive id from the sites list"),
              "shared_with_me": B(), "limit": I("default 50")},
             lambda folder="", site="", shared_with_me=False, limit=50: _files(folder, site, shared_with_me, limit),
             untrusted=True, when=files_on),  # file, folder and site names are written by whoever shares them
        Tool("work_file_read", "Read a work file in place (Word, Excel, PDF, PowerPoint, Google Docs, Sheets and Slides, text...) "
             "with passages and their location for citing. part pages long files; query jumps to relevant passages.",
             {"file": S("the file's reference from work_files or work_search"), "part": I(), "query": S()},
             lambda file, part=1, query="": _run("files_read", "read", file, part, query), ("file",), untrusted=True,
             when=files_on),
        Tool("work_file_save", "Save a copy of a work file into the person's Files, keeping where it came from.",
             {"file": S("the file's reference")}, lambda file: _run("files_read", "save", file), ("file",),
             effect="write", when=files_on),
        Tool("work_file_open", "Open a work file in the Room's own browser, where the person can see and edit it (they may sign "
             "in once there).", {"file": S("the file's reference")}, _open, ("file",), effect="external", untrusted=True,
             when=files_on),
        Tool("work_file_upload", "Upload a file from the person's Files to OneDrive or Google Drive (a folder's reference, or the "
             "top of their drive). Always waits for the person's yes.",
             {"file_id": S("the file's id in Files"), "folder": S("a folder's reference; empty for the top of their drive"),
              "replace": B("replace a file with the same name instead of adding a copy")},
             lambda file_id, folder="", replace=False: _run("files_change", "upload", file_id, folder, bool(replace)),
             ("file_id",), effect="external", when=change_on,
             confirm=lambda a: f"Uploading to {_n('upload_to')} always needs your yes."),
        Tool("work_file_share", "Share a work file: with people by email (access view or edit), or with no people a link people "
             "in the company can open. Always waits for the person's yes.",
             {"file": S("the file's reference"), "people": S("email addresses, comma separated; empty for a company link"),
              "access": S("view or edit")},
             lambda file, people="", access="view": _run("files_change", "share", file, people, access), ("file",),
             effect="external", when=change_on, confirm=lambda a: "Sharing a file always needs your yes."),
        Tool("work_file_edit", "Change a work file. Excel or Google Sheets: changes is a list of {sheet, range like B2:C3, values "
             "as rows}. Word: changes is {text}, saved as a new version (the old one is kept). Google Docs: {replace: [{find, "
             "with}]}, {append: text} or {text} for the whole document. Always waits for the person's yes, with the change shown.",
             {"file": S("the file's reference"),
              "changes": S('Sheets: JSON list like [{"sheet": "Sheet1", "range": "B2", "values": [[5]]}]. Word: JSON {"text": "..."}. '
                           'Google Docs: JSON {"replace": [{"find": "old", "with": "new"}]} or {"append": "..."}')},
             lambda file, changes: _run("files_change", "edit", file, changes), ("file", "changes"),
             effect="external", when=change_on, confirm=lambda a: "Changing a work file always needs your yes."),
        Tool("work_chats", "List the person's work chats: Teams chats and the channels of their teams, or Google Chat direct "
             "messages, group chats and spaces (kind chats, channels or all; spaces count as channels).",
             {"kind": S("chats, channels or all")}, lambda kind="all": _run("chats_read", "chats", kind or "all"),
             untrusted=True, when=lambda ctx: on("chats_read", ctx)),  # chat, channel and space names: other people's words
        Tool("work_chat_read", "Read the latest messages of a work chat, channel or space (its reference from work_chats).",
             {"chat": S("the chat's reference from work_chats"), "since": S("optional ISO time"), "limit": I("default 20")},
             lambda chat, since="", limit=20: _run("chats_read", "chat_read", chat, since, limit), ("chat",),
             untrusted=True, when=lambda ctx: on("chats_read", ctx)),
        Tool("work_chat_post", "Post a message in a work chat, channel or space as the person (reply_to answers a message in "
             "its thread). Always waits for the person's yes, with the exact text shown.",
             {"chat": S("the chat's reference from work_chats"), "text": S(), "reply_to": S("a message id from work_chat_read")},
             lambda chat, text, reply_to="": _run("chats_post", "chat_post", chat, text, reply_to), ("chat", "text"),
             effect="external", when=lambda ctx: on("chats_post", ctx), confirm=lambda a: f"Posting in {_n('chats')} always needs your yes."),
        Tool("work_transcript", "Bring the transcript of a Teams meeting or Google Meet call into Meetings (notes, decisions and "
             "action items come after). event is a meeting from the calendar; meeting is its Teams or Meet link.",
             {"event": S("a calendar event id"), "meeting": S("the Teams or Meet link")},
             lambda event="", meeting="": _run("transcripts", "transcript", event, meeting), effect="write",
             untrusted=True, when=lambda ctx: on("transcripts", ctx)),
        Tool("work_task_update", "Change a Planner, To Do or Google Tasks task (task id from list_tasks: done, due YYYY-MM-DD, "
             "title), or with no task add one to the person's To Do or Google Tasks. Always waits for the person's yes.",
             {"task": S("a task id from list_tasks"), "done": B(), "due": S("YYYY-MM-DD"), "title": S()},
             lambda task="", done=None, due="", title="": _run("tasks", "task_update", task, done, due, title),
             effect="external", when=lambda ctx: on("tasks", ctx),
             confirm=lambda a: f"Changing a task in {_n('tasks')} always needs your yes."),
    ]
