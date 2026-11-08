"""Run one rooks task from a script, in this process: the same run `rooks -p` does, and the same result object.

    from rooks_code import sdk

    res = sdk.run("make the failing test pass", cwd="path/to/project", on_event=print)
    print(res.exit_code, res.result, res.denied)

A headless run never waits for input. A step that needs an OK (an edit, a command, an MCP tool, an MCP server's
question to you) is denied at once and reported, unless something you set up beforehand allows it: a permission rule
in rooks.toml [permissions] (or a trusted folder's .rooks/settings.json), a trusted folder, or yes=True (the same as
--yes, which approves the agent's own steps; an MCP server's question to you is still denied). A deny rule refuses in
every mode. Nothing is read from standard input, and nothing is written to standard output: what happens arrives as
events (dicts, one per step, shaped as #/$defs/event in schema/headless.schema.json) through on_event, and the run
ends with a Result (#/$defs/result). Text in both has keys, tokens, emails and phone numbers hidden, as in the receipts.

Exit codes (Result.exit_code, also rooks -p's): 0 done, 1 error or not finished, 2 bad usage or cannot start,
3 something was denied.

A headless run is not linked to a chat in the Rooks app: it uses the model through the app (provider workbench) like
any other provider, but nothing waits in the app's Needs you for an answer.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from . import __version__, words
from .redact import redact, redact_obj

EXIT_OK = 0          # finished
EXIT_UNFINISHED = 1  # did not finish: model error, step limit, a cap reached, a change whose check failed
EXIT_SETUP = 2       # bad usage or cannot start: no task, an unknown provider, no key for the provider
EXIT_DENIED = 3      # a step was denied: it needed an OK nobody can give here, a permission rule, or a project hook

SCHEMA = Path(__file__).with_name("schema") / "headless.schema.json"
TEXT_LIMIT = 4000  # characters of a tool's result or a diff kept in an event
FINISHED = ("no_claim", "backed")  # turn outcomes that mean the job is done (receipts.py)
STOPPED = ("model_error", "step_limit", "budget_paused", "loop_detected")  # ended early; the answer says why
OUTCOMES = (*FINISHED, *STOPPED, "unbacked", "interrupted")


@dataclass
class Result:
    """What a headless run ended with. to_dict() is the json output and the stream's end event."""

    exit_code: int
    result: str = ""
    outcome: str = "not_started"
    session_id: str | None = None
    turns: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    cache_read: int = 0  # of tokens_in, read from the provider's prompt cache
    cache_write: int = 0  # of tokens_in, written to it
    cost_usd: float | None = 0.0
    denied: list[dict] = field(default_factory=list)
    error: str = ""
    duration_ms: int = 0

    @property
    def ok(self) -> bool:
        return self.exit_code == EXIT_OK

    def to_dict(self, kind: str = "result") -> dict:
        return {"type": kind, "ok": self.ok, "result": redact(self.result), "outcome": self.outcome,
                "session_id": self.session_id, "turns": self.turns,
                "tokens": {"input": self.tokens_in, "output": self.tokens_out, "cache_read": self.cache_read,
                           "cache_write": self.cache_write}, "cost_usd": self.cost_usd,
                "denied": [redact_obj(d) for d in self.denied], "exit_code": self.exit_code, "error": redact(self.error),
                "duration_ms": self.duration_ms}


def _short(text, limit: int = TEXT_LIMIT) -> str:
    text = redact(str(text or ""))
    return text if len(text) <= limit else text[:limit] + f"\n[... {len(text) - limit} more characters]"


class HeadlessUI:
    """The UI the agent talks to in a headless run: no keyboard, no screen. Every question is answered no at once,
    and everything that happens becomes an event."""

    conversation_id = None  # never linked to an app chat: nothing may wait in Needs you
    base_url = None
    api_key = None
    session_id = None
    color = False

    def __init__(self, emit: Callable[[dict], None]):
        self._emit = emit
        self.denied: list[dict] = []
        self.activity = ""

    # events --------------------------------------------------------------------------------------------------------
    def event(self, ev: dict) -> None:
        ev = dict(ev)
        kind = ev.get("type")
        if kind == "approval_denied":
            if ev.get("by") == "answer":
                ev["by"] = "headless"  # nobody can answer a headless run: every "no" here is that
            self.denied.append({"tool": str(ev.get("tool") or ""), "summary": redact(str(ev.get("summary") or "")),
                                "by": ev["by"]})
        if kind == "tool_call":
            ev["args"] = redact_obj(ev.get("args") if isinstance(ev.get("args"), dict) else {})
        if kind == "tool_result":
            ev["result"] = _short(ev.get("result"))
        for k in ("summary", "text", "tool", "id"):
            if k in ev:
                ev[k] = redact(str(ev[k]))
        self._emit(ev)

    def _note(self, level: str, text: str) -> None:
        text = str(text or "").strip()
        if text:
            self._emit({"type": "notice", "level": level, "text": redact(text)})

    # what the agent calls --------------------------------------------------------------------------------------------
    def ask(self, plan) -> str:
        ev = {"type": "approval_asked", "tool": redact(str(getattr(plan, "tool", "") or plan.effect)),
              "effect": plan.effect if plan.effect in ("write", "command", "external") else "external",
              "summary": redact(words.wanted_step(plan.summary))}
        if getattr(plan, "preview", ""):
            ev["preview"] = _short(plan.preview)
        self._emit(ev)
        return "n"

    def assistant(self, text: str, final: bool) -> None:
        if text and text.strip():
            self._emit({"type": "assistant", "text": redact(text.strip()), "final": bool(final)})

    def tool_note(self, text: str, read: bool = False) -> None:
        if not read:  # a read is already its tool_call event
            self._note("info", text)

    def notice(self, text: str, needs_you: bool = False) -> None:
        self._note("info", text)

    def warn(self, text: str) -> None:
        self._note("warn", text)

    def error(self, text: str) -> None:
        self._note("error", text)

    def p(self, text: str = "", err: bool = False) -> None:
        self._note("info", text)

    def c(self, code: str, text: str) -> str:
        return text

    def working(self, text: str) -> None:
        self.activity = text

    def can_stream(self) -> bool:
        return False

    def show_plan(self, plan) -> None:  # the step is in tool_call; its diff is in approval_asked when one is asked
        pass

    def tool_result(self, plan, result: str, outcome: str) -> None:  # the agent sends tool_result itself
        pass

    def todos(self, items: list[dict]) -> None:
        pass

    def thinking(self, on: bool) -> None:
        pass

    def stream(self, delta: str) -> None:
        pass

    def stream_end(self) -> None:
        pass

    def footer(self, totals: dict, s, undo: bool) -> None:
        pass


