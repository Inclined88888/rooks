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
    "/effort": "how hard a plan's model thinks: /effort low, medium, high or auto",
    "/mode": "chat talks, plan reads, build can change files: /mode chat",
    "/room": "Rooks' own computer: /room, /room start, /room stop, /room run COMMAND",
    "/needs": "what waits for your OK in the app: /needs, /needs approve 1, /needs deny 1",
    "/team": "coworkers for your line of work: /team, /team set up construction, /team create construction",
    "/jobs": "jobs running here and in the app; /jobs stop ID stops one started here",
    "/memory": "what Rooks remembers about you; /memory forget <words> drops one",
    "/history": "search past chats from the app and the terminal: /history words",
    "/skills": "procedures Rooks learned; /skills add GITHUB-LINK checks a new one",
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
    "Checks": ["/auto", "/dry-run", "/doctor", "/cost", "/receipt"],
}

KEYS = [("/", "commands, with what each does"), ("@", "add a file or folder to your request"),
        ("Shift+Tab", "switch mode: asks first, auto-accept, plan only"), ("Esc Enter", "new line (paste keeps lines too)"),
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


def help_text() -> str:
    """/help as plain lines: every command and every key."""
    lines = []
    for name, cmds in groups().items():
        lines.append(name)
        lines += [f"  {c:<10} {COMMANDS[c]}" for c in cmds]
        lines.append("")
    lines.append("Keys")
    lines += [f"  {k:<10} {v}" for k, v in KEYS]
    lines += ["", NOTE]
    return "\n".join(lines)


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
    "todo": lambda a: "Updating the plan",
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
