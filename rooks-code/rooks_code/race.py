"""Race (design record 0009): several candidates try one coding task, each in its own private copy of the project, each
on the model and approach you chose; a judge runs their tests; you pick the winner, and only then does the real project
change, through the normal edit path and one /undo.

    from rooks_code import race

    r = race.run("make add() handle negative numbers", cwd="path/to/project", candidates=[...], on_event=print)
    print(race.scoreboard_text(r))
    race.apply(r, 1, settings=r.settings, ui=ui)   # the pick: one approval for the whole set, undone with /undo
    race.drop(r)                                   # remove the copies

What is measured, and only that, reaches the scoreboard: tokens and cost from the receipts, time from the clock, the
diff from the copy, tests from exit codes and output. A candidate must prove its work: a test that fails on the project
as it is (run on an untouched copy, "base") and passes on its own copy. "proves nothing" marks a test that passes on
base; "does not pass its own test" one that fails on its own candidate; "no proof" a candidate whose diff adds no test.

Security (0009 section 8): a candidate's file tools are confined to its copy (Toolbox._path); its commands run in the
command sandbox with only its copy and the temp folders writable; it has no learning, no MCP servers and no link to a
chat, so it can neither save a fact nor answer a question; one spending cap and the usual permission rules cover the
whole race; the judge runs only the project's own test command, as you. Keys reach a candidate as they reach a normal
run and nowhere else; the record (race.json) is redacted like a receipt.
"""

from __future__ import annotations

import copy as _copy
import fnmatch
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from . import config, permissions, sdk, words
from .agent import Agent, Budget, project_hook
from .permissions import Permissions, folder_trust, parse_rule, read_project
from .receipts import RunLog
from .redact import redact, redact_obj
from .tools import SKIP_DIRS, Plan, Toolbox, ToolError, _clip, diff as unified_diff
from .undo import ChangeSets

DEFAULT_N = 3
DEFAULT_TIME_S = 15 * 60
TEST_TIMEOUT_S = 120
DEP_DIRS = ("node_modules", ".venv", "venv", "target")  # linked from the real project, read-only under the sandbox
TEST_PATTERNS = ("test_*.py", "*_test.py", "*.test.*", "*.spec.*")
TEST_FOLDERS = ("tests",)
BRIEFS = {
    "smallest": "Make the smallest change that does the job; touch nothing else.",
    "robust": "Handle the edge cases and follow the project's own style and conventions.",
    "fastest": "Prefer the quickest correct change; do not polish or refactor.",
}
PROOF_OK = "fails first"
PROVES_NOTHING = "proves nothing"
NOT_OWN = "does not pass its own test"
NO_PROOF = "no proof"
STATUS_WORDS = {"cost cap": "stopped: cost cap", "token cap": "stopped: token cap", "time limit": "stopped: time",
                "race was stopped": "stopped"}
_COUNTS = re.compile(r"(\d+) (passed|failed|error|errors)\b")


class RaceError(Exception):
    """Something the person must hear, in plain words: a refused pick, a copy that could not be made."""


@dataclass
class CandidateSpec:
    provider: str | None = None   # None: the session's
    model: str | None = None      # None: the provider's default (or the session's model when the provider is the session's)
    base_url: str | None = None
    brief: str = ""               # smallest | robust | fastest | free text


@dataclass
class Change:
    path: str          # relative to the copy
    kind: str          # added | changed | removed
    added: int = 0     # lines, 0 for a binary file
    removed: int = 0
    binary: bool = False


@dataclass
class TestRun:
    """One run of the project's test command: measured from its exit code and output, never from anyone's claim."""
    ok: bool | None        # None: not run
    said: str              # "48 passed", "47 passed, 1 failed", "not run: ...", "no tests ran"
    exit_code: int | None = None
    output: str = ""
    seconds: float = 0.0


@dataclass
class Score:
    proof: str = NO_PROOF
    proof_ok: bool = False
    others_passed: int = 0
    others_total: int = 0
    project: str = "not run"
    project_ok: bool | None = None
    diff_added: int = 0
    diff_removed: int = 0
    files: int = 0
    tokens: int = 0
    cost_usd: float | None = None
    seconds: float = 0.0
    full_pass: bool = False

    def to_dict(self) -> dict:
        return dict(self.__dict__)


@dataclass
class Candidate:
    n: int
    spec: CandidateSpec
    copy: Path
    label: str = ""                         # "Claude Sonnet · smallest"
    status: str = "waiting"                 # waiting | running | finished | stopped: cost cap | stopped: token cap | stopped: time | stopped | stopped: error
    result: sdk.Result | None = None
    answer: str = ""
    changed: list[Change] = field(default_factory=list)
    test_files: list[str] = field(default_factory=list)
    score: Score = field(default_factory=Score)
    judge: dict[str, str] = field(default_factory=dict)  # test outputs: proof_base, proof_self, cross:<n>, project
    events: list[dict] = field(default_factory=list)
    started: float = 0.0
    finished: float = 0.0
    deadline: float = float("inf")
    agent: Agent | None = None
    settings: config.Settings | None = None
    receipt: str = ""                       # the receipt's path once the agent is gone (a race loaded from race.json)
    thread: threading.Thread | None = None
    cancel: threading.Event = field(default_factory=threading.Event)

    @property
    def done(self) -> bool:
        return self.status not in ("waiting", "running")

    def to_dict(self) -> dict:
        return redact_obj({"n": self.n, "label": self.label, "provider": self.settings.provider if self.settings else "",
                           "model": self.settings.model if self.settings else "", "brief": self.spec.brief, "status": self.status,
                           "copy": str(self.copy), "answer": self.answer, "changed": [c.__dict__ for c in self.changed],
                           "test_files": self.test_files, "score": self.score.to_dict(), "judge": self.judge,
                           "result": self.result.to_dict() if self.result else None,
                           "receipt": str(self.agent.log.path) if self.agent else self.receipt})


# --- helpers -----------------------------------------------------------------------------------------------------------
def is_test_file(rel: str) -> bool:
    parts = rel.replace("\\", "/").split("/")
    if any(p in TEST_FOLDERS for p in parts[:-1]):
        return True
    return any(fnmatch.fnmatch(parts[-1], pat) for pat in TEST_PATTERNS)


def _git_root(root: Path) -> bool:
    """Whether root is a git working tree with at least one commit (so worktrees can be made from HEAD)."""
    if not shutil.which("git"):
        return False
    try:
        r = subprocess.run(["git", "rev-parse", "--is-inside-work-tree"], cwd=root, capture_output=True, text=True, timeout=20)
        if r.returncode != 0 or r.stdout.strip() != "true":
            return False
        top = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=root, capture_output=True, text=True, timeout=20)
        if Path(top.stdout.strip()).resolve() != root.resolve():
            return False  # a subfolder of a repository: a worktree would copy the whole repository; plain copy instead
        head = subprocess.run(["git", "rev-parse", "--verify", "HEAD"], cwd=root, capture_output=True, text=True, timeout=20)
        return head.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _git(root: Path, *args: str, input: bytes | None = None, timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=root, capture_output=True, input=input, timeout=timeout)


def _skip(name: str) -> bool:
    return name in SKIP_DIRS or name == ".rooks"


