"""Skills and custom commands kept in files, which work with the app off.

Skills: a folder with a SKILL.md (front matter with a name and a description, then the steps) in
  this folder   .rooks/skills/NAME/SKILL.md   .claude/skills/NAME/SKILL.md
  yours         ~/.rooks/skills/NAME/SKILL.md ~/.claude/skills/NAME/SKILL.md
Only each skill's name and description go into the prompt. Its steps reach the model only when it loads the skill
(the load_skill tool, the same one the app's saved skills use), so a long skill costs nothing until it is needed.

Custom commands: a Markdown file whose text is the request, in
  this folder   .rooks/commands/NAME.md       .claude/commands/NAME.md
  yours         ~/.rooks/commands/NAME.md     ~/.claude/commands/NAME.md
/NAME words... sends the file's text (front matter left out) with $ARGUMENTS replaced by the words, and $1, $2 ... by
each word. A built-in command always wins over a custom one of the same name. A command file never grants anything:
front matter such as allowed-tools is not honoured, and every step it leads to is asked about as usual.

A folder's own skills and commands are text a stranger could have written (a cloned repository), so they are listed
but not used until the person trusts the folder: the same trust that turns on the folder's own permission rules
(permissions.py, /permissions trust). The person's own skills and commands are always used.

Where names clash: this folder's before yours, and .rooks before .claude.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

from . import permissions

KINDS = ("skills", "commands")
FOLDERS = (".rooks", ".claude")
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
MAX_FILE = 200_000      # bytes read from one SKILL.md or command file
MAX_ITEMS = 200         # skills or commands read from one folder
MAX_DESCRIPTION = 300   # characters of a description in the prompt and the lists
MAX_BODY = 40_000       # characters of a skill's steps handed to the model


@dataclass
class Item:
    kind: str           # skill | command
    name: str
    description: str
    path: Path          # the SKILL.md or the command file
    project: bool       # from this folder (needs trust) or the person's own
    folder: str         # ".rooks/skills", "~/.claude/commands", ... for the lists

    @property
    def where(self) -> str:
        return ("from this folder" if self.project else "yours") + f" ({self.folder})"

    def text(self) -> str:
        """The file's body, front matter left out."""
        return split_front_matter(_read(self.path))[1].strip()


def _read(p: Path) -> str:
    try:
        with open(p, "rb") as f:
            return f.read(MAX_FILE).decode("utf-8", errors="replace")
    except OSError:
        return ""


def split_front_matter(text: str) -> tuple[dict, str]:
    """({key: value}, body) for a file that starts with --- front matter ---. Simple `key: value` lines; a value can go
    on over indented lines, or start with | or > on the next lines. Anything not understood is left out."""
    text = text.lstrip("﻿")
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text
    end = next((i for i in range(1, len(lines)) if lines[i].strip() in ("---", "...")), None)
    if end is None:
        return {}, text
    meta: dict[str, str] = {}
    key = ""
    for line in lines[1:end]:
        m = re.match(r"^([A-Za-z][\w-]*)\s*:\s*(.*)$", line)
        if m and not line[:1].isspace():
            key, value = m.group(1).lower(), m.group(2).strip()
            meta[key] = "" if value in ("|", ">", "|-", ">-") else _unquote(value)
        elif key and line.strip():
            meta[key] = (meta[key] + " " + line.strip()).strip()
    return meta, "\n".join(lines[end + 1:])


def _unquote(v: str) -> str:
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
        return v[1:-1]
    return v


_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def _short(text: str, limit: int = MAX_DESCRIPTION) -> str:
    """One line, no control characters (a description is printed to the terminal: no escape codes from a file)."""
    one = " ".join(_CONTROL.sub(" ", str(text or "")).split())
    return one if len(one) <= limit else one[: limit - 3].rstrip() + "..."


def _first_line(body: str) -> str:
    for line in body.splitlines():
        line = line.strip().lstrip("#").strip()
        if line:
            return line
    return ""


