"""Permission rules by tool and pattern, and folder trust for a project's own rules.

Rules come from two places:
  your settings   rooks.toml   [permissions] allow = ["bash(pytest *)"]  deny = ["bash(rm *)"]
  the project     .rooks/settings.json   {"permissions": {"allow": [...], "deny": [...]}}

Shapes: bash(PATTERN) for commands (run_command, start_background), edit(PATH-GLOB) for file changes (edit_file,
write_file), mcp(SERVER/TOOL) for an extra tool. A bare `bash`, `edit` or `mcp` means every one of them; Claude Code's
`Bash(...)`, `Edit(...)`, `Write(...)` and `mcp__server__tool` are read too.

- Deny wins over allow, and applies in every mode: asks first, auto-accept (--yes, /auto), a trusted folder, dry run.
- A command is split the way the shell splits it (; && || | & newlines, $(...), backticks, subshells). An allow rule
  matches only when every part matches an allow rule and nothing else can run or write: no command inside the command,
  no redirect to a file, no VAR=value in front. When in doubt, Rooks asks.
- A deny rule matches any part, also behind sudo, env, nohup and the like, a full path (/bin/rm), quotes or
  backslashes (r\\m), and inside bash -c '...'. A command too hard to read (the program name comes from a variable,
  eval, xargs, find -exec, ...) is asked about even in auto-accept while any command deny rule exists.
- A change to Rooks' own rule files (.rooks/settings.json, .rooks/hooks, the user's config folder), by a file tool or a
  command naming them, is asked about in every mode and never matched by an allow rule.
- A project's own allow rules apply only after the person trusts the folder: a one-time question, kept in the user's
  config folder (rooks-trust.json) by the folder's real path. Its deny rules always apply.

A rule matches the command line. A program or script that a command starts can still do anything, so deny rules are a
guard, not a sandbox (sandbox = "project" is the one that keeps writes inside the folder).
"""

from __future__ import annotations

import fnmatch
import functools
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

TOOLS = {"bash": "bash", "shell": "bash", "edit": "edit", "write": "edit", "mcp": "mcp"}
BASH_TOOLS = ("run_command", "start_background")
EDIT_TOOLS = ("edit_file", "write_file")

# Programs that run the rest of their words as another command: a deny rule looks behind them.
WRAPPERS = {"sudo", "doas", "env", "nohup", "time", "nice", "ionice", "timeout", "command", "builtin", "exec", "stdbuf",
            "setsid", "chrt", "taskset", "unbuffer", "caffeinate", "watch", "chroot", "flock", "strace", "ltrace"}