def make_copy(root: Path, dest: Path, git: bool) -> None:
    """One copy of the project as it is now: in a git repository a detached worktree of HEAD with the uncommitted
    changes applied (tracked diff, untracked files copied, ignored files left out); otherwise a plain copy without
    SKIP_DIRS. Dependency folders are linked from the real project (read-only under the sandbox)."""
    if git:
        dest.parent.mkdir(parents=True, exist_ok=True)
        r = _git(root, "worktree", "add", "--detach", "-q", str(dest), "HEAD")
        if r.returncode != 0:
            raise RaceError("could not make a copy of this folder: " + redact(r.stderr.decode("utf-8", "replace").strip()[:200]))
        patch = _git(root, "diff", "HEAD", "--binary", "--no-color").stdout
        if patch.strip():
            r = _git(dest, "apply", "--whitespace=nowarn", input=patch)
            if r.returncode != 0:
                raise RaceError("could not carry your uncommitted changes into a copy: "
                                + redact(r.stderr.decode("utf-8", "replace").strip()[:200]))
        listed = _git(root, "ls-files", "--others", "--exclude-standard", "-z").stdout.decode("utf-8", "replace")
        for rel in filter(None, listed.split("\0")):
            parts = Path(rel).parts
            if not parts or _skip(parts[0]) or any(p in (".git",) for p in parts):
                continue
            src, dst = root / rel, dest / rel
            if src.is_symlink() or not src.is_file():
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
    else:
        shutil.copytree(root, dest, symlinks=True, ignore=lambda d, names: [n for n in names if _skip(n) or n in DEP_DIRS])
    for dep in DEP_DIRS:
        src = root / dep
        if src.is_dir() and not (dest / dep).exists():
            try:
                os.symlink(src.resolve(), dest / dep, target_is_directory=True)
            except OSError:
                pass


def remove_copy(root: Path, dest: Path, git: bool) -> None:
    if git and dest.exists():
        _git(root, "worktree", "remove", "--force", str(dest))
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)


def _walk(base: Path) -> dict[str, Path]:
    out: dict[str, Path] = {}
    for dirpath, dirnames, filenames in os.walk(base):
        rel_dir = Path(dirpath).relative_to(base)
        dirnames[:] = sorted(d for d in dirnames if not _skip(d) and d != ".git" and not (Path(dirpath) / d).is_symlink())
        for f in sorted(filenames):
            p = Path(dirpath) / f
            if p.is_symlink() or not p.is_file() or (f == ".git" and str(rel_dir) == "."):  # a worktree's .git file
                continue
            out[(rel_dir / f).as_posix() if str(rel_dir) != "." else f] = p
    return out


def _text(p: Path) -> str | None:
    try:
        return p.read_bytes().decode("utf-8")
    except (UnicodeDecodeError, OSError):
        return None


def changes_between(base: Path, cand: Path) -> list[Change]:
    """Every file that differs between an untouched copy and a candidate's, with its line counts; measured, not claimed."""
    a, b = _walk(base), _walk(cand)
    out = []
    for rel in sorted(set(a) | set(b)):
        if rel in a and rel in b:
            if a[rel].read_bytes() == b[rel].read_bytes():
                continue
            kind, old, new = "changed", _text(a[rel]), _text(b[rel])
        elif rel in b:
            kind, old, new = "added", "", _text(b[rel])
        else:
            kind, old, new = "removed", _text(a[rel]), ""
        if old is None or new is None:
            out.append(Change(rel, kind, binary=True))
            continue
        d = unified_diff(old, new, rel).splitlines()
        out.append(Change(rel, kind, sum(1 for l in d if l.startswith("+") and not l.startswith("+++")),
                          sum(1 for l in d if l.startswith("-") and not l.startswith("---"))))
    return out


def test_command_for(root: Path, configured: str = "") -> str:
    """The project's own test command: test_command in rooks.toml, else detected from the project's files (lint_test.py's
    rule). Python's uses the project's own interpreter when it has one, else python3 or python on PATH."""
    if configured.strip():
        return configured.strip()
    if (root / "package.json").exists() and not ((root / "pyproject.toml").exists() or (root / "setup.py").exists()):
        return "npm test"
    if (root / "Cargo.toml").exists():
        return "cargo test"
    if (root / "go.mod").exists():
        return "go test ./..."
    for venv in (".venv", "venv", "env"):
        py = root / venv / "bin" / "python"
        if py.exists():
            return f'"{py}" -m pytest -q'
    py = shutil.which("python3") or shutil.which("python") or sys.executable
    return f'"{py}" -m pytest -q'


def _quote(path: str) -> str:
    return "'" + path.replace("'", "'\\''") + "'"


