"""The terminal's words, shared by the interactive terminal (tui.py) and the plain line mode (cli.repl): every command
with what it does, every key, and a tool call said the way the app says it (the app's plainStep.ts).
"""

from __future__ import annotations

import json

# command -> (what it does, in plain words). Order is the order shown in the menu and in /help.
COMMANDS: dict[str, str] = {
    "/help": "every command and key",
    "/new": "start a fresh conversation",
    "/model": "pick the AI, the model and how hard it thinks (arrow keys)",
    "/effort": "how hard the model thinks: /effort low, medium, high or auto",
    "/mode": "chat talks, plan reads, build can change files: /mode chat",
    "/room": "Rooks' own computer: /room, start, stop, open COMMAND, files, points, shell (all under The Room)",
    "/needs": "what waits for your OK in the app: /needs, /needs approve 1, /needs deny 1",
    "/team": "coworkers for your line of work: /team, /team set up construction, /team create construction",
    "/jobs": "jobs running here and in the app; /jobs stop ID stops one started here",
    "/memory": "what Rooks remembers about you; /memory forget <words> drops one",
    "/history": "search past chats from the app and the terminal: /history words",
    "/skills": "skills and your own commands, and where each comes from; /skills add GITHUB-LINK checks a new one",
    "/mcp": "connect an extra tool in plain words: /mcp add notes npx notes-server",
    "/provider": "switch the AI service: /provider NAME",
    "/login": "connect an AI service (paste a key, or use the Rooks app)",
    "/undo": "put back the files changed by the last request",
    "/diff": "what changed in this folder since the last commit",
    "/init": "write AGENTS.md: the project's rules and commands, so every session starts informed",
    "/context": "how full the conversation is, and which project instruction files are followed",
    "/sessions": "earlier conversations in this folder",
    "/resume": "continue an earlier conversation: /resume ID",
    "/copy": "copy the last answer to the clipboard",
    "/image": "ask about a picture: /image PATH [question] (or mention @shot.png in a request)",
    "/compact": "summarise the conversation so far to make room",
    "/cost": "tokens used and cost so far",
    "/permissions": "rules for what runs without asking and what never runs; /permissions trust for this folder's own",
    "/race": "several candidates try one task on their own copies; tests score them; you pick: /race \"task\", show N, pick N, drop",
    "/auto": "turn asking before changes off or on",
    "/dry-run": "show what would change without changing anything",
    "/doctor": "check that everything works and say what to fix",
    "/receipt": "where this session's record is saved",
    "/exit": "quit (or Ctrl+D)",
}
ALIASES = {"/clear": "/new", "/yes": "/auto", "/quit": "/exit", "/?": "/help", "/needs-you": "/needs"}

GROUPS = {
    "Conversation": ["/help", "/new", "/undo", "/diff", "/compact", "/copy", "/image", "/exit"],
    "The Room, Needs you, Jobs": ["/room", "/needs", "/jobs", "/team"],
    "Memory": ["/memory", "/history", "/skills", "/init", "/context", "/sessions", "/resume"],
    "Model": ["/model", "/effort", "/mode", "/provider", "/login", "/mcp"],
    "Checks": ["/permissions", "/race", "/auto", "/dry-run", "/doctor", "/cost", "/receipt"],
}

# /room's verbs, listed in /help under "The Room" (design record 0006 section 7.1). The words match the Room page.
ROOM = "The Room"
ROOM_VERBS = [
    ("/room", "On or Off, its terminals, and what it is"),
    ("/room start", "start the Room"),
    ("/room stop", "stop it; everything in it is kept"),
    ("/room run COMMAND", "a quick command, two minutes at most"),
    ("/room open COMMAND", "run something long in the Room's terminal \"Rooks\", no time limit"),
    ("/room tail [NAME]", "a terminal's last lines, and whether it is still running"),
    ("/room send NAME TEXT", "type a line into a Room terminal"),
    ("/room close NAME", "close a Room terminal (asks first)"),
    ("/room files [FOLDER]", "what is in the Room's folder, on or off"),
    ("/room points", "the saved points, newest first"),
    ("/room save LABEL", "Save a point: copy the Room's files as they are now"),
    ("/room back N", "Start over from a saved point (asks first)"),
    ("/room handoff FILE PLACE", "Hand off a file: it waits for your OK in Needs you"),
    ("/room shell", "a shell inside the Room, right here; exit comes back"),
]