def user_home() -> Path:
    return Path(os.path.expanduser("~"))


def _places(root: Path, kind: str) -> list[tuple[Path, bool, str]]:
    """(folder, project?, label) to look in, in the order a name is taken."""
    home = user_home()
    out = [(Path(root) / f / kind, True, f"{f}/{kind}") for f in FOLDERS]
    out += [(home / f / kind, False, f"~/{f}/{kind}") for f in FOLDERS]
    return out


def _inside(p: Path, root: Path) -> bool:
    """A folder's own file really is in the folder: a link to a file elsewhere (a key, a config) is never read."""
    try:
        real, top = Path(os.path.realpath(p)), Path(os.path.realpath(root))
    except OSError:
        return False
    return real == top or top in real.parents


def _scan(root: Path, kind: str) -> list[Item]:
    found: list[Item] = []
    for base, project, label in _places(root, kind):
        try:
            entries = sorted(base.iterdir())[:MAX_ITEMS] if base.is_dir() else []
        except OSError:
            continue
        for e in entries:
            if kind == "skills":
                f = e / "SKILL.md"
                if not e.is_dir() or not f.is_file() or (project and not _inside(f, root)):
                    continue
                meta, body = split_front_matter(_read(f))
                name = str(meta.get("name") or e.name).strip().lower()
                desc = meta.get("description") or _first_line(body)
                found.append(Item("skill", name, _short(desc), f, project, label))
            else:
                if e.suffix.lower() != ".md" or not e.is_file() or (project and not _inside(e, root)):
                    continue
                meta, body = split_front_matter(_read(e))
                found.append(Item("command", e.stem.lower(), _short(meta.get("description") or _first_line(body)), e,
                                  project, label))
    return [i for i in found if NAME_RE.match(i.name)]


class Library:
    """This folder's and the person's own skills and commands. Read fresh on each use, so a file added during a
    session, or trusting the folder, counts from the next request on."""

    def __init__(self, root: Path):
        self.root = Path(os.path.realpath(root))

    # trust ---------------------------------------------------------------------------------------------------------
    def trusted(self) -> bool:
        return permissions.folder_trust(self.root) is True

    def usable(self, item: Item) -> bool:
        return not item.project or self.trusted()

    # what there is ---------------------------------------------------------------------------------------------------
    def all(self, kind: str) -> list[Item]:
        """Every skill or command found, in the order a name is taken (duplicates kept, for /skills)."""
        return _scan(self.root, kind)

    def active(self, kind: str) -> dict[str, Item]:
        """name -> the one in use: usable, and first in order (this folder before yours, .rooks before .claude)."""
        out: dict[str, Item] = {}
        for i in self.all(kind):
            if self.usable(i) and i.name not in out:
                out[i.name] = i
        return out

    def skills(self) -> list[Item]:
        return list(self.active("skills").values())

    def held_back(self) -> tuple[int, int]:
        """(skills, commands) of this folder not used because the folder is not trusted."""
        if self.trusted():
            return 0, 0
        return (sum(1 for i in self.all("skills") if i.project), sum(1 for i in self.all("commands") if i.project))

    def notice(self) -> str:
        """The plain note for the start of a session, or '' when nothing is held back."""
        n_skills, n_commands = self.held_back()
        if not (n_skills or n_commands):
            return ""
        parts = [f"{n} {word}{'s' if n != 1 else ''}" for n, word in ((n_skills, "skill"), (n_commands, "command")) if n]
        one = n_skills + n_commands == 1
        return (f"This folder has {' and '.join(parts)} of its own. {'It is' if one else 'They are'} not used: you have "
                f"not said you trust this folder. /skills shows {'it' if one else 'them'}; /permissions trust turns "
                f"{'it' if one else 'them'} on.")

    # skills ----------------------------------------------------------------------------------------------------------
    def find_skill(self, name: str) -> Item | None:
        return self.active("skills").get(str(name or "").strip().lower())

    def held_skill(self, name: str) -> Item | None:
        """A skill of this folder by that name that is not used because the folder is not trusted."""
        want = str(name or "").strip().lower()
        if self.trusted():
            return None
        return next((i for i in self.all("skills") if i.project and i.name == want), None)

    def load(self, item: Item) -> str:
        body = item.text()
        if len(body) > MAX_BODY:
            body = body[:MAX_BODY] + "\n[... the rest of this skill was left out: it is too long ...]"
        return (f"Skill {item.name} ({item.where}): {item.description}\n"
                f"Files that come with it are in {item.path.parent}.\n\n{body}")

    # commands --------------------------------------------------------------------------------------------------------
    def command(self, name: str) -> tuple[Item | None, Item | None]:
        """(the command in use, or None; a command of this folder held back because it is not trusted, or None)."""
        want = str(name or "").strip().lower().lstrip("/")
        item = self.active("commands").get(want)
        held = None
        if item is None and not self.trusted():
            held = next((i for i in self.all("commands") if i.project and i.name == want), None)
        return item, held


