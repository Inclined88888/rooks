"""The terminal audit's defects, one test each, ported from the audit's pseudo terminal scripts (s1 to s9).

Each test drives the real agent loop (or the real `rooks` process) against the scripted fake model in fakes.py over
real HTTP; no real model key is used. Every test here failed on the code before its fix.
"""

import io
import json
import re
import sys
import tomllib
from pathlib import Path

import pytest

from conftest import rooks
from fakes import FakeModel, openai_reply

REPO = Path(__file__).resolve().parents[2]
PKG = Path(__file__).resolve().parents[1]


@pytest.fixture
def fake():
    servers = []

    def make(script):
        servers.append(FakeModel(script))
        return servers[-1]
    yield make
    for s in servers:
        s.close()


def _settings(project, url, **kw):
    from rooks_code import config

    s = config.resolve({"provider": "openai-compatible", "base_url": url, "model": "fake-model"}, project, file={})
    s.sandbox, s.learn, s.stream = "full", False, False
    for k, v in kw.items():
        setattr(s, k, v)
    return s


class AskUI:
    """The plain terminal UI writing to buffers; answers each question from a list and records what was asked."""

    def __new__(cls, answers=()):
        from rooks_code.cli import UI

        ui = UI(out=io.StringIO(), err=io.StringIO(), color=False)
        ui.asked, queue = [], list(answers)

        def ask(plan):
            ui.asked.append(plan.summary)
            return queue.pop(0) if queue else "n"
        ui.ask = ask
        return ui


# 1. A refusal ends the turn ------------------------------------------------------------------------------------------
def test_a_refusal_ends_the_turn_and_is_never_nudged(project, fake):
    """s3: after "n", the model said "OK, I will not change it." and Rooks nudged it to carry on, so it went on to run
    the next scripted command. A refusal is not an announced step, and after a denial nothing is nudged."""
    from rooks_code.agent import NUDGE, Agent, announces_step

    assert not announces_step("OK, I will not change it.")
    assert not announces_step("Done. I'll leave it as is.")
    assert not announces_step("Understood, I won't touch calc.py.")
    assert announces_step("Now I'll read calc.py.")  # a real announcement is still caught

    edit = openai_reply("", [("edit_file", {"path": "calc.py", "old_text": "return a - b", "new_text": "return a + b"})])
    never = openai_reply("", [("run_command", {"command": "echo one"})])
    for refusal in ("OK, I will not change it.", "Next, I'll look for another way:"):
        m = fake([edit, openai_reply(refusal), never])
        ui = AskUI(["n"])
        agent = Agent(_settings(project, m.url), ui)
        assert agent.run("change x") == refusal
        assert len(m.requests) == 2, f"the turn went on after {refusal!r}"
        assert not any(x.get("content") == NUDGE for x in agent.messages)
        assert (project / "calc.py").read_text().endswith("a - b\n")
        agent.close()


# 2. "a" approves one command, one MCP tool on one server ---------------------------------------------------------------
def test_approve_for_this_session_covers_only_that_exact_command_and_that_one_tool(project, fake, monkeypatch):
    """s3: "a" on `echo one` let every later command run unasked (self.always.add(plan.effect))."""
    from rooks_code.agent import Agent
    from rooks_code.cli import UI

    m = fake([openai_reply("", [("run_command", {"command": "echo one"})]),
              openai_reply("", [("run_command", {"command": "echo one"})]),
              openai_reply("", [("run_command", {"command": "echo two"})]),
              openai_reply("", [("edit_file", {"path": "calc.py", "old_text": "return a - b", "new_text": "return a * b"})]),
              openai_reply("done")])
    ui = AskUI(["a", "n", "n"])
    agent = Agent(_settings(project, m.url), ui)
    assert agent.run("echo twice") == "done"
    assert ui.asked == ["run: echo one", "run: echo two", "edited calc.py"], ui.asked
    agent.close()

    # one MCP tool on one server: "a" for fake's shout does not approve the same tool on another server
    server = Path(__file__).with_name("fake_mcp_server.py")
    servers = {n: {"command": sys.executable, "args": [str(server)]} for n in ("fake", "other")}
    m = fake([openai_reply("", [("mcp__fake__shout", {"text": "a"})]), openai_reply("", [("mcp__fake__shout", {"text": "b"})]),
              openai_reply("", [("mcp__other__shout", {"text": "c"})]), openai_reply("done")])
    ui = AskUI(["a", "n"])
    agent = Agent(_settings(project, m.url, mcp_servers=servers), ui)
    assert agent.run("shout") == "done"
    assert [s.split(":")[0] for s in ui.asked] == ["MCP fake", "MCP other"], ui.asked
    agent.close()

    # the choice says what it covers, in the plain terminal and in the full one
    from rooks_code.tools import Plan

    for effect, summary, words in (("command", "run: echo one", "this exact command"), ("write", "edit calc.py", "changes to this file"),
                                   ("external", "MCP fake: shout {}", "this tool")):
        plan = Plan(effect, summary, "", lambda: ("", None, ""))
        plan.scope = {"command": "command", "write": "file", "external": "tool"}[effect]
        out = io.StringIO()
        monkeypatch.setattr("sys.stdin", io.StringIO("a\n"))
        assert UI(out=out, err=io.StringIO(), color=False).ask(plan) == "a"
        assert f"[a] Approve {words} for this session" in out.getvalue(), out.getvalue()


