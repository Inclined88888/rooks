"""The terminal is calm: one quiet header line, a static working line, no emoji or decorative boxes, the app's words
("Needs your OK", Approve, Deny), and one /help with every command and key."""

import io
import re
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

pytest.importorskip("prompt_toolkit")
pytest.importorskip("rich")

from rooks_code import tui, words  # noqa: E402
from rooks_code.cli import UI  # noqa: E402
from rooks_code.tools import Plan  # noqa: E402

# emoji and the decorations the old look used (record button, rook, stars, braille spinner, box corners)
LOUD = re.compile("[⏩-⏺\U0001F300-\U0001FAFF☀-⛿\u2705\u2728\u274c\u274e\u2753-\u2757\u2795-\u2797\u27b0\u27bf⭐⭕⠀-⣿✳-✸✻╭╮╰╯]")


def _agent(root):
    s = SimpleNamespace(provider="openai-compatible", model="fake-model", effort="", mcp_servers={}, dry_run=False,
                        auto_approve=False, trusted=lambda: False)
    return SimpleNamespace(s=s, root=root, instruction_files=[], tool_specs=lambda: [{}] * 14, messages=[])


def test_the_header_is_one_quiet_line(tmp_path):
    out = io.StringIO()
    ui = tui.RichUI(out=out, color=False)
    ui.console.width = 120
    tui.banner(_agent(tmp_path), ui)
    lines = [l for l in out.getvalue().splitlines() if l.strip()]
    assert len(lines) == 1, lines
    assert lines[0].startswith("Rooks ") and "fake-model" in lines[0] and "/help" in lines[0]
    assert not LOUD.search(out.getvalue())


def test_a_long_folder_never_hides_help(tmp_path):
    deep = tmp_path.joinpath(*(["a_rather_long_folder_name"] * 6))
    deep.mkdir(parents=True)
    out = io.StringIO()
    ui = tui.RichUI(out=out, color=False)
    ui.console.width = 120
    tui.banner(_agent(deep), ui)
    lines = [l for l in out.getvalue().splitlines() if l.strip()]
    assert len(lines) == 1 and "/help" in lines[0] and "fake-model" in lines[0], lines


def test_the_working_line_is_static_and_says_what_is_happening():
    out = io.StringIO()
    ui = tui.RichUI(out=out, color=True)
    ui.activity = "Reading calc.py"
    ui.thinking(True)
    time.sleep(0.55)
    ui.thinking(False)
    text = out.getvalue()
    drawn = [f for f in text.split("\r\033[2K") if f.strip()]
    assert len(drawn) == 1, drawn  # drawn once, then only again when the words or the seconds change
    assert "Reading calc.py" in drawn[0] and "Ctrl+C" in drawn[0]
    assert not LOUD.search(text)


def test_answers_steps_and_diffs_have_no_emoji_or_boxes(capsys):
    out = io.StringIO()
    ui = tui.RichUI(out=out, color=False)
    ui.console.width = 100
    ui.tool_note("read calc.py", read=True)
    plan = Plan("write", "edit calc.py", "--- a/calc.py\n+++ b/calc.py\n@@ -1 +1 @@\n-    return a - b\n+    return a + b\n",
                lambda: ("", None, ""))
    ui.show_plan(plan)
    ui.tool_result(plan, "edited calc.py (+1 -1)", "verified")
    ui.todos([{"text": "fix add", "status": "doing"}, {"text": "run tests", "status": "pending"}])
    ui.assistant("Fixed.", final=True)
    text = out.getvalue() + capsys.readouterr().out
    assert "Read calc.py" in text and "+    return a + b" in text and "Fixed." in text
    assert not LOUD.search(text), [c for c in text if LOUD.match(c)]
    assert "│" not in text and "─" not in text  # no panels around a diff or a plan


@pytest.mark.parametrize("ui_type", [tui.RichUI, UI])
def test_an_approval_reads_needs_your_ok_with_approve_and_deny(monkeypatch, ui_type):
    monkeypatch.setattr("sys.stdin", io.StringIO("y\n"))
    monkeypatch.setattr("builtins.input", lambda *a: "y")
    out = io.StringIO()
    ui = ui_type(out=out, color=False)
    plan = Plan("write", "edit calc.py", "edit calc.py", lambda: ("", None, ""))
    assert ui.ask(plan) == "y"
    import sys

    text = out.getvalue() + (sys.stdout.getvalue() if hasattr(sys.stdout, "getvalue") else "")
    assert "Needs your OK" in text and "Approve" in text and "Deny" in text


def test_one_help_lists_every_command_and_every_key(tmp_path):
    out = io.StringIO()
    ui = tui.RichUI(out=out, color=False)
    ui.console.width = 160
    tui.command(_agent(tmp_path), ui, "/help", "")
    text = out.getvalue()
    for cmd in tui.COMMANDS:
        assert cmd in text, cmd
    for key, _ in words.KEYS:
        assert key in text, key
    for needed in ("/room", "/needs", "/jobs", "/memory", "/model"):
        assert needed in tui.COMMANDS


def test_plain_help_is_the_same_list():
    text = words.help_text()
    for cmd in words.COMMANDS:
        assert cmd in text
    for key, _ in words.KEYS:
        assert key in text


def test_steps_are_said_in_plain_words_like_the_app():
    assert words.plain_step("read_file", {"path": "calc.py"}) == "Reading calc.py"
    assert words.plain_step("run_command", {"command": "pytest -q"}) == "Running pytest -q"
    assert words.plain_step("web_search", '{"query": "rooks"}') == "Searching: rooks"
    assert words.plain_step("use_room", '{"action": "run", "command": "ls"}') == "Running in the Room: ls"
    assert words.plain_step("send_email", "{}") == "Preparing to send mail"
    assert words.plain_step("mcp__x__y", {}) == "Working"


def test_no_emoji_or_old_names_in_what_the_terminal_says():
    src = "".join((Path(tui.__file__).parent / f).read_text(encoding="utf-8") for f in ("tui.py", "cli.py", "words.py", "workroom.py", "talk.py"))
    assert "⏺" not in src and "♜" not in src and "⠀" not in src  # record button, rook, spinner
    assert "Workbench conversation" not in src and "Approvals #" not in src