def run_tests(copy: Path, command: str, files: list[str] | None = None, timeout: int = TEST_TIMEOUT_S) -> TestRun:
    """The test command in a copy, as you, outside the sandbox: on the named test files alone, or on the whole project.
    The copy goes first on the import path, so an editable install of the real project does not get tested instead."""
    if not command:
        return TestRun(None, "not run: no test command (set test_command in rooks.toml)")
    cmd = command
    if "pytest" in cmd:
        if "--rootdir" not in cmd:
            cmd += " --rootdir=."
        if "no:cacheprovider" not in cmd:
            cmd += " -p no:cacheprovider"
    if files:
        if "pytest" not in cmd:
            return TestRun(None, "not run: only a pytest command can run one test file alone")
        cmd += " " + " ".join(_quote(f) for f in files)
    env = {**os.environ, "PYTHONPATH": str(copy) + (os.pathsep + os.environ["PYTHONPATH"] if os.environ.get("PYTHONPATH") else "")}
    t0 = time.monotonic()
    try:
        r = subprocess.run(cmd, shell=True, cwd=copy, capture_output=True, text=True, timeout=timeout, encoding="utf-8",
                           errors="replace", env=env, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return TestRun(False, f"not run: timed out after {timeout} s", seconds=time.monotonic() - t0)
    except OSError as e:
        return TestRun(None, f"not run: {redact(str(e))[:120]}", seconds=time.monotonic() - t0)
    out = (r.stdout or "") + (("\n" + r.stderr) if r.stderr else "")
    counts: dict[str, int] = {}
    for n, what in _COUNTS.findall(out):
        counts[what.rstrip("s")] = counts.get(what.rstrip("s"), 0) + int(n)
    parts = [f"{counts[k]} {k}" for k in ("passed", "failed", "error") if counts.get(k)]
    if r.returncode == 5 and "pytest" in cmd:  # pytest: nothing collected
        said, ok = "no tests ran", False
    elif parts:
        said, ok = ", ".join(parts), r.returncode == 0
    else:
        ok = r.returncode == 0
        said = "passed" if ok else f"failed (exit code {r.returncode})"
    return TestRun(ok, said, r.returncode, _clip(redact(out), 12_000), time.monotonic() - t0)


class _Placed:
    """Another candidate's test files placed onto a copy for one run, and put back exactly afterwards."""

    def __init__(self, onto: Path, source: Path, files: list[str]):
        self.onto, self.source, self.files = onto, source, files
        self.saved: dict[str, bytes | None] = {}

    def __enter__(self):
        for rel in self.files:
            dst = self.onto / rel
            self.saved[rel] = dst.read_bytes() if dst.exists() else None
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(self.source / rel, dst)
        return self

    def __exit__(self, *exc):
        for rel, content in self.saved.items():
            dst = self.onto / rel
            if content is None:
                dst.unlink(missing_ok=True)
                parent = dst.parent
                while parent != self.onto and parent.is_dir() and not any(parent.iterdir()):
                    parent.rmdir()
                    parent = parent.parent
            else:
                dst.write_bytes(content)
        return False


# --- the pieces a candidate runs with ------------------------------------------------------------------------------------
class SharedBudget(Budget):
    """A Budget whose check sums every candidate's receipts: the race spends what one session may. Each candidate's
    own limit is its share (the cap divided by N) plus what finished candidates left unused; the total never crosses.
    The same check ends a candidate at its time limit and when the race is stopped."""

    def __init__(self, race: Race, cand: Candidate):
        s = cand.settings
        super().__init__(race.max_tokens, race.max_usd, s.model, s.prices, s.local)
        self.race, self.cand = race, cand

    def _totals(self) -> list[tuple[Candidate, dict]]:
        out = []
        for c in self.race.candidates:
            if c.agent is None:
                continue
            for _ in range(5):  # another thread may be appending to its receipt right now
                try:
                    out.append((c, c.agent.log.totals()))
                    break
                except RuntimeError:
                    time.sleep(0.01)
        return out

    def check(self, totals: dict, next_input_estimate: int) -> str:
        if self.race.stopping:
            return "the race was stopped"
        if time.monotonic() > self.cand.deadline:
            return f"time limit reached: {words_time(self.race.time_limit_s)} per candidate"
        rows = self._totals()
        n = max(1, len(self.race.candidates))
        running = max(1, sum(1 for c in self.race.candidates if not c.done))
        used_tok = sum(t["tokens_in"] + t["tokens_out"] for _, t in rows)
        own_tok = totals["tokens_in"] + totals["tokens_out"]
        if self.max_tokens:
            if used_tok + next_input_estimate > self.max_tokens:
                return (f"token cap reached: {used_tok:,} used by the race, next call needs about {next_input_estimate:,}, "
                        f"cap {self.max_tokens:,}")
            share = self.max_tokens / n
            released = sum(max(0.0, share - (t["tokens_in"] + t["tokens_out"])) for c, t in rows if c.done)
            if own_tok + next_input_estimate > share + released / running:
                return (f"token cap reached: this candidate's share is {int(share + released / running):,} of the race's "
                        f"{self.max_tokens:,}; it used {own_tok:,} and the next call needs about {next_input_estimate:,}")
        if self.max_usd and self.price is not None:
            nxt = next_input_estimate * self.per_input / 1_000_000
            used_usd = sum(t["usd"] for _, t in rows)  # a candidate with an unknown price adds nothing: it is said, not guessed
            if used_usd + nxt > self.max_usd:
                return f"cost cap reached: ${used_usd:.4f} spent by the race, next call about ${nxt:.4f}, cap ${self.max_usd:.2f}"
            share = self.max_usd / n
            released = sum(max(0.0, share - t["usd"]) for c, t in rows if c.done)
            if totals["usd"] + nxt > share + released / running:
                return (f"cost cap reached: this candidate's share is ${share + released / running:.4f} of the race's "
                        f"${self.max_usd:.2f}; it spent ${totals['usd']:.4f} and the next call is about ${nxt:.4f}")
        return ""


class RaceToolbox(Toolbox):
    """The normal toolbox, confined to the candidate's copy, whose commands can be ended by the race: at the candidate's
    time limit, or when the race is stopped."""

    def __init__(self, race: Race, cand: Candidate, root: Path, command_timeout: int, sandbox: str):
        super().__init__(root, command_timeout, cancel=cand.cancel, sandbox=sandbox)
        self.race, self.cand = race, cand

    def _run_command(self, a: dict) -> Plan:
        plan = super()._run_command(a)  # arguments checked and the sandbox prepared (or refused) as for any run
        if sys.platform == "win32":
            return plan
        cmd = a["command"]
        timeout = max(1, min(3600, int(a.get("timeout") or self.command_timeout)))
        argv = self._command_argv(cmd)

        def run():
            p = subprocess.Popen(argv, cwd=self.root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                                 text=True, encoding="utf-8", errors="replace", start_new_session=True)
            ends = time.monotonic() + timeout
            while True:
                try:
                    out, err = p.communicate(timeout=0.2)
                    break
                except subprocess.TimeoutExpired:
                    stop = self.cancel.is_set() or time.monotonic() > self.cand.deadline
                    if not stop and time.monotonic() < ends:
                        continue
                    try:
                        os.killpg(p.pid, signal.SIGKILL)
                    except OSError:
                        p.kill()
                    try:
                        out, err = p.communicate(timeout=5)
                    except subprocess.TimeoutExpired:
                        out, err = "", ""
                    shown = _clip((out or "") + (err or ""))
                    if stop:
                        why = "the race was stopped" if self.race.stopping else "this candidate's time limit was reached"
                        raise ToolError(f"the command was ended: {why}\n{shown}") from None
                    raise ToolError(f"timed out after {timeout}s\n{shown}") from None
            text = (out or "") + (("\n" if out and err else "") + err if err else "")
            return f"exit code {p.returncode}\n{_clip(text)}", None, f"exit code {p.returncode}"
        plan.apply = run
        return plan


class CandidateUI(sdk.HeadlessUI):
    """What a candidate talks to: no keyboard, no screen. Its questions go through the race's one gate, which names
    the candidate and asks the person (or says no at once, headless); everything else becomes an event."""

    def __init__(self, race: Race, cand: Candidate):
        super().__init__(lambda ev: race._candidate_event(cand, ev))
        self.race, self.cand = race, cand

    def ask(self, plan) -> str:
        self._emit({"type": "approval_asked", "tool": redact(str(getattr(plan, "tool", "") or plan.effect)),
                    "effect": plan.effect if plan.effect in ("write", "command", "external") else "external",
                    "summary": redact(words.wanted_step(plan.summary)),
                    **({"preview": sdk._short(plan.preview)} if getattr(plan, "preview", "") else {})})
        return self.race._gate(self.cand, plan)


class RaceAgent(Agent):
    """A normal agent in its copy, with one difference: what "a" approves (a file, a command) is keyed by the path
    inside the copy, so one yes covers every candidate's copy of the same file."""

    def approval_key(self, name: str, arguments: dict, plan, mcp: tuple[str, str] | None = None) -> tuple[tuple, str]:  # type: ignore[override]
        key, scope = Agent.approval_key(name, arguments, plan, mcp)
        if key[0] == "file":
            try:
                key = ("file", Path(key[1]).resolve().relative_to(self.root).as_posix())
            except ValueError:
                pass
        return key, scope


def words_time(seconds: float) -> str:
    seconds = int(round(seconds))
    if seconds < 60:
        return f"{seconds} s"
    return f"{seconds // 60} m {seconds % 60:02d} s"


def _money(usd: float | None) -> str:
    if usd is None:
        return "unknown"
    return f"${usd:.2f}" if usd >= 0.01 or usd == 0 else f"${usd:.4f}"


# --- the race --------------------------------------------------------------------------------------------------------------
class Race:
    def __init__(self, task: str, root: Path, settings: config.Settings, specs: list[CandidateSpec], *, max_usd, max_tokens,
                 time_limit_s: float, test_command: str, ask: Callable | None, on_event: Callable[[dict], None] | None):
        self.task, self.root, self.settings = task, root.resolve(), settings
        self.id = time.strftime("%Y%m%dT%H%M%SZ-", time.gmtime()) + uuid.uuid4().hex[:6]
        self.dir = self.root / ".rooks" / "race" / self.id
        self.base = self.dir / "base"
        self.max_usd, self.max_tokens, self.time_limit_s = max_usd, max_tokens, time_limit_s
        self.test_command = test_command
        self.ask, self.on_event = ask, on_event or (lambda ev: None)
        self.git = False
        self.candidates: list[Candidate] = [Candidate(i + 1, spec, self.dir / f"c{i + 1}") for i, spec in enumerate(specs)]
        self.always: set[tuple] = set()  # what "a" approved for every candidate in this race
        self.notices: list[str] = []
        self.error = ""
        self.exit_code = sdk.EXIT_UNFINISHED
        self.picked: int | None = None
        self.started = 0.0
        self.finished = 0.0
        self.saved_seconds = 0.0          # a race loaded from race.json: how long it took
        self.app_job: int | None = None   # the job on the app's Jobs board that shows this race (section 7)
        self.app_pick: int | None = None  # a pick made in the app, read by the terminal, not yet applied here
        self.stopping = False
        self.judged = False
        self._pending: list[dict] = []
        self._lock = threading.Lock()
        self._gate_lock = threading.Lock()

    # setup ---------------------------------------------------------------------------------------------------------
    @classmethod
    def prepare(cls, task: str, *, cwd: str | Path | None = None, candidates: list[CandidateSpec] | None = None, n: int = DEFAULT_N,
                provider: str | None = None, model: str | None = None, base_url: str | None = None, briefs: list[str] | None = None,
                yes: bool = False, max_usd: float | None = None, max_tokens: int | None = None, time_limit: float = DEFAULT_TIME_S,
                test_command: str | None = None, settings: config.Settings | None = None, ask: Callable | None = None,
                on_event: Callable[[dict], None] | None = None) -> "Race":
        """Everything up to the start: settings, the copies, each candidate's agent. A problem comes back as
        race.error (and exit_code 2), in plain words, never as an exception."""
        root = Path(cwd or (settings.root if settings else Path.cwd())).expanduser().resolve()
        specs = list(candidates) if candidates else [
            CandidateSpec(brief=(briefs or list(BRIEFS))[i % len(briefs or list(BRIEFS))]) for i in range(max(1, n))]
        try:
            if settings is None:
                first = next((s for s in specs if s.provider), None)  # the session's provider, or the first candidate's
                settings = config.resolve({"provider": provider or (first.provider if first else None),
                                           "model": model or (first.model if first and not provider else None),
                                           "base_url": base_url or (first.base_url if first and not provider else None),
                                           "yes": yes, "max_usd": max_usd, "max_tokens": max_tokens}, root)
        except SystemExit as e:
            r = cls(task, root, config.Settings(root=root), specs, max_usd=None, max_tokens=None, time_limit_s=time_limit,
                    test_command="", ask=ask, on_event=on_event)
            r.error, r.exit_code = (str(e).removeprefix("rooks: ").splitlines()[0] if str(e) else "cannot start"), sdk.EXIT_SETUP
            return r
        cap_usd = max_usd if max_usd is not None else settings.max_usd
        cap_tok = max_tokens if max_tokens is not None else settings.max_tokens
        race = cls(task, root, settings, specs, max_usd=cap_usd or None, max_tokens=cap_tok or None, time_limit_s=time_limit,
                   test_command=test_command_for(root, test_command if test_command is not None else getattr(settings, "test_command", "")),
                   ask=ask, on_event=on_event)
        if not task.strip():
            race.error, race.exit_code = "no task given: say what the candidates should do", sdk.EXIT_SETUP
            return race
        if not root.is_dir():
            race.error, race.exit_code = f"{root} is not a folder", sdk.EXIT_SETUP
            return race
        # each candidate's settings first: a candidate that cannot start (a delegate, a missing key) is refused before any copy
        for c in race.candidates:
            try:
                c.settings = race._candidate_settings(c)
            except SystemExit as e:
                race.error, race.exit_code = str(e).removeprefix("rooks: ").splitlines()[0] if str(e) else "cannot start", sdk.EXIT_SETUP
                return race
            except RaceError as e:
                race.error, race.exit_code = str(e), sdk.EXIT_SETUP
                return race
        if settings.max_usd and any(Budget(None, 1.0, c.settings.model, c.settings.prices, c.settings.local).price is None
                                    and c.settings.provider not in ("workbench", "nvidia") for c in race.candidates):
            unknown = [c.settings.model for c in race.candidates
                       if Budget(None, 1.0, c.settings.model, c.settings.prices, c.settings.local).price is None]
            race.notices.append(f"the price of {', '.join(sorted(set(unknown)))} is unknown, so the dollar cap cannot be enforced "
                                f"for that candidate; the token cap still is")
        try:
            race._make_copies()
        except RaceError as e:
            race.error, race.exit_code = str(e), sdk.EXIT_SETUP
            race._remove_copies()
            return race
        for c in race.candidates:
            race._make_agent(c)
        return race

    def _candidate_settings(self, c: Candidate) -> config.Settings:
        base, spec = self.settings, c.spec
        if spec.provider and spec.provider != base.provider or spec.base_url:
            s = config.resolve({"provider": spec.provider or base.provider, "model": spec.model, "base_url": spec.base_url,
                                "yes": base.auto_approve}, c.copy)
            for key in ("max_usd", "max_tokens", "max_steps", "command_timeout", "trusted_folders", "nudge", "prices",
                        "allow_rules", "deny_rules", "hook_before_tool", "sandbox", "context_tokens", "test_command"):
                setattr(s, key, _copy.copy(getattr(base, key)))
        else:
            s = _copy.copy(base)  # the session's provider (and its key), with the candidate's model when one is named
            if spec.model:
                s.model = spec.model
        if s.kind == "delegate":
            raise RaceError(f"{s.provider} runs its own agent and cannot be a race candidate yet; pick a model provider")
        if s.key_env and not s.api_key and not s.key_optional:
            raise RaceError(f"{s.provider} needs a key before it can race (rooks login)")
        s.root = c.copy
        s.learn = False
        s.mcp_servers = {}
        s.stream = False
        s.dry_run = False
        s.mode = "build"
        s.lint_after_edit = False
        s.max_usd, s.max_tokens = self.max_usd, self.max_tokens
        return s

    def _make_copies(self) -> None:
        self.git = _git_root(self.root)
        rooks_dir = self.root / ".rooks"
        rooks_dir.mkdir(parents=True, exist_ok=True)
        gitignore = rooks_dir / ".gitignore"
        if not gitignore.exists():
            gitignore.write_text("*\n")  # the copies and their receipts stay out of the person's commits
        self.dir.mkdir(parents=True, exist_ok=True)
        for dest in [self.base, *(c.copy for c in self.candidates)]:
            make_copy(self.root, dest, self.git)

    def _remove_copies(self) -> None:
        for dest in [self.base, *(c.copy for c in self.candidates)]:
            remove_copy(self.root, dest, self.git)
        if self.git:
            _git(self.root, "worktree", "prune")
        shutil.rmtree(self.dir, ignore_errors=True)

    def _make_agent(self, c: Candidate) -> None:
        s = c.settings
        c.label = f"{_short_model(s)} · {c.spec.brief[:24]}" if c.spec.brief else _short_model(s)
        ui = CandidateUI(self, c)
        log = RunLog(c.copy, provider=s.provider, model=s.model)
        agent = RaceAgent(s, ui, log=log)
        agent.tools = RaceToolbox(self, c, c.copy, s.command_timeout, getattr(s, "sandbox", "project"))
        agent.budget = SharedBudget(self, c)
        agent.always = self.always
        agent.perms = self._permissions(c)
        agent.save = lambda: None  # no conversation to resume later: a race writes no chat history
        c.agent = agent
        c.result = sdk.Result(sdk.EXIT_UNFINISHED, session_id=log.session)

    def _permissions(self, c: Candidate) -> Permissions:
        """The same rules as a normal run in the real folder: yours, and the folder's own with the folder's own trust,
        matched against paths inside the copy."""
        p = Permissions.from_settings(c.settings, c.copy)
        p.trust = folder_trust(self.root)
        p_allow, p_deny, problem = read_project(self.root)
        p.problem = p.problem or problem
        for texts, kind in ((p_deny, "deny"), (p_allow, "allow")):
            for t in texts:
                r = parse_rule(t, kind, "project")
                if r is None:
                    p.bad.append(str(t))
                else:
                    p.rules.append(r)
        return p

    def prompt_for(self, c: Candidate) -> str:
        brief = BRIEFS.get(c.spec.brief.strip().lower(), c.spec.brief.strip())
        return (f"{self.task.strip()}\n\n"
                "You are one of several candidates trying this task; work only in this folder. First write a test that fails on "
                "the project as it is, in its test style and folder; then make the change that makes it pass; run the tests. "
                "Do not commit. End with a short summary of what you changed and how you checked it."
                + (f"\nApproach: {brief}" if brief else ""))

    # running -------------------------------------------------------------------------------------------------------
    def _event(self, ev: dict) -> None:
        with self._lock:
            try:
                self.on_event(ev)
            except Exception:  # noqa: BLE001 - a listener's mistake never stops the race
                pass

    def _candidate_event(self, c: Candidate, ev: dict) -> None:
        ev = {**ev, "candidate": c.n}
        c.events.append(ev)
        if not self.started:  # a candidate's start-up note (an unknown price) waits until race_start has been sent
            self._pending.append(ev)
        else:
            self._event(ev)

    def _gate(self, c: Candidate, plan) -> str:
        """One question at a time, naming its candidate. Headless (no ask): no, at once. "h" (a rule kept in the folder)
        is one yes here: a copy's .rooks is never written."""
        if self.ask is None or self.stopping:
            return "n"
        asked = _copy.copy(plan)
        asked.summary = f"Candidate {c.n} ({c.label}) wants to: {words.wanted_step(plan.summary)}"
        with self._gate_lock:
            if self.stopping:
                return "n"
            try:
                answer = self.ask(asked)
            except (EOFError, KeyboardInterrupt):
                answer = "n"
        return "y" if answer == "h" else answer

    def start(self) -> None:
        if self.error:
            return
        self.started = time.monotonic()
        self._event({"type": "race_start", "race": self.id, "task": redact(self.task), "candidates": len(self.candidates),
                     "cap_usd": self.max_usd, "cap_tokens": self.max_tokens, "time_limit_s": self.time_limit_s,
                     "copies": str(self.dir), "notices": [redact(n) for n in self.notices]})
        for ev in self._pending:
            self._event(ev)
        self._pending.clear()
        for c in self.candidates:
            c.thread = threading.Thread(target=self._work, args=(c,), name=f"race-c{c.n}", daemon=True)
            c.thread.start()

    def _work(self, c: Candidate) -> None:
        c.started = time.monotonic()
        c.deadline = c.started + self.time_limit_s
        c.status = "running"
        self._candidate_event(c, {"type": "candidate_start", "label": c.label, "provider": c.settings.provider,
                                  "model": c.settings.model, "brief": c.spec.brief, "session_id": c.agent.log.session})
        agent, ui = c.agent, c.agent.ui
        try:
            answer = agent.run(self.prompt_for(c)) or ""
            sdk.settle(c.result, agent, agent.log, ui, answer)
            c.answer = c.result.result or c.result.error
            if c.result.outcome == "budget_paused":
                c.status = next((v for k, v in STATUS_WORDS.items() if k in c.result.error), "stopped: cap")
            elif c.result.outcome in sdk.FINISHED or c.result.outcome == "unbacked":
                c.status = "finished"
            elif c.result.outcome == "model_error":
                c.status = "stopped: model error"
            elif c.result.outcome == "step_limit":
                c.status = "stopped: step limit"
            elif c.result.outcome == "loop_detected":
                c.status = "stopped: going in circles"
            else:
                c.status = "stopped"
            if self.stopping:
                c.status = "stopped"
        except Exception as e:  # noqa: BLE001 - one candidate's crash never ends the race; the receipt has what was done
            c.status, c.answer = "stopped: error", f"stopped unexpectedly ({type(e).__name__})"
            c.result.outcome, c.result.exit_code, c.result.error = "error", sdk.EXIT_UNFINISHED, c.answer
        finally:
            try:
                agent.close()
            except Exception:  # noqa: BLE001
                pass
            sdk.totals(c.result, agent.log, ui)
            c.finished = time.monotonic()
            self._candidate_event(c, {"type": "candidate_end", "status": c.status, "answer": redact(c.answer)[:2000],
                                      "tokens": c.result.tokens_in + c.result.tokens_out, "cost_usd": c.result.cost_usd,
                                      "seconds": round(c.finished - c.started, 1)})

    def stop(self) -> None:
        """End every candidate: a running command is ended now, the next model call never happens."""
        self.stopping = True
        for c in self.candidates:
            c.deadline = 0.0
            c.cancel.set()

    def wait(self, judge: bool = True) -> None:
        for c in self.candidates:
            while c.thread is not None and c.thread.is_alive():
                c.thread.join(0.2)
        if judge and not self.judged and not self.error:
            self.judge()
        self.finished = time.monotonic()
        if not self.error:
            self._finish()

    # the judge -------------------------------------------------------------------------------------------------------
    def judge(self) -> None:
        """After the last candidate ends, outside the sandbox, as you, asking no model anything: the fail-first proof,
        every candidate's tests on every other candidate, and the project's own tests on each."""
        self.judged = True
        cands = [c for c in self.candidates if c.copy.is_dir()]
        for c in cands:
            c.changed = changes_between(self.base, c.copy)
            c.test_files = [ch.path for ch in c.changed if ch.kind != "removed" and is_test_file(ch.path) and not ch.binary]
            c.score.files = len(c.changed)
            c.score.diff_added = sum(ch.added for ch in c.changed)
            c.score.diff_removed = sum(ch.removed for ch in c.changed)
            c.score.tokens = c.result.tokens_in + c.result.tokens_out if c.result else 0
            c.score.cost_usd = c.result.cost_usd if c.result else None
            c.score.seconds = max(0.0, c.finished - c.started)
        for c in cands:
            self._proof(c)
        for c in cands:
            self._cross(c, cands)
        for c in cands:
            run = run_tests(c.copy, self.test_command)
            c.judge["project"] = run.output
            c.score.project, c.score.project_ok = run.said, run.ok
            self._event({"type": "judge", "candidate": c.n, "check": "project", "passed": bool(run.ok), "detail": run.said})
        for c in cands:
            s = c.score
            s.full_pass = bool(s.proof_ok and s.others_passed == s.others_total and s.project_ok is True)
        self._event({"type": "scoreboard", "rows": [c.to_dict() for c in self.ranked()], "text": scoreboard_text(self)})

    def _proof(self, c: Candidate) -> None:
        s = c.score
        if not c.test_files:
            s.proof, s.proof_ok = NO_PROOF, False
            self._event({"type": "judge", "candidate": c.n, "check": "proof", "passed": False, "detail": NO_PROOF})
            return
        with _Placed(self.base, c.copy, c.test_files):
            on_base = run_tests(self.base, self.test_command, c.test_files)
        c.judge["proof_base"] = on_base.output
        if on_base.ok is None:
            s.proof, s.proof_ok = on_base.said, False
        elif on_base.ok:
            s.proof, s.proof_ok = PROVES_NOTHING, False
        else:
            on_self = run_tests(c.copy, self.test_command, c.test_files)
            c.judge["proof_self"] = on_self.output
            if on_self.ok is True:
                s.proof, s.proof_ok = PROOF_OK, True
            elif on_self.ok is None:
                s.proof, s.proof_ok = on_self.said, False
            else:
                s.proof, s.proof_ok = NOT_OWN, False
        self._event({"type": "judge", "candidate": c.n, "check": "proof", "passed": s.proof_ok, "detail": s.proof})

    def _cross(self, c: Candidate, cands: list[Candidate]) -> None:
        others = [o for o in cands if o is not c and o.test_files]
        passed = 0
        for o in others:
            with _Placed(c.copy, o.copy, o.test_files):
                run = run_tests(c.copy, self.test_command, o.test_files)
            c.judge[f"cross:{o.n}"] = run.output
            passed += run.ok is True
        c.score.others_passed, c.score.others_total = passed, len(others)
        self._event({"type": "judge", "candidate": c.n, "check": "cross", "passed": passed == len(others),
                     "detail": f"others' tests {passed}/{len(others)}"})

    def ranked(self) -> list[Candidate]:
        """Full passes first, then more of the others' tests passed, then the smaller diff, then the lower cost. The
        order is a convenience; the numbers are the result."""
        def key(c: Candidate):
            s = c.score
            # a real test with the wrong fix stands above no test, and a test that proves nothing stands last
            proof_rank = {PROOF_OK: 0, NOT_OWN: 1, NO_PROOF: 2, PROVES_NOTHING: 3}.get(s.proof, 2)
            return (not s.full_pass, proof_rank, -(s.others_passed), s.diff_added + s.diff_removed,
                    s.cost_usd if s.cost_usd is not None else float("inf"), c.n)
        return sorted(self.candidates, key=key)

    def _finish(self) -> None:
        if any(c.status == "finished" for c in self.candidates):
            self.exit_code = sdk.EXIT_OK
        if any(c.result and c.result.denied for c in self.candidates) or any(c.agent and c.agent.denials for c in self.candidates):
            self.exit_code = sdk.EXIT_DENIED
        self.save()
        self._event(result_of(self).to_dict("race_end"))

    @property
    def seconds(self) -> float:
        if not self.started:
            return self.saved_seconds
        end = self.finished or time.monotonic()
        return max(0.0, end - self.started)

    @property
    def alive(self) -> bool:
        """Whether any candidate is still working."""
        return any(c.thread is not None and c.thread.is_alive() for c in self.candidates)

    def to_dict(self) -> dict:
        return redact_obj({"race": self.id, "task": self.task, "folder": str(self.root), "copies": str(self.dir),
                           "cap_usd": self.max_usd, "cap_tokens": self.max_tokens, "time_limit_s": self.time_limit_s,
                           "test_command": self.test_command, "seconds": round(self.seconds, 1), "exit_code": self.exit_code,
                           "picked": self.picked, "error": self.error, "notices": self.notices, "app_job": self.app_job,
                           "candidates": [c.to_dict() for c in self.candidates], "order": [c.n for c in self.ranked()]})

    def save(self) -> Path | None:
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            p = self.dir / "race.json"
            p.write_text(json.dumps(self.to_dict(), ensure_ascii=False, indent=1), encoding="utf-8")
            return p
        except OSError:
            return None


def _short_model(s: config.Settings) -> str:
    m = (s.model or "").split("/")[-1]
    return f"{m} (local)" if s.local else (m or s.provider)


def run(task: str, **kw) -> Race:
    """The whole race, start to scoreboard, in this thread: prepare, start, wait, judge. Never raises for a bad setup or a
    failed candidate: the Race carries error (exit code 2) or each candidate's status."""
    r = Race.prepare(task, **kw)
    if r.error:
        r._event(result_of(r).to_dict("race_end"))
        return r
    r.start()
    r.wait()
    return r


def drop(r: Race) -> None:
    """Remove every copy of this race (and prune the worktrees); the real project is not touched."""
    r._remove_copies()


def drop_all(root: Path) -> int:
    """Remove every saved race under this folder's .rooks/race. Returns how many."""
    root = Path(root).resolve()
    folder = root / ".rooks" / "race"
    n = 0
    for d in sorted(folder.iterdir()) if folder.is_dir() else []:
        if d.is_dir():
            r = load(root, d.name)
            if r is not None:
                drop(r)
            else:
                shutil.rmtree(d, ignore_errors=True)
            n += 1
    if shutil.which("git") and _git_root(root):
        _git(root, "worktree", "prune")
    return n


# --- a saved race: race.json back into a Race, enough to show, pick and drop ------------------------------------------------
def saved(root: Path) -> list[Path]:
    """The race.json files under this folder, oldest first."""
    folder = Path(root).resolve() / ".rooks" / "race"
    return sorted(p for p in folder.glob("*/race.json") if p.is_file()) if folder.is_dir() else []


def load(root: Path, race_id: str | None = None, settings: config.Settings | None = None) -> "Race | None":
    """The race saved in this folder (the newest, or the one named) as a Race that can be shown, picked and dropped: its
    copies are on disk, its scores and diffs in race.json. None when there is none."""
    root = Path(root).resolve()
    files = saved(root)
    if race_id:
        files = [f for f in files if f.parent.name == race_id]
    if not files:
        return None
    try:
        data = json.loads(files[-1].read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    specs = [CandidateSpec(provider=c.get("provider") or None, model=c.get("model") or None, brief=c.get("brief") or "")
             for c in data.get("candidates") or []]
    s = settings or config.Settings(root=root)
    r = Race(str(data.get("task") or ""), root, s, specs, max_usd=data.get("cap_usd"), max_tokens=data.get("cap_tokens"),
             time_limit_s=float(data.get("time_limit_s") or DEFAULT_TIME_S), test_command=str(data.get("test_command") or ""),
             ask=None, on_event=None)
    r.id = str(data.get("race") or files[-1].parent.name)
    r.dir = files[-1].parent
    r.base = r.dir / "base"
    r.git = (r.base / ".git").is_file()
    r.saved_seconds = float(data.get("seconds") or 0)
    r.exit_code = int(data.get("exit_code") or sdk.EXIT_UNFINISHED)
    r.picked = data.get("picked")
    r.error = str(data.get("error") or "")
    r.notices = list(data.get("notices") or [])
    r.app_job = data.get("app_job")
    r.judged = True
    for c, d in zip(r.candidates, data.get("candidates") or []):
        c.copy = r.dir / f"c{c.n}"
        c.label = str(d.get("label") or "")
        c.status = str(d.get("status") or "finished")
        c.answer = str(d.get("answer") or "")
        c.changed = [Change(**{k: v for k, v in ch.items() if k in Change.__dataclass_fields__}) for ch in d.get("changed") or []]
        c.test_files = list(d.get("test_files") or [])
        c.score = Score(**{k: v for k, v in (d.get("score") or {}).items() if k in Score.__dataclass_fields__})
        c.judge = dict(d.get("judge") or {})
        c.receipt = str(d.get("receipt") or "")
        c.settings = _copy.copy(s)
        c.settings.provider, c.settings.model = str(d.get("provider") or s.provider), str(d.get("model") or "")
        res = d.get("result")
        if isinstance(res, dict):
            c.result = sdk.Result(int(res.get("exit_code", sdk.EXIT_UNFINISHED)), result=str(res.get("result") or ""),
                                  outcome=str(res.get("outcome") or "not_started"), session_id=res.get("session_id"),
                                  turns=int(res.get("turns") or 0), tokens_in=int((res.get("tokens") or {}).get("input") or 0),
                                  tokens_out=int((res.get("tokens") or {}).get("output") or 0), cost_usd=res.get("cost_usd"),
                                  denied=list(res.get("denied") or []), error=str(res.get("error") or ""),
                                  duration_ms=int(res.get("duration_ms") or 0))
    return r


def result_of(r: Race) -> "sdk.RaceResult":
    """The race as the headless result object (sdk.RaceResult): the json output and the race_end event."""
    tokens_in = sum(c.result.tokens_in for c in r.candidates if c.result)
    tokens_out = sum(c.result.tokens_out for c in r.candidates if c.result)
    costs = [c.result.cost_usd if c.result else 0.0 for c in r.candidates]
    rows = []
    for c in r.candidates:
        rows.append({"candidate": c.n, "label": c.label, "provider": c.settings.provider if c.settings else "",
                     "model": c.settings.model if c.settings else "", "brief": c.spec.brief, "status": c.status,
                     "score": c.score.to_dict(), "result": c.result.to_dict() if c.result else None,
                     "files": [ch.path for ch in c.changed]})
    return sdk.RaceResult(exit_code=r.exit_code, race=r.id, task=r.task, picked=r.picked, error=r.error,
                          seconds=round(r.seconds, 1), tokens_in=tokens_in, tokens_out=tokens_out,
                          cost_usd=None if any(x is None for x in costs) else float(sum(costs)),
                          candidates=rows, order=[c.n for c in r.ranked()] if not r.error else [])


# --- the words typed after /race and rooks race ----------------------------------------------------------------------------------
USAGE = ('/race "task" [--n 3] [--models a,b,c] [--briefs smallest,robust,fastest] [--time 15m] [--auto]  ·  '
         '/race show [N]  ·  /race pick N  ·  /race drop')
VERBS = ("show", "pick", "drop", "stop")


def parse_time(text: str) -> float:
    """"15m", "90s", "1h", "2m30s" or a plain number of seconds."""
    t = str(text or "").strip().lower()
    if not t:
        return float(DEFAULT_TIME_S)
    if t.replace(".", "", 1).isdigit():
        return float(t)
    total, num = 0.0, ""
    for ch in t:
        if ch.isdigit() or ch == ".":
            num += ch
        elif ch in "hms" and num:
            total += float(num) * {"h": 3600, "m": 60, "s": 1}[ch]
            num = ""
        else:
            raise RaceError(f"--time takes minutes or seconds, like 15m or 90s, not {text!r}")
    if num:
        raise RaceError(f"--time takes minutes or seconds, like 15m or 90s, not {text!r}")
    return total


def _known_providers() -> set[str]:
    names = set(config.PROVIDERS)
    try:
        names |= set((config.load_file().get("providers") or {}).keys())
    except Exception:  # noqa: BLE001 - a broken config file is reported when the race starts
        pass
    return names


def parse_models(text: str) -> list[tuple[str | None, str | None]]:
    """--models as /model names them: "anthropic/claude-sonnet-5-5", "ollama/qwen2.5:7b", "claude-code" (a provider on its
    own), or a bare model name on the session's provider. Each is (provider or None, model or None)."""
    out: list[tuple[str | None, str | None]] = []
    known = _known_providers()
    for item in [x.strip() for x in str(text or "").split(",") if x.strip()]:
        if item in known:
            out.append((item, None))
        elif "/" in item and item.split("/", 1)[0] in known:
            prov, model = item.split("/", 1)
            out.append((prov, model or None))
        else:
            out.append((None, item))
    return out


def specs_from(models: str = "", briefs: str = "", n: int | None = None) -> list[CandidateSpec]:
    """The candidates asked for: one per --models entry (one model means all use it; none means the session's), each with
    its brief (--briefs, cycling through smallest, robust, fastest when none are given), --n of them."""
    pairs = parse_models(models)
    names = [b.strip() for b in str(briefs or "").split(",") if b.strip()] if briefs else list(BRIEFS)
    count = max(1, int(n or (len(pairs) if len(pairs) > 1 else (len(names) if briefs else DEFAULT_N))))
    if len(pairs) > 1 and n and n != len(pairs):
        count = max(count, len(pairs))
    if not pairs:
        pairs = [(None, None)]
    return [CandidateSpec(provider=pairs[i % len(pairs)][0] if len(pairs) > 1 else pairs[0][0],
                          model=pairs[i % len(pairs)][1] if len(pairs) > 1 else pairs[0][1],
                          brief=names[i % len(names)]) for i in range(count)]


def parse_command(rest: str) -> dict:
    """The words after /race: {"verb": "run" | "show" | "pick" | "drop" | "stop" | "usage", ...} with the task and flags,
    or {"verb": "error", "error": words}."""
    import shlex

    try:
        parts = shlex.split(rest or "")
    except ValueError as e:
        return {"verb": "error", "error": f"could not read that: {e}"}
    if not parts:
        return {"verb": "usage"}
    if parts[0].lower() in VERBS:
        verb = parts[0].lower()
        n = parts[1] if len(parts) > 1 else ""
        if verb == "pick" and not n:
            return {"verb": "pick", "n": None}
        if n and not n.isdigit():
            return {"verb": "error", "error": f"/race {verb} takes a candidate number, like /race {verb} 1"}
        return {"verb": verb, "n": int(n) if n else None}
    out: dict = {"verb": "run", "n": None, "models": "", "briefs": "", "time": DEFAULT_TIME_S, "auto": False, "task": ""}
    words_: list[str] = []
    i = 0
    while i < len(parts):
        p = parts[i]
        if p in ("--n", "--models", "--briefs", "--time", "--test-command") or p.startswith(("--n=", "--models=", "--briefs=", "--time=")):
            if "=" in p:
                key, val = p[2:].split("=", 1)
            else:
                key = p[2:]
                i += 1
                if i >= len(parts):
                    return {"verb": "error", "error": f"--{key} needs a value"}
                val = parts[i]
            if key == "n":
                if not val.isdigit() or int(val) < 1:
                    return {"verb": "error", "error": "--n takes how many candidates, like --n 3"}
                out["n"] = int(val)
            elif key == "time":
                try:
                    out["time"] = parse_time(val)
                except RaceError as e:
                    return {"verb": "error", "error": str(e)}
            elif key == "test-command":
                out["test_command"] = val
            else:
                out[key] = val
        elif p == "--auto":
            out["auto"] = True
        elif p.startswith("--"):
            return {"verb": "error", "error": f"unknown option {p}. {USAGE}"}
        else:
            words_.append(p)
        i += 1
    out["task"] = " ".join(words_).strip()
    if not out["task"]:
        return {"verb": "error", "error": f"say what the candidates should do. {USAGE}"}
    return out


def start_words(r: Race) -> str:
    """What the person reads before the race starts (section 2)."""
    n = len(r.candidates)
    cap = []
    if r.max_usd:
        cap.append(f"${r.max_usd:.2f}")
    if r.max_tokens:
        cap.append(f"{r.max_tokens:,} tokens")
    first = (f"{n} candidate{'s' if n != 1 else ''} will try this task, each on its own copy of this folder. "
             "Nothing here changes until you pick one.")
    second = f" Cap for the whole race: {' and '.join(cap)}." if cap else " No spending cap is set for this race."
    return first + second + f" Up to {words_time(r.time_limit_s)} each."


# --- the scoreboard, pick and show ---------------------------------------------------------------------------------------------
SCORE_COLS = ["#", "Candidate", "Proof", "Others' tests", "Project tests", "Diff", "Files", "Tokens", "Cost", "Time", "Status"]
HOW_TO = "/race show N for a diff and its test output · /race pick N applies one · /race drop removes them all"
HOW_TO_SHELL = "rooks race show N for a diff and its test output · rooks race pick N applies one · rooks race drop removes them all"


def scoreboard_rows(r: Race) -> tuple[str, list[list[str]], list[str]]:
    """The scoreboard's parts: the heading, one row of words per candidate in rank order (SCORE_COLS), and the notes.
    Every number is measured. "unknown" where a price is unknown."""
    total_tok = sum(c.score.tokens for c in r.candidates)
    costs = [c.score.cost_usd for c in r.candidates]
    total_cost = "unknown" if any(x is None for x in costs) else _money(sum(costs))
    head = (f"Race: {redact(r.task)[:60]}    {len(r.candidates)} candidate{'s' if len(r.candidates) != 1 else ''} · "
            f"{words_time(r.seconds)} · {total_cost} · {total_tok:,} tokens")
    rows = []
    for c in r.ranked():
        s = c.score
        rows.append([str(c.n), c.label, s.proof, f"{s.others_passed}/{s.others_total}" if s.others_total else "none to run",
                     s.project, f"+{s.diff_added} -{s.diff_removed}", str(s.files), f"{s.tokens:,}", _money(s.cost_usd),
                     words_time(s.seconds), c.status])
    notes = []
    if r.error:
        notes.append(f"Not run: {redact(r.error)}")
    notes += [f"Note: {redact(n)}" for n in r.notices]
    if r.picked is not None:
        notes.append(f"Applied: Candidate {r.picked}. /undo puts the files back.")
    return head, rows, notes


def scoreboard_text(r: Race, how_to: str = HOW_TO) -> str:
    """The scoreboard as text: every number measured. "unknown" where a price is unknown."""
    head, rows, notes = scoreboard_rows(r)
    widths = [max(len(x) for x in col) for col in zip(SCORE_COLS, *rows)]
    lines = [head, "  ".join(x.ljust(w) for x, w in zip(SCORE_COLS, widths)).rstrip()]
    lines += ["  ".join(x.ljust(w) for x, w in zip(row, widths)).rstrip() for row in rows]
    lines += notes
    lines.append(how_to)
    return "\n".join(lines)


def rows_for_app(r: Race) -> list[dict]:
    """The scoreboard for the app's race card: the same words and numbers, with each candidate's diff and test output,
    redacted like a receipt and clipped."""
    out = []
    for c in r.ranked():
        s = c.score
        out.append({"n": c.n, "label": c.label, "proof": s.proof, "others": f"{s.others_passed}/{s.others_total}" if s.others_total else "none to run",
                    "project": s.project, "diff": f"+{s.diff_added} -{s.diff_removed}", "files": s.files, "tokens": s.tokens,
                    "cost": _money(s.cost_usd), "time": words_time(s.seconds), "status": c.status, "full_pass": s.full_pass,
                    "answer": c.answer[:1000], "diff_text": _clip(_diff_text(r, c), 20_000) if c.copy.is_dir() else "",
                    "tests": {k: _clip(v, 3000) for k, v in c.judge.items() if k in ("proof_base", "proof_self", "project") and v}})
    return redact_obj(out)


def show_text(r: Race, n: int) -> str:
    """One candidate: its diff, its answer, its test output and where its receipt is."""
    c = _candidate(r, n)
    out = [f"Candidate {c.n} ({c.label}): {c.status}", f"Proof: {c.score.proof} · others' tests {c.score.others_passed}/{c.score.others_total} · "
           f"project tests: {c.score.project}", f"Answer: {redact(c.answer)[:1500]}" if c.answer else "Answer: (none)", ""]
    out.append(_diff_text(r, c) or "(no changes)")
    for name, title in (("proof_base", "Its test on the untouched project"), ("proof_self", "Its test on its own change"),
                        ("project", "The project's tests on its change")):
        if c.judge.get(name):
            out += ["", f"{title}:", c.judge[name][:3000]]
    receipt = str(c.agent.log.path) if c.agent else c.receipt
    if receipt:
        out += ["", f"Receipt: {receipt}"]
    return "\n".join(out)


def _candidate(r: Race, n: int) -> Candidate:
    try:
        i = int(n)
    except (ValueError, TypeError):
        i = 0
    if not 1 <= i <= len(r.candidates):
        raise RaceError(f"there is no candidate {n}; this race has {len(r.candidates)}")
    return r.candidates[i - 1]


def _diff_text(r: Race, c: Candidate) -> str:
    parts = []
    for ch in c.changed:
        if ch.binary:
            parts.append(f"{ch.path}: binary file {ch.kind}\n")
            continue
        old = _text(r.base / ch.path) if ch.kind != "added" else ""
        new = _text(c.copy / ch.path) if ch.kind != "removed" else ""
        parts.append(unified_diff(old or "", new or "", ch.path))
    return "".join(parts)


def apply(r: Race, n: int, *, settings: config.Settings, ui, log: RunLog | None = None) -> str:
    """The pick: the winner's files reach the real project through the normal edit path. Every file first passes the
    deny rules and the project hook (one refusal refuses the whole pick and names the file; nothing partial); a file that
    changed in the real project since the race began is refused and named; then one approval for the whole set, shown
    as the full diff; the files are snapshotted into one change set ("race: <task>"), so /undo puts them all back."""
    c = _candidate(r, n)
    if r.picked is not None:
        raise RaceError(f"Candidate {r.picked} was already applied from this race. /undo puts the files back; then run the race again")
    if not c.done:
        raise RaceError(f"Candidate {c.n} is still running; wait for it, or stop the race")
    if not c.changed:
        raise RaceError(f"Candidate {c.n} changed nothing, so there is nothing to apply")
    if c.copy and not c.copy.is_dir():
        raise RaceError(f"Candidate {c.n}'s copy is gone (the race was dropped)")
    root = r.root
    perms = Permissions.from_settings(settings, root)
    for ch in c.changed:
        parts = Path(ch.path).parts
        if parts[:1] in ((".rooks",), (".git",)) or ".." in parts:
            raise RaceError(f"not applied: {ch.path} is managed by rooks or git and cannot be written")
        target = root / ch.path
        before_race = r.base / ch.path
        now_bytes = target.read_bytes() if target.is_file() else None
        then_bytes = before_race.read_bytes() if before_race.is_file() else None
        if now_bytes != then_bytes:
            raise RaceError(f"not applied: {ch.path} changed in this folder since the race began; look at it, then run the race again")
        rule = perms.check_path(target)
        if rule.verdict == "deny":
            raise RaceError(f"not applied: your permission rules never allow changing {ch.path} ({permissions.plain(rule.rule)}), "
                            f"so none of Candidate {c.n}'s {len(c.changed)} files were applied")
        blocked = project_hook(root, settings, "write_file", "write", {"path": ch.path})
        if blocked:
            raise RaceError(f"not applied: a project hook stopped the change to {ch.path} ({blocked[:200]}), so nothing was applied")
    added, removed = sum(ch.added for ch in c.changed), sum(ch.removed for ch in c.changed)
    summary = f"Apply Candidate {c.n}'s changes: {len(c.changed)} file{'s' if len(c.changed) != 1 else ''}, +{added} -{removed}"
    preview = _diff_text(r, c)
    if settings.dry_run:
        return f"Dry run: not applied. {summary}."
    changes = ChangeSets(root)

    def do() -> tuple[str, bool | None, str]:
        changes.begin(f"race: {r.task.strip()[:150]}")
        written = []
        for ch in c.changed:
            target = root / ch.path
            changes.snapshot(target)
            if ch.kind == "removed":
                target.unlink(missing_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(c.copy / ch.path, target)
                if target.read_bytes() != (c.copy / ch.path).read_bytes():
                    return f"{ch.path} was written but reads back differently", False, f"{ch.path} content does not match"
            written.append(ch.path)
        saved = changes.commit()
        return f"applied {len(written)} files", True, f"undo: {saved.name}" if saved else ""
    plan = Plan("write", summary, preview, do)
    plan.tool = "race"
    why = ("auto-approved (--yes)" if settings.auto_approve else "trusted folder" if settings.trusted() else "")
    if not why:
        show = getattr(ui, "show_plan", None)
        if show:
            show(plan)
        try:
            answer = ui.ask(plan)
        except (EOFError, KeyboardInterrupt):
            answer = "n"
        if answer not in ("y", "a", "h"):
            if log:
                log.add("decision", "denied", tool="race", detail=summary)
            raise RaceError(f"not applied: you said no. {summary} stays in its copy; /race show {c.n} has the diff")
        if log:
            log.add("decision", "approved", tool="race", detail=summary)
    elif hasattr(ui, "tool_note"):
        ui.tool_note(why)
    result, verified, evidence = do()
    if log:
        log.add("tool_call", "verified" if verified else "check_failed", tool="race", effect="write", args=summary, verified=verified,
                evidence=evidence, detail=f"candidate {c.n} of race {r.id}")
    if verified is False:
        raise RaceError(f"{result}; /undo puts the files back")
    r.picked = c.n
    r.save()
    return f"Applied Candidate {c.n}'s changes: {len(c.changed)} file{'s' if len(c.changed) != 1 else ''} (+{added} -{removed}). /undo puts them back."


def auto_pick(r: Race) -> tuple[int | None, str]:
    """--auto: the one candidate with a full pass, or why there is none to apply unasked."""
    full = [c for c in r.candidates if c.score.full_pass]
    if len(full) == 1:
        return full[0].n, f"Candidate {full[0].n} is the one full pass"
    if not full:
        return None, "no candidate has a full pass (proof held, every other candidate's tests pass, the project's tests pass); /race show N to read them"
    return None, f"{len(full)} candidates have a full pass ({', '.join(str(c.n) for c in full)}); pick one with /race pick N"


__all__ = ["BRIEFS", "Candidate", "CandidateSpec", "Change", "Race", "RaceError", "Score", "TestRun", "USAGE", "apply", "auto_pick",
           "changes_between", "drop", "drop_all", "is_test_file", "load", "make_copy", "parse_command", "parse_models", "result_of",
           "rows_for_app", "run", "run_tests", "saved", "scoreboard_rows", "scoreboard_text", "show_text", "specs_from",
           "start_words", "test_command_for"]