# 3. /init reloads the project instructions -------------------------------------------------------------------------
def test_init_reloads_project_instructions_into_the_running_session(project, fake):
    """s9: /init wrote AGENTS.md, but the next request's system prompt still had no project instructions."""
    from rooks_code import tui
    from rooks_code.agent import Agent

    m = fake([openai_reply("", [("write_file", {"path": "AGENTS.md", "content": "# demo\nRun tests with pytest.\n"})]),
              openai_reply("Wrote AGENTS.md."), openai_reply("ok")])
    ui = AskUI()
    agent = Agent(_settings(project, m.url, auto_approve=True), ui)
    tui.command(agent, ui, "/init", "")
    agent.run("rename")
    assert "Run tests with pytest" in m.requests[-1]["body"]["messages"][0]["content"]
    assert agent.instruction_files == [str(project / "AGENTS.md")]
    agent.close()


# 4. /doctor checks the session's own address ----------------------------------------------------------------------
def test_doctor_in_a_session_checks_the_address_the_session_uses(project, fake, capsys):
    """s3: /doctor passed base_url=None, so it checked the config's address, not the one this session talks to."""
    from rooks_code import tui
    from rooks_code.agent import Agent

    m = fake([openai_reply("ready")])
    ui = AskUI()
    agent = Agent(_settings(project, m.url), ui)
    tui.command(agent, ui, "/doctor", "")
    out = capsys.readouterr().out
    assert len(m.requests) == 1 and "model call: ok" in out, out
    agent.close()


# 5. A denial exits non-zero in one-shot mode ----------------------------------------------------------------------------
def test_a_denied_change_exits_3_in_one_shot_mode(project, fake):
    """s4: a one-shot run whose edit was denied (typed "n", or no input at all) exited 0, as if it had done the job."""
    edit = openai_reply("", [("edit_file", {"path": "calc.py", "old_text": "return a - b", "new_text": "return a + b"})])
    for stdin in ("n\n", ""):
        m = fake([edit, openai_reply("OK, I will leave it.")])
        r = rooks(project, "-P", "openai-compatible", "--base-url", m.url, "-m", "fake-model", "change x", stdin=stdin)
        assert r.returncode == 3, (stdin, r.returncode, r.stdout, r.stderr)
        assert (project / "calc.py").read_text().endswith("a - b\n")
    m = fake([openai_reply("Nothing to change.")])
    assert rooks(project, "-P", "openai-compatible", "--base-url", m.url, "-m", "fake-model", "look").returncode == 0
    readme = (PKG / "README.md").read_text()
    assert re.search(r"(?m)^\| *`?3`? *\|.*denied", readme), "the README lists the exit codes"


# 6. No raw address in a model error ---------------------------------------------------------------------------------
def test_a_model_error_is_said_in_plain_words_without_the_address(project, fake, monkeypatch):
    """s4: "Model error: http://127.0.0.1:.../v1/chat/completions answered 503: ..." on the normal screen."""
    from rooks_code import agent as agent_mod
    from rooks_code.agent import Agent

    monkeypatch.setattr(agent_mod, "RETRY_BASE_S", 0.001)
    for script, url in (([{"__status__": 503}] * 5, None), ([{"__status__": 400}], None), ([], "http://127.0.0.1:9/v1")):
        m = fake(script)
        ui = AskUI()
        a = Agent(_settings(project, url or m.url), ui)
        answer = a.run("hi")
        shown = ui.out.getvalue() + ui.err.getvalue() + answer
        assert "://" not in shown and "127.0.0.1" not in shown and "/v1" not in shown, shown
        assert "/doctor" in answer, answer  # where the detail is
        row = next(r for r in a.log.rows.values() if r["kind"] == "model_call" and r["outcome"] == "error")
        assert "127.0.0.1" in row["failure_reason"]  # the receipt keeps the detail
        a.close()


# 7. One meaning of "plan" -------------------------------------------------------------------------------------------
def test_the_shift_tab_setting_and_the_mode_setting_never_share_a_word():
    """s2/s3: the footer showed /mode (chat, plan, build) while the status bar showed Shift+Tab's "plan only", and the
    checklist was shown as "plan 1/2" too."""
    from rooks_code import tui, words

    mode_words = {"chat", "plan", "build"}
    assert not any(w in label.split() for label in tui.MODES for w in mode_words), tui.MODES
    shift_tab = dict(words.KEYS)["Shift+Tab"]
    assert "plan" not in shift_tab and "mode" not in shift_tab, shift_tab
    src = (PKG / "rooks_code" / "tui.py").read_text()
    assert 'f"plan {' not in src and 'f"Plan {' not in src  # the checklist is a checklist
    assert "plan only" not in (PKG / "rooks_code" / "delegate.py").read_text()
    assert "plan only" not in (PKG / "README.md").read_text()


# 8. One version number ----------------------------------------------------------------------------------------------
def test_one_version_number_everywhere():
    from rooks_code import __version__

    version = (REPO / "VERSION").read_text().strip()
    assert tomllib.loads((PKG / "pyproject.toml").read_text())["project"]["version"] == version
    assert __version__ == version
    assert f"version {version}," in (REPO / "AGENTS.md").read_text()


# 9. The README says answers stream ------------------------------------------------------------------------------------
def test_readme_says_answers_stream_live_in_the_terminal():
    from rooks_code.tui import RichUI

    assert RichUI(out=io.StringIO(), color=True).can_stream()  # the full terminal streams when it draws
    readme = " ".join((PKG / "README.md").read_text().split())
    assert "answers appear formatted once complete" not in readme
    assert "answers stream in as they are written" in readme