# What "a" at the question approves for the rest of the session (agent.approval_key): never a whole kind of action.
ALWAYS_SCOPES = {"command": "this exact command", "file": "changes to this file", "tool": "this tool",
                 "step": "this exact step"}


def always_choice(plan) -> str:
    """The "a" choice, saying what it covers ("Approve this exact command for this session"); '' when there is none
    (a server's own question is answered once, never for the session)."""
    scope = ALWAYS_SCOPES.get(getattr(plan, "scope", "") or "")
    return f"Approve {scope} for this session" if scope else ""


HERE = "Always allow this command in this folder"


def here_choice(plan) -> str:
    """The "h" choice: a rule kept in the folder's .rooks/settings.json, offered only where it can apply (agent.py)."""
    return HERE if getattr(plan, "here", False) else ""


KEYS = [("/","commands, with what each does"), ("@", "add a file or folder to your request"),
        ("Shift+Tab", "switch approvals: asks first, auto-accept, dry run"), ("Esc Enter", "new line (paste keeps lines too)"),
        ("Up Down", "earlier requests"), ("Ctrl+R", "search earlier requests"), ("Ctrl+C", "stop the current task"),
        ("Ctrl+D", "quit"), ("?", "this help")]
NOTE = "Anything that is not a command is a request. A command also works without its slash, like: model"


def groups() -> dict[str, list[str]]:
    """The /help groups; a command added later is never hidden from /help."""
    out = {k: [c for c in v if c in COMMANDS] for k, v in GROUPS.items()}
    listed = {c for cmds in out.values() for c in cmds}
    other = [c for c in COMMANDS if c not in listed]
    if other:
        out["Other"] = other
    return out


def sections() -> list[tuple[str, list[tuple[str, str]]]]:
    """/help's sections as (name, [(what to type, what it does)]): the command groups, with The Room's verbs right
    after the group that holds /room."""
    out = []
    for name, cmds in groups().items():
        out.append((name, [(c, COMMANDS[c]) for c in cmds]))
        if "/room" in cmds:
            out.append((ROOM, list(ROOM_VERBS)))
    return out


def help_text() -> str:
    """/help as plain lines: every command, The Room's verbs and every key."""
    lines = []
    for name, rows in sections():
        width = max(10, *(len(k) for k, _ in rows)) if rows else 10
        lines.append(name)
        lines += [f"  {k:<{width}} {v}" for k, v in rows]
        lines.append("")
    lines.append("Keys")
    lines += [f"  {k:<10} {v}" for k, v in KEYS]
    lines += ["", NOTE]
    return "\n".join(lines)


# --- a model error, in plain words ---------------------------------------------------------------------------------
DOCTOR_HINT = "/doctor (or rooks doctor) shows the details."


def model_error(e) -> str:
    """What the screen says when the model could not answer: what happened and what to do, in plain words. Never the
    address, the raw reply or a stack trace: those stay in the session's record and in /doctor."""
    status = getattr(e, "status", None)
    text = str(e)
    if status in (401, 403):
        said = "The AI service did not accept the key. Check it with /login, then try again."
    elif status == 429:
        said = "The AI service says it has had too many requests. Wait a minute, then try again."
    elif status in (500, 502, 503, 504, 529):
        said = "The AI service is busy or down right now. Try again in a minute."
    elif status == 404:
        said = "The AI service does not know this model. Pick another with /model."
    elif status is None and text.startswith("cannot reach"):
        said = "Could not reach the AI service. Check that it is running and that this computer is online."
    elif status is None and text.startswith("unexpected reply"):
        said = "The AI service sent a reply Rooks could not read."
    elif text.startswith("No AI model is set up yet"):  # config.NO_MODEL_HELP: written for people already
        return text
    else:
        said = "The AI service could not answer this request."
    return f"{said} {DOCTOR_HINT}"


# --- a step, said the way the app says it (workbench/frontend/src/plainStep.ts) --------------------------------------
def _field(args, key: str) -> str:
    if isinstance(args, str):
        try:
            args = json.loads(args or "{}")
        except ValueError:
            return ""
    v = args.get(key) if isinstance(args, dict) else None
    return " ".join(v.split()) if isinstance(v, str) else ""


def _clip(text: str, n: int = 72) -> str:
    t = text.strip()
    return t[: n - 1] + "…" if len(t) > n else t