def _approvals(s) -> str:
    return "dry-run" if s.dry_run else "yes" if s.auto_approve else "refuse"


def run(prompt: str, *, cwd: str | Path | None = None, provider: str | None = None, model: str | None = None,
        base_url: str | None = None, yes: bool = False, dry_run: bool = False, max_usd: float | None = None,
        max_tokens: int | None = None, max_steps: int | None = None, mcp: bool = True, resume: str | None = None,
        continue_last: bool = False, on_event: Callable[[dict], None] | None = None) -> Result:
    """Run one task headless in the folder cwd and return its Result. Never reads standard input and never raises for
    a bad setup or a failed run: those come back as exit_code 2 or 1 with error in plain words."""
    from . import config

    started = time.monotonic()
    sink = on_event or (lambda ev: None)

    def finish(res: Result) -> Result:
        res.duration_ms = int((time.monotonic() - started) * 1000)
        sink(res.to_dict("end"))
        return res

    root = Path(cwd or Path.cwd()).expanduser().resolve()
    if not root.is_dir():
        return finish(Result(EXIT_SETUP, error=f"{root} is not a folder"))
    if not (prompt or "").strip():
        return finish(Result(EXIT_SETUP, error="no task given: pass one, for example rooks -p \"fix the failing test\", "
                                               "or pipe it in"))
    overrides = {"provider": provider, "model": model, "base_url": base_url, "yes": yes, "dry_run": dry_run,
                 "max_usd": max_usd, "max_tokens": max_tokens, "max_steps": max_steps}
    try:
        s = config.resolve(overrides, root)
    except SystemExit as e:  # config.resolve says what is wrong in words ("rooks: unknown provider ...")
        return finish(Result(EXIT_SETUP, error=str(e).removeprefix("rooks: ").splitlines()[0] if str(e) else "cannot start"))
    if s.kind == "delegate":
        return finish(Result(EXIT_SETUP, error=f"{s.provider} runs its own agent, which has its own headless mode; "
                                               "rooks -p works with a model provider"))
    if s.key_env and not s.api_key and not s.key_optional:
        return finish(Result(EXIT_SETUP, error=f"{s.provider} needs an API key in the {s.key_env} environment variable "
                                               "(or run rooks login)"))
    if not mcp:
        s.mcp_servers = {}
    s.stream = False

    history: list[dict] = []
    if continue_last or resume:
        from .cli import load_session

        history, note = load_session(root, resume)
        if not history:
            return finish(Result(EXIT_SETUP, error=note))

    from .agent import Agent
    from .receipts import RunLog

    ui = HeadlessUI(sink)
    log = RunLog(root, provider=s.provider, model=s.model)
    sink({"type": "start", "session_id": log.session, "version": __version__, "provider": s.provider,
          "model": s.model or "", "cwd": str(root), "approvals": _approvals(s)})
    res = Result(EXIT_UNFINISHED, session_id=log.session)
    agent = None
    try:
        agent = Agent(s, ui, log=log, messages=history)
        res.result = agent.run(prompt) or ""
        turns = [r for r in log.rows.values() if r["kind"] == "turn"]
        res.outcome = turns[-1]["outcome"] if turns and turns[-1]["outcome"] in OUTCOMES else "error"
        if agent.denials or ui.denied:
            res.exit_code = EXIT_DENIED
        elif res.outcome in FINISHED:
            res.exit_code = EXIT_OK
        if res.outcome in STOPPED:  # the answer is the reason it stopped, in plain words: that is the error
            res.error, res.result = res.result, ""
        elif res.outcome == "interrupted":
            res.error = "stopped before it finished"
        elif res.outcome == "unbacked":
            res.error = "a change was made but its check failed"
    except Exception as e:  # noqa: BLE001 - a script gets an answer, never a stack trace
        res.outcome, res.exit_code = "error", EXIT_UNFINISHED
        res.error = f"rooks stopped unexpectedly ({type(e).__name__}); the receipt in .rooks/runs has what was done"
    finally:
        if agent is not None:
            agent.close()
    t = log.totals()
    res.turns = sum(1 for r in log.rows.values() if r["kind"] == "model_call" and r["outcome"] != "retry")
    res.tokens_in, res.tokens_out, res.cache_read, res.cache_write = t["tokens_in"], t["tokens_out"], t["cache_read"], t["cache_write"]
    res.cost_usd = None if t["cost_unknown"] else t["usd"]
    res.denied = list(ui.denied)
    return finish(res)


def schema() -> dict:
    """The JSON Schema of the result and of each event (schema/headless.schema.json)."""
    return json.loads(SCHEMA.read_text(encoding="utf-8"))


__all__ = ["EXIT_DENIED", "EXIT_OK", "EXIT_SETUP", "EXIT_UNFINISHED", "HeadlessUI", "Result", "run", "schema"]