def skills_block(local: list[Item], app: list[dict]) -> str:
    """The one list of skills for the system prompt: names and descriptions only. A skill of this folder or yours hides
    an app skill of the same name."""
    lines, seen = [], set()
    for i in local:
        lines.append(f"- {i.name}: {i.description}")
        seen.add(i.name)
    for s in app:
        name = str(s.get("name") or "")
        if name and name.lower() not in seen:
            lines.append(f"- {name}: {_short(s.get('description', ''))}")
            seen.add(name.lower())
    if not lines:
        return ""
    return "Your saved skills (call load_skill with the name before doing that kind of task):\n" + "\n".join(lines)


def expand(item: Item, arguments: str) -> str:
    """The request a custom command sends: its text with $ARGUMENTS (all the words) and $1, $2 ... (each word) filled
    in. When the text names no argument and some were given, they are added at the end."""
    text = item.text()
    args = (arguments or "").strip()
    words = args.split()
    used = re.search(r"\$(ARGUMENTS|[1-9])", text) is not None

    def fill(m: re.Match) -> str:  # one pass, so a "$1" typed in the words is never filled in again
        if m.group(1) == "ARGUMENTS":
            return args
        n = int(m.group(1))
        return words[n - 1] if n <= len(words) else ""
    text = re.sub(r"\$(ARGUMENTS|[1-9])", fill, text)
    if args and not used:
        text = f"{text}\n\nARGUMENTS: {args}"
    return text.strip()


def held_command_note(name: str) -> str:
    return (f"/{name} is a command of this folder. It is not used: you have not said you trust this folder. "
            "/permissions trust turns this folder's own skills, commands and rules on.")


def held_skill_note(name: str) -> str:
    return (f"Error: the skill {name} belongs to this folder, which the person has not said they trust, so it is not "
            "used. They can turn it on with /permissions trust.")


def one_shot(root: Path, prompt: str, built_in=()) -> tuple[str, str]:
    """A task given on the command line (rooks "/x words", rooks -p, sdk.run) that names a custom command: (the request
    to send, '') or ('', why it is not run). Anything else, a built-in name included, comes back unchanged."""
    m = re.match(r"^/([a-z0-9][a-z0-9._-]{0,63})(?:\s+(.*))?$", (prompt or "").strip(), re.S | re.I)
    if not m or "/" + m.group(1).lower() in built_in:
        return prompt, ""
    item, held = Library(root).command(m.group(1))
    if item is not None:
        return expand(item, m.group(2) or ""), ""
    if held is not None:
        return "", held_command_note(m.group(1).lower())
    return prompt, ""


__all__ = ["Item", "Library", "expand", "held_command_note", "held_skill_note", "one_shot", "skills_block", "split_front_matter"]