def _with(verb: str, subject: str, sep: str = ": ") -> str:
    return f"{verb}{sep}{_clip(subject)}" if subject else verb


_ROOM = {
    "status": lambda a: "Checking the Room",
    "up": lambda a: _with("Starting the Room", _field(a, "goal")),
    "down": lambda a: "Stopping the Room",
    "run": lambda a: _with("Running in the Room", _field(a, "command")),
    "checkpoint": lambda a: _with("Saving a point in the Room", _field(a, "label")),
    "reset": lambda a: f"Starting the Room over from {_clip(_field(a, 'name'))}" if _field(a, "name") else "Starting the Room over",
    "handoff": lambda a: _with("Copying a file out of the Room", _field(a, "src")),
}

_SAY = {
    # the terminal's own tools: what they touch is on this computer, so it is named
    "read_file": lambda a: _with("Reading", _field(a, "path"), " ") if _field(a, "path") else "Reading a file",
    "list_files": lambda a: _with("Looking through", _field(a, "path"), " ") if _field(a, "path") else "Looking through the folder",
    "search": lambda a: _with("Searching the files for", _field(a, "pattern"), " ") if _field(a, "pattern") else "Searching the files",
    "edit_file": lambda a: _with("Editing", _field(a, "path"), " ") if _field(a, "path") else "Editing a file",
    "write_file": lambda a: _with("Writing", _field(a, "path"), " ") if _field(a, "path") else "Writing a file",
    "run_command": lambda a: _with("Running", _field(a, "command"), " ") if _field(a, "command") else "Running something on this computer",
    "todo": lambda a: "Updating the checklist",
    "web_fetch": lambda a: "Reading a page",
    "start_background": lambda a: _with("Starting a job", _field(a, "command")),
    "check_background": lambda a: "Checking the jobs",
    "stop_background": lambda a: "Stopping a job",
    "task": lambda a: "Handing part of the work to a helper",
    "load_skill": lambda a: "Reading a saved skill",
    # the app's tools (the shared loop), in the app's words
    "web_search": lambda a: _with("Searching", _field(a, "query")),
    "read_page": lambda a: "Reading a page",
    "browse_web": lambda a: _with("Looking through a site", _field(a, "goal")),
    "search_email": lambda a: _with("Looking through mail", _field(a, "query")),
    "read_email": lambda a: "Reading a message",
    "list_mail_accounts": lambda a: "Checking the mailboxes",
    "save_email_draft": lambda a: "Writing a draft",
    "send_email": lambda a: "Preparing to send mail",
    "list_tasks": lambda a: "Checking tasks",
    "create_task": lambda a: _with("Adding a task", _field(a, "title")),
    "update_task": lambda a: "Updating a task",
    "get_agenda": lambda a: "Checking the day",
    "list_events": lambda a: "Checking the calendar",
    "create_event": lambda a: _with("Adding to the calendar", _field(a, "title")),
    "list_calendars": lambda a: "Checking the calendars",
    "find_free_time": lambda a: "Looking for a free time",
    "search_notes": lambda a: _with("Looking through notes", _field(a, "query")),
    "read_note": lambda a: "Reading a note",
    "create_note": lambda a: "Writing a note",
    "append_to_note": lambda a: "Adding to a note",
    "use_computer": lambda a: "Using this computer",
    "use_room": lambda a: _ROOM.get(_field(a, "action").lower(), lambda _a: "Using the Room")(a),
    "remember": lambda a: "Remembering that",
    "forget": lambda a: "Forgetting that",
    "search_memory": lambda a: "Looking through what it remembers",
    "search_history": lambda a: _with("Looking through past chats", _field(a, "query")),
    "schedule_task": lambda a: _with("Setting something to run later", _field(a, "name")),
    "list_schedules": lambda a: "Checking what runs later",
}


def plain_step(name: str, args=None) -> str:
    """A tool call, said the way a person would. Never the raw name or the raw arguments."""
    say = _SAY.get(name or "")
    return say(args or {}) if say else "Working"


_WANTED = {"edited": "edit", "wrote": "write", "created": "create"}


def wanted_step(summary: str) -> str:
    """A change's summary as a step not yet taken ("edited calc.py" -> "edit calc.py"), for a step that was asked about
    or denied: the receipt's past tense would read as if it had been done."""
    first, sep, rest = (summary or "").partition(" ")
    return f"{_WANTED[first]}{sep}{rest}" if first in _WANTED else summary