SHELLS = {"sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "mksh", "busybox"}
# Programs that run a command Rooks cannot read from the command line.
OPAQUE = {"eval", "source", ".", "xargs", "parallel", "trap", "alias", "function", "coproc"}
RESERVED = {"if", "then", "else", "elif", "fi", "do", "done", "while", "until", "for", "in", "case", "esac", "select",
            "!", "{", "}", "[[", "]]"}
# A command naming one of Rooks' own rule files is asked about in every mode: the agent cannot grant itself a rule.
PROTECTED_MARKS = (".rooks/settings", ".rooks/hooks", "rooks-trust", "rooks-keys", "rooks.toml")
OWN_SETTINGS = "it touches Rooks' own permission settings"
SAFE_TARGETS = {"/dev/null", "/dev/stdout", "/dev/stderr"}
OPS = sorted(["&&", "||", ";;", "|&", "&>>", "&>", ">>", "<<<", "<<", ">|", "<>", ">&", "<&", ";", "&", "|", "<", ">",
              "(", ")"], key=len, reverse=True)
SEPARATORS = {"&&", "||", ";;", "|&", ";", "&", "|", "(", ")"}
REDIRECTS = {"&>>", "&>", ">>", "<<<", "<<", ">|", "<>", ">&", "<&", "<", ">"}


# --- reading a command ---------------------------------------------------------------------------------------------
@dataclass
class Word:
    text: str = ""
    dynamic: bool = False  # $NAME or ${...}: its value is not on the command line
    glob: bool = False     # an unquoted * ? [ or a leading ~: the shell rewrites it
    glued: bool = False    # ended right where an operator began (2>&1: the 2 is a file number)


@dataclass
class Segment:
    words: list[Word] = field(default_factory=list)
    writes: bool = False   # a redirect to or from a file
    assigns: bool = False  # VAR=value in front of the program


@dataclass
class Parsed:
    segments: list[Segment]
    unclear: str = ""      # why the command cannot be read for sure ('' when it can)


_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\+?=")


def _tokens(cmd: str) -> tuple[list, str]:
    toks: list = []
    unclear = ""
    cur: list[str] = []
    w = Word()
    started = False

    def end(glued: bool = False) -> None:
        nonlocal cur, w, started
        if started:
            w.text, w.glued = "".join(cur), glued
            toks.append(w)
        cur, w, started = [], Word(), False

    i, n = 0, len(cmd)
    while i < n:
        c = cmd[i]
        if c in " \t":
            end()
            i += 1
        elif c in "\r\n":
            end()
            toks.append(";")
            i += 1
        elif c == "#" and not started:
            while i < n and cmd[i] not in "\r\n":
                i += 1
        elif c == "\\":
            if i + 1 < n and cmd[i + 1] == "\n":
                i += 2
                continue
            if i + 1 < n:
                cur.append(cmd[i + 1])
            started = True
            i += 2
        elif c == "'":
            j = cmd.find("'", i + 1)
            if j < 0:
                unclear = unclear or "a quote is never closed"
                j = n
            cur.append(cmd[i + 1:j])
            started = True
            i = j + 1
        elif c == '"':
            started = True
            i += 1
            while i < n and cmd[i] != '"':
                d = cmd[i]
                if d == "\\" and i + 1 < n and cmd[i + 1] in '$`"\\\n':
                    cur.append(cmd[i + 1])
                    i += 2
                    continue
                if d == "`" or cmd.startswith("$(", i):
                    unclear = unclear or "it runs a command inside the command"
                    end()
                    toks.append(";")
                    started = True
                    i += 1 if d == "`" else 2
                    continue
                if d == "$" and i + 1 < n and (cmd[i + 1].isalnum() or cmd[i + 1] in "_{@*#?$!-"):
                    w.dynamic = True
                cur.append(d)
                i += 1
            if i >= n:
                unclear = unclear or "a quote is never closed"
            i += 1
        elif c == "`" or cmd.startswith("$(", i) or cmd.startswith("<(", i) or cmd.startswith(">(", i):
            unclear = unclear or "it runs a command inside the command"
            end()
            toks.append(";")
            i += 1 if c == "`" else 2
        elif c == "$" and i + 1 < n and (cmd[i + 1].isalnum() or cmd[i + 1] in "_{@*#?$!-"):
            w.dynamic = True
            cur.append(c)
            started = True
            i += 1
        else:
            op = next((o for o in OPS if cmd.startswith(o, i)), None)
            if op:
                end(glued=True)
                toks.append(op)
                i += len(op)
                continue
            if c in "*?[" or (c == "~" and not started):
                w.glob = True
            cur.append(c)
            started = True
            i += 1
    end()
    return toks, unclear


def parse(cmd: str) -> Parsed:
    """Split a shell command into the simple commands it runs, as the shell would; say when that cannot be done for sure."""
    toks, unclear = _tokens(cmd)
    segs: list[Segment] = [Segment()]
    k = 0
    while k < len(toks):
        t = toks[k]
        if isinstance(t, Word):
            seg = segs[-1]
            if not seg.words and _ASSIGN.match(t.text) and not t.glued:
                seg.assigns = True
            else:
                seg.words.append(t)
            k += 1
            continue
        if t in ("(", ")"):
            unclear = unclear or "it uses a subshell"
        if t in SEPARATORS:
            segs.append(Segment())
            k += 1
            continue
        # a redirect: [n]> target
        seg = segs[-1]
        if seg.words and seg.words[-1].glued and seg.words[-1].text.isdigit() and not seg.words[-1].dynamic:
            seg.words.pop()  # 2>: the 2 is a file number, not an argument
        target = toks[k + 1] if k + 1 < len(toks) and isinstance(toks[k + 1], Word) else None
        if t in ("<<", "<<<"):
            unclear = unclear or "it feeds text into a command"
        if target is None:
            unclear = unclear or "a redirect has no target"
        elif t in (">&", "<&") and (target.text.isdigit() or target.text == "-"):
            pass  # 2>&1: one output joined to another
        elif t in (">", ">>", ">|", "&>", "&>>") and target.text in SAFE_TARGETS and not target.dynamic:
            pass
        else:
            seg.writes = True
        k += 2 if target is not None else 1
    segments = [s for s in segs if s.words or s.assigns]
    for s in segments:
        if not s.words:
            continue
        first = s.words[0]
        name = os.path.basename(first.text)
        if first.dynamic or first.glob or not first.text:
            unclear = unclear or "the program's name is not written out"
        elif first.text in RESERVED:
            unclear = unclear or "it uses the shell's own if, for or while"
        elif name in OPAQUE:
            unclear = unclear or f"{name} runs a command Rooks cannot read"
        elif name == "find" and any(x.text in ("-exec", "-execdir", "-ok", "-okdir") for x in s.words):
            unclear = unclear or "find runs a command for each file"
        elif name in SHELLS and len(s.words) == 1:
            unclear = unclear or "a shell reads its commands from the input"
    return Parsed(segments, unclear)


def _line(words: list[str]) -> str:
    return " ".join(words)


def _deny_forms(words: list[str], depth: int = 0) -> list[list[str]]:
    """Every reading of one simple command a deny rule must see: as written, its program's plain name, behind a
    wrapper (sudo rm), past the shell's own words (then rm), and inside bash -c '...'."""
    while words and (words[0] in RESERVED or _ASSIGN.match(words[0])):
        words = words[1:]
    if not words:
        return []
    forms = [words]
    if "/" in words[0]:
        forms.append([os.path.basename(words[0]), *words[1:]])
    name = os.path.basename(words[0])
    if name in WRAPPERS or name in ("xargs", "parallel"):
        for i in range(1, len(words)):
            forms.extend(_deny_forms(words[i:], depth + 1))
    elif name == "find":
        for i, a in enumerate(words[:-1]):
            if a in ("-exec", "-execdir", "-ok", "-okdir"):
                forms.extend(_deny_forms(words[i + 1:], depth + 1))
    out = list(forms)
    if depth < 4:
        for f in forms:
            if os.path.basename(f[0]) in SHELLS:
                for i, a in enumerate(f[1:-1], 1):
                    if re.fullmatch(r"-[a-zA-Z]*c[a-zA-Z]*", a):
                        for seg in parse(f[i + 1]).segments:
                            out.extend(_deny_forms([x.text for x in seg.words], depth + 1))
                        break
    return out


def _flat(cmd: str) -> str:
    """A rough reading for a command that cannot be read for sure: quotes dropped, anything that runs a command inside
    split out, so a deny rule still sees `rm` in `echo "$(rm -rf x)"`. Used only to refuse, never to allow."""
    s = cmd.replace("$(", ";").replace("`", ";").replace("<(", ";").replace(">(", ";")
    return s.replace('"', " ").replace("'", " ").replace("(", ";").replace(")", ";").replace("{", ";").replace("}", ";")


# --- rules ---------------------------------------------------------------------------------------------------------
@dataclass
class Rule:
    tool: str          # bash | edit | mcp
    pattern: str       # '' or '*' = every one
    text: str          # as written
    kind: str          # allow | deny
    source: str        # you | project

    def matches_command_line(self, line: str) -> bool:
        return _bash_regex(self.pattern).fullmatch(line) is not None

    def matches_path(self, path: Path, root: Path) -> bool:
        pat = self.pattern.strip() or "**"
        try:
            rel = path.relative_to(root).as_posix()
        except ValueError:
            rel = None
        if pat.startswith("~"):
            pat = os.path.expanduser(pat)
        if pat.startswith("/"):
            return _glob_regex(pat.lstrip("/")).fullmatch(path.as_posix().lstrip("/")) is not None
        if rel is None:
            return False
        if "/" not in pat.rstrip("/"):
            pat = "**/" + pat
        return _glob_regex(pat).fullmatch(rel) is not None

    def matches_mcp(self, server: str, tool: str) -> bool:
        pat = self.pattern.strip() or "*"
        srv, _, tl = pat.partition("/")
        return fnmatch.fnmatchcase(server, srv) and fnmatch.fnmatchcase(tool, tl or "*")


@functools.lru_cache(maxsize=512)
def _bash_regex(pattern: str) -> re.Pattern:
    pat = " ".join(pattern.split())
    if pat in ("", "*"):
        return re.compile(r".*", re.S)
    tail = pat.endswith(" *") and not pat.endswith("\\ *")
    if tail:
        pat = pat[:-2]
    out, i = [], 0
    while i < len(pat):
        c = pat[i]
        if c == "\\" and i + 1 < len(pat):
            out.append(re.escape(pat[i + 1]))
            i += 2
            continue
        out.append(".*" if c == "*" else re.escape(c))
        i += 1
    return re.compile("".join(out) + (r"(?: .*)?" if tail else ""), re.S)


@functools.lru_cache(maxsize=512)
def _glob_regex(pat: str) -> re.Pattern:
    if pat.endswith("/"):
        pat += "**"
    out, i = [], 0
    while i < len(pat):
        if pat.startswith("**/", i):
            out.append(r"(?:.*/)?")
            i += 3
        elif pat.startswith("**", i):
            out.append(r".*")
            i += 2
        elif pat[i] == "*":
            out.append(r"[^/]*")
            i += 1
        elif pat[i] == "?":
            out.append(r"[^/]")
            i += 1
        else:
            out.append(re.escape(pat[i]))
            i += 1
    return re.compile("".join(out), re.S)


def parse_rule(text, kind: str, source: str) -> Rule | None:
    if not isinstance(text, str):
        return None
    t = text.strip()
    m = re.fullmatch(r"mcp__([A-Za-z0-9_-]+?)(?:__(.+))?", t)
    if m:
        return Rule("mcp", f"{m.group(1)}/{m.group(2) or '*'}", t, kind, source)
    m = re.fullmatch(r"([A-Za-z]+)(?:\((.*)\))?", t, re.S)
    if not m or m.group(1).lower() not in TOOLS:
        return None
    return Rule(TOOLS[m.group(1).lower()], (m.group(2) or "").strip(), t, kind, source)


def escape(line: str) -> str:
    """A command line written as a rule that matches exactly it (a star in it stays a star)."""
    return line.replace("\\", "\\\\").replace("*", "\\*")


# --- where rules and trust live ------------------------------------------------------------------------------------
def project_file(root: Path) -> Path:
    return Path(root) / ".rooks" / "settings.json"


def trust_file() -> Path:
    from .config import config_path

    return config_path().parent / "rooks-trust.json"


def _key(root: Path) -> str:
    return os.path.realpath(root)


def _trust_store() -> dict:
    try:
        d = json.loads(trust_file().read_text(encoding="utf-8"))
        return d if isinstance(d, dict) and isinstance(d.get("folders"), dict) else {"folders": {}}
    except (OSError, ValueError):
        return {"folders": {}}


def folder_trust(root: Path) -> bool | None:
    """True when the person said they trust this folder's own rules, False when they said no, None when never asked."""
    v = _trust_store()["folders"].get(_key(root))
    return v if isinstance(v, bool) else None


def _write_json(p: Path, data: dict) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(p)


def set_folder_trust(root: Path, trusted: bool) -> None:
    store = _trust_store()
    store["folders"][_key(root)] = bool(trusted)
    _write_json(trust_file(), store)


def read_project(root: Path) -> tuple[list, list, str]:
    """(allow, deny, problem) from the project's .rooks/settings.json."""
    f = project_file(root)
    if not f.is_file():
        return [], [], ""
    try:
        d = json.loads(f.read_text(encoding="utf-8"))
        perms = d.get("permissions") or {}
        allow, deny = perms.get("allow") or [], perms.get("deny") or []
        if not isinstance(allow, list) or not isinstance(deny, list):
            raise ValueError("allow and deny must be lists")
        return allow, deny, ""
    except (OSError, ValueError, AttributeError) as e:
        return [], [], f"This folder's rules file (.rooks/settings.json) could not be read ({str(e)[:80]}), so none of its rules apply."


def add_project_allow(root: Path, rules: list[str]) -> None:
    f = project_file(root)
    data: dict = {}
    if f.is_file():
        data = json.loads(f.read_text(encoding="utf-8"))  # an unreadable file is never overwritten
        if not isinstance(data, dict):
            raise ValueError("the rules file is not a JSON object")
    perms = data.setdefault("permissions", {})
    allow = perms.setdefault("allow", [])
    for r in rules:
        if r not in allow:
            allow.append(r)
    _write_json(f, data)


# --- decisions -----------------------------------------------------------------------------------------------------
@dataclass
class Decision:
    verdict: str            # deny | allow | unclear | ask
    rule: Rule | None = None
    why: str = ""


class Permissions:
    def __init__(self, user_allow, user_deny, root: Path):
        self.root = Path(os.path.realpath(root))
        self.user_allow, self.user_deny = list(user_allow or []), list(user_deny or [])
        self.reload()

    @classmethod
    def from_settings(cls, settings, root: Path) -> "Permissions":
        return cls(getattr(settings, "allow_rules", []), getattr(settings, "deny_rules", []), root)

    def reload(self) -> None:
        self.trust = folder_trust(self.root)
        p_allow, p_deny, self.problem = read_project(self.root)
        self.bad: list[str] = []
        self.rules: list[Rule] = []
        for texts, kind, source in ((self.user_deny, "deny", "you"), (p_deny, "deny", "project"),
                                    (self.user_allow, "allow", "you"), (p_allow, "allow", "project")):
            for t in texts:
                r = parse_rule(t, kind, source)
                if r is None:
                    self.bad.append(str(t))
                else:
                    self.rules.append(r)

    # which rules count
    def project_allows(self) -> list[Rule]:
        return [r for r in self.rules if r.kind == "allow" and r.source == "project"]

    def _active(self, kind: str, tool: str) -> list[Rule]:
        return [r for r in self.rules if r.kind == kind and r.tool == tool
                and (kind == "deny" or r.source == "you" or self.trust is True)]

    def notices(self) -> list[str]:
        out = []
        if self.problem:
            out.append(self.problem)
        if self.project_allows() and self.trust is not True:
            n = len(self.project_allows())
            out.append(f"This folder has {n} rule{'s' if n != 1 else ''} of its own that would let things run without asking. "
                       f"{'They are' if n != 1 else 'It is'} ignored: you have not said you trust this folder. "
                       "/permissions shows them; /permissions trust turns them on.")
        if self.bad:
            out.append(f"{len(self.bad)} permission rule{'s' if len(self.bad) != 1 else ''} not understood, so not used: "
                       + ", ".join(repr(b[:40]) for b in self.bad[:3]) + ". /permissions shows the shapes.")
        return out

    # commands
    def check_command(self, cmd: str) -> Decision:
        parsed = parse(cmd)
        denies = self._active("deny", "bash")
        if denies:
            lines = [_line(f) for seg in parsed.segments for f in _deny_forms([w.text for w in seg.words])]
            if parsed.unclear:
                lines += [_line(f) for seg in parse(_flat(cmd)).segments for f in _deny_forms([w.text for w in seg.words])]
            for line in lines:
                for r in denies:
                    if r.matches_command_line(line):
                        return Decision("deny", r)
        if any(m in cmd for m in PROTECTED_MARKS):
            return Decision("unclear", None, OWN_SETTINGS)
        if denies and parsed.unclear:
            return Decision("unclear", None, f"it is hard to read ({parsed.unclear}), and your rules never allow some commands")
        if parsed.unclear or not parsed.segments:
            return Decision("ask", None, parsed.unclear)
        allows = self._active("allow", "bash")
        used = None
        for seg in parsed.segments:
            if seg.writes or seg.assigns or not seg.words:
                return Decision("ask")
            line = _line([w.text for w in seg.words])
            hit = next((r for r in allows if r.matches_command_line(line)), None)
            if hit is None:
                return Decision("ask")
            used = used or hit
        return Decision("allow", used)

    def exact_rules(self, cmd: str) -> list[str]:
        """The precise allow rules "always allow this command here" writes, or [] when the command cannot be pinned down."""
        parsed = parse(cmd)
        if parsed.unclear or not parsed.segments or any(s.writes or s.assigns or not s.words for s in parsed.segments):
            return []
        out = []
        for s in parsed.segments:
            r = f"bash({escape(_line([w.text for w in s.words]))})"
            if r not in out:
                out.append(r)
        return out

    def can_remember_here(self, cmd: str) -> bool:
        """Offer "always allow this command in this folder": the folder is trusted, or nobody was asked yet and it has no
        allow rules of its own that trusting it would switch on; and the command can be pinned down exactly."""
        if self.problem or self.trust is False or (self.trust is None and self.project_allows()):
            return False
        return bool(self.exact_rules(cmd)) and self.check_command(cmd).verdict == "ask"

    def remember_here(self, cmd: str) -> str:
        rules = self.exact_rules(cmd)
        if not rules:
            return ""
        newly = self.trust is not True
        add_project_allow(self.root, rules)
        if newly:
            set_folder_trust(self.root, True)
        self.reload()
        said = "this command" if len(rules) == 1 else f"each of its {len(rules)} parts"
        return (f"From now on {said} runs without asking in this folder (kept in .rooks/settings.json)."
                + (" You now trust this folder, so its own rules apply; /permissions untrust undoes that." if newly else ""))

    # files and extra tools
    def check_path(self, path: Path) -> Decision:
        p = Path(os.path.realpath(path))
        for r in self._active("deny", "edit"):
            if r.matches_path(p, self.root) or r.matches_path(Path(os.path.abspath(path)), self.root):
                return Decision("deny", r)
        if self.protected(p):
            return Decision("unclear", None, OWN_SETTINGS)
        for r in self._active("allow", "edit"):
            if r.matches_path(p, self.root):
                try:
                    p.relative_to(self.root)
                except ValueError:
                    return Decision("ask")  # never outside the folder by an allow rule
                return Decision("allow", r)
        return Decision("ask")

    def protected(self, p: Path) -> bool:
        """Rooks' own rule files: the folder's .rooks/settings.json and hooks, and the user's config folder (rooks.toml,
        rooks-trust.json, rooks-keys.json). The agent never changes them unasked, so it cannot grant itself a rule or trust."""
        from .config import config_path, keys_path

        mine = [Path(os.path.realpath(x)) for x in (project_file(self.root), self.root / ".rooks" / "hooks", config_path(),
                                                    trust_file(), keys_path())]
        return any(p == m or m in p.parents for m in mine)

    def check_mcp(self, server: str, tool: str) -> Decision:
        for r in self._active("deny", "mcp"):
            if r.matches_mcp(server, tool):
                return Decision("deny", r)
        for r in self._active("allow", "mcp"):
            if r.matches_mcp(server, tool):
                return Decision("allow", r)
        return Decision("ask")

    def check_call(self, name: str, arguments: dict, plan, mcp: tuple[str, str] | None = None) -> Decision:
        if plan.effect == "read":
            return Decision("ask")
        if mcp:
            return self.check_mcp(*mcp)
        if name in BASH_TOOLS and isinstance(arguments.get("command"), str):
            return self.check_command(arguments["command"])
        if name in EDIT_TOOLS and plan.path is not None:
            return self.check_path(plan.path)
        return Decision("ask")

    # plain words
    def describe(self) -> list[str]:
        lines = []
        groups = (("Never allowed, in every mode (auto-accept too):", "deny"), ("Run without asking:", "allow"))
        for title, kind in groups:
            rules = [r for r in self.rules if r.kind == kind]
            lines.append(title)
            if not rules:
                lines.append("  (none)")
            for r in rules:
                where = "your settings" if r.source == "you" else "this folder"
                off = r.source == "project" and kind == "allow" and self.trust is not True
                lines.append(f"  · {plain(r)}  (from {where}{', ignored: you have not said you trust this folder' if off else ''})")
        if self.bad:
            lines.append("These rules were not understood, so not used:")
            lines += [f"  · {b}" for b in self.bad]
        state = {True: "you trust it, so its own rules apply",
                 False: "you said you do not trust it, so only its never-allowed rules apply",
                 None: "you have not said whether you trust it, so only its never-allowed rules apply"}[self.trust]
        lines.append(f"This folder: {state}.")
        if self.problem:
            lines.append(self.problem)
        return lines


def plain(r: Rule) -> str:
    """One rule in plain words."""
    pat = r.pattern.strip()
    if r.tool == "bash":
        if pat in ("", "*"):
            return "run any command"
        if pat.endswith(" *") and "*" not in pat[:-2].replace("\\*", ""):
            return f'run "{pat[:-2].replace(chr(92) + "*", "*")}" with anything after it'
        if "*" not in pat.replace("\\*", ""):
            return f'run exactly "{pat.replace(chr(92) + "*", "*")}"'
        return f'run commands like "{pat}" (a star stands for anything)'
    if r.tool == "edit":
        if pat in ("", "*", "**"):
            return "change any file in this folder"
        if pat.endswith("/**") and "*" not in pat[:-3]:
            return f"change files in {pat[:-3]}"
        return f"change files like {pat}"
    srv, _, tool = (pat or "*").partition("/")
    if tool in ("", "*"):
        return "use any tool of the extra tool server " + ("of any name" if srv == "*" else f'"{srv}"')
    return f'use the tool "{tool}" of "{srv}"'


SHAPES = ('Shapes: bash(pytest *) a command and anything after it, bash(npm test) exactly that command, edit(src/**) '
          'changes to files under src, mcp(notes/search) one extra tool. In rooks.toml under [permissions] (allow = [...], '
          'deny = [...]), or in this folder\'s .rooks/settings.json.')


def ask_trust(root: Path, ask=input, say=print) -> bool | None:
    """The one-time question for a folder whose own rules would let things run without asking, or that brings skills
    and commands of its own (skills.py). Returns the stored answer (asking only when there is none), or None when the
    folder has nothing of its own that trust would turn on."""
    from .skills import Library

    p = Permissions([], [], root)
    if p.trust is not None:
        return p.trust
    allows = p.project_allows()
    lib = Library(root)
    own = [i for i in lib.all("skills") + lib.all("commands") if i.project]
    if not allows and not own:
        return None
    if allows:
        say(f"  This folder ({p.root.name}) has rules of its own that let Rooks do these without asking you:")
        for r in allows[:12]:
            say(f"    · {plain(r)}")
        if len(allows) > 12:
            say(f"    · and {len(allows) - 12} more")
    if own:
        say(f"  {'It also has' if allows else f'This folder ({p.root.name}) has'} skills and commands of its own, "
            "which Rooks would follow:")
        for i in own[:12]:
            say(f"    · {'skill ' + i.name if i.kind == 'skill' else '/' + i.name}: {i.description}")
        if len(own) > 12:
            say(f"    · and {len(own) - 12} more")
    say("  Only say yes for a folder you know: a folder copied from someone else could grant itself anything.")
    for _ in range(3):
        try:
            a = ask("  Do you trust this folder? [y] Yes  [n] No  › ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            say("")
            return None
        if a in ("y", "yes"):
            set_folder_trust(root, True)
            say("  Trusted. Its rules, skills and commands apply from now on; /permissions untrust undoes it.")
            return True
        if a in ("n", "no"):
            set_folder_trust(root, False)
            say("  Not trusted. Its rules that let things run, its skills and its commands are not used; its "
                "never-allowed rules still apply.")
            return False
        say("  Type y or n, then Enter.")
    return None
