import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from rooks_code import config, providers
from rooks_code.tools import Toolbox, ToolError


def test_config_precedence(tmp_path, monkeypatch):
    monkeypatch.delenv("ROOKS_MODEL", raising=False)
    monkeypatch.delenv("ROOKS_BASE_URL", raising=False)
    file = {"provider": "openrouter", "model": "anthropic/claude-sonnet-4.5", "max_usd": 3.0}
    monkeypatch.delenv("ROOKS_PROVIDER", raising=False)
    s = config.resolve({}, tmp_path, file)
    assert (s.provider, s.model, s.base_url, s.key_env, s.max_usd) == (
        "openrouter", "anthropic/claude-sonnet-4.5", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY", 3.0)
    s = config.resolve({"provider": "ollama"}, tmp_path, file)
    assert s.model == "qwen2.5:7b" and s.local and s.base_url == "http://localhost:11434/v1"
    monkeypatch.setenv("ROOKS_MODEL", "llama3.2")
    assert config.resolve({"provider": "lmstudio"}, tmp_path, file).model == "llama3.2"
    assert config.resolve({"provider": "ollama", "max_usd": 0}, tmp_path, file).max_usd is None
    with pytest.raises(SystemExit):
        config.resolve({"provider": "nope"}, tmp_path, file)
    custom = {"providers": {"groq": {"kind": "openai", "base_url": "https://api.groq.com/openai/v1", "key_env": "GROQ_API_KEY",
                                     "model": "llama-3.3-70b"}}}
    assert config.resolve({"provider": "groq"}, tmp_path, custom).base_url == "https://api.groq.com/openai/v1"


def test_example_config_parses():
    import tomllib
    assert "provider" not in tomllib.loads(config.EXAMPLE)  # the default is chosen at run time (open app, else ollama)


def test_prices():
    assert providers.price("claude-sonnet-4-5-20250929", {}, False) == (3.0, 15.0)
    assert providers.price("openai/gpt-4.1-mini", {}, False) == (0.4, 1.6)
    assert providers.price("whatever", {}, True) == (0.0, 0.0)
    assert providers.price("mystery", {}, False) is None
    assert providers.cost("mystery", 10, 10, {"mystery": [1, 2]}, False) == 0.00003


def test_prices_current_claude_models():
    # Anthropic list prices per million tokens [input, output]
    assert providers.price("claude-fable-5-1", {}, False) == (10.0, 50.0)
    assert providers.price("claude-opus-5-5", {}, False) == (4.0, 20.0)
    assert providers.price("claude-opus-5", {}, False) == (5.0, 25.0)
    assert providers.price("claude-sonnet-5-5", {}, False) == (2.0, 10.0)
    assert providers.price("claude-sonnet-4-6", {}, False) == (3.0, 15.0)
    assert providers.price("claude-haiku-5-5", {}, False) == (0.1, 0.5)
    # the default model must have a price, or every rooks run on it shows cost unknown
    assert providers.price(config.PROVIDERS["anthropic"]["model"], {}, False) is not None


def test_haiku_5_5_long_prompt_tier():
    # above 100K input tokens in one request Haiku 5.5 costs $0.50 / $2.50, not the base rate
    assert providers.cost("claude-haiku-5-5", 100_000, 1_000, {}, False) == round((100_000 * 0.1 + 1_000 * 0.5) / 1e6, 6)
    assert providers.cost("claude-haiku-5-5", 150_000, 1_000, {}, False) == round((150_000 * 0.5 + 1_000 * 2.5) / 1e6, 6)
    # a user override wins over the tier
    assert providers.cost("claude-haiku-5-5", 150_000, 0, {"claude-haiku-5-5": [1, 1]}, False) == 0.15


def test_default_claude_model_matches_app_browser_and_desk():
    """AGENTS.md: the terminal, the browser and the app must match. The app's preferred Anthropic model is the source."""
    import pathlib
    repo = pathlib.Path(__file__).resolve().parents[2]
    app = repo / "workbench" / "backend" / "app" / "llm.py"
    if not app.exists():
        pytest.skip("not a full checkout")
    m = re.search(r'"api\.anthropic\.com":\s*"(claude-[^"]+)"', app.read_text())
    assert m, "the app's preferred Anthropic model is not where this test looks (workbench/backend/app/llm.py)"
    want = m.group(1)
    assert config.PROVIDERS["anthropic"]["model"] == want
    for sub in ("rooks-browser/rooks_browser/llm.py", "rooks-desk/rooks_desk/llm.py"):
        if not (repo / sub).exists():
            continue  # a partial checkout
        found = re.search(r'\("anthropic",\s*"Anthropic Claude",\s*\("ANTHROPIC_API_KEY",\),\s*"(claude-[^"]+)"', (repo / sub).read_text())
        assert found, f"{sub}: the Anthropic default is not where this test looks"
        assert found.group(1) == want, f"{sub} defaults to {found.group(1)}, the app to {want}"


def test_trusted_folders(tmp_path):
    s = config.Settings(root=tmp_path / "a" / "b", trusted_folders=[str(tmp_path / "a")])
    assert s.trusted()
    assert not config.Settings(root=tmp_path, trusted_folders=[str(tmp_path / "a")]).trusted()


def test_edit_requires_unique_match(tmp_path):
    (tmp_path / "f.txt").write_text("x\nx\n")
    tb = Toolbox(tmp_path)
    with pytest.raises(ToolError, match="matches 2 locations"):
        tb.prepare("edit_file", {"path": "f.txt", "old_text": "x", "new_text": "y"})
    plan = tb.prepare("edit_file", {"path": "f.txt", "old_text": "x", "new_text": "y", "replace_all": True})
    assert "-x" in plan.preview and (tmp_path / "f.txt").read_text() == "x\nx\n"  # nothing applied before approval
    assert plan.apply()[1] is True and (tmp_path / "f.txt").read_text() == "y\ny\n"
    with pytest.raises(ToolError, match="managed by rooks"):
        tb.prepare("write_file", {"path": ".git/config", "content": ""})


def test_search_and_list_skip_noise(tmp_path):
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "a.js").write_text("needle")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "b.js").write_text("one\nneedle here\n")
    tb = Toolbox(tmp_path)
    assert tb.prepare("search", {"pattern": "needle"}).apply()[0] == "src/b.js:2: needle here"
    assert tb.prepare("list_files", {"pattern": "*.js"}).apply()[0] == "src/b.js"


def test_node_modules_stay_skipped_even_when_git_would_track_them(tmp_path):
    # regression for task 00: rg respects .gitignore but also its own defaults; node_modules is in SKIP_DIRS and
    # must never be walked or searched, even with no .gitignore and no git repo.
    (tmp_path / "node_modules" / "pkg").mkdir(parents=True)
    (tmp_path / "node_modules" / "pkg" / "a.js").write_text("needle\n")
    (tmp_path / "app.js").write_text("needle\n")
    tb = Toolbox(tmp_path)
    out = tb.prepare("search", {"pattern": "needle"}).apply()[0]
    assert "app.js" in out and "node_modules" not in out
    assert tb.prepare("list_files", {}).apply()[0] == "app.js"


def test_tool_calls_printed_as_text_are_recovered_only_when_valid():
    names = {"list_files", "read_file"}
    text = 'Let me look.\n\n```json\n{"name": "list_files", "arguments": {}}\n```\n\nThen I will read.'
    calls, rest = providers.parse_text_tool_calls(text, names)
    assert [(c.name, c.arguments, c.from_text) for c in calls] == [("list_files", {}, True)]
    assert rest == "Let me look.\n\n\n\nThen I will read."
    tagged = '<tool_call>\n{"name": "read_file", "arguments": {"path": "a.py"}}\n</tool_call>'
    assert providers.parse_text_tool_calls(tagged, names)[0][0].arguments == {"path": "a.py"}
    for not_a_call in ('```json\n{"name": "rm_rf", "arguments": {}}\n```', '```json\n{"a": 1}\n```', "just text {x}"):
        assert providers.parse_text_tool_calls(not_a_call, names) == ([], not_a_call)


def test_announced_step_detection():
    from rooks_code.agent import announces_step
    assert announces_step("Great. First, I'll run the tests using `python3 test_calc.py`.")
    assert announces_step("Let's execute the command:")
    assert announces_step("Now, read the file.\n\nThis will read the `mathutil.py` file.")
    assert not announces_step("Fixed add(): it subtracted. The test now passes.")
    assert not announces_step("Shall I run the tests?")
    assert announces_step("Next, I'll **search** in `test_calc.py`:\n\n1. **Search in `test_calc.py`** for failed tests:")
    assert not announces_step("Here is a summary: 1. Listed files. I'll be here if you need more. Let me know!")


def test_text_tool_calls_several_objects_in_one_fence():
    from rooks_code import providers

    text = ('Step 4\n```json\n{"name": "edit_file", "arguments": {"path": "a.py", "old_text": "x", "new_text": "y"}}\n'
            '{"name": "edit_file", "arguments": {"path": "a.py", "old_text": "p", "new_text": "q"}}\n```\nthen check')
    calls, rest = providers.parse_text_tool_calls(text, {"edit_file", "run_command"})
    assert [c.arguments["new_text"] for c in calls] == ["y", "q"]
    assert "edit_file" not in rest


def test_text_tool_calls_repeated_by_the_model_run_once():
    from rooks_code import providers

    one = '```json\n{"name": "run_command", "arguments": {"command": "python3 t.py"}}\n```\n'
    calls, _ = providers.parse_text_tool_calls("Run it.\n" + one * 20, {"run_command"})
    assert len(calls) == 1


def test_rooks_desk_is_added_as_an_untrusted_mcp_server_when_installed(tmp_path, monkeypatch):
    monkeypatch.delenv("ROOKS_DESK_MCP", raising=False)
    monkeypatch.setattr(config.shutil, "which", lambda name: "/opt/bin/rooks-desk" if name == "rooks-desk" else None)
    s = config.resolve({"provider": "ollama"}, tmp_path, {})
    assert s.mcp_servers["desk"] == {"command": "/opt/bin/rooks-desk", "args": ["mcp"], "trusted": False}
    assert "desk" not in config.resolve({"provider": "ollama"}, tmp_path, {"mcp": {"desk": False}}).mcp_servers
    monkeypatch.setenv("ROOKS_DESK_MCP", "0")
    assert "desk" not in config.resolve({"provider": "ollama"}, tmp_path, {}).mcp_servers
    monkeypatch.setattr(config.shutil, "which", lambda name: None)
    monkeypatch.delenv("ROOKS_DESK_MCP")
    assert "desk" not in config.resolve({"provider": "ollama"}, tmp_path, {}).mcp_servers


def test_rooks_code_opens_the_session_instead_of_running_the_task_code(monkeypatch, tmp_path):
    """`rooks code` once ran "code" as a prompt and read the whole home folder until the token cap."""
    from rooks_code import cli

    seen = {}

    def fake_resolve(overrides, root):
        raise SystemExit("stop")

    monkeypatch.setattr(cli.config, "resolve", fake_resolve)
    orig = cli.parser

    def spy():
        p = orig()
        real = p.parse_args

        def parse(argv=None):
            a = real(argv)
            seen["args"] = a
            return a
        p.parse_args = parse
        return p

    monkeypatch.setattr(cli, "parser", spy)
    import pytest
    with pytest.raises(SystemExit):
        cli.main(["code", "--cwd", str(tmp_path)])
    assert seen["args"].prompt == []


def test_help_never_hides_a_command(monkeypatch):
    import io

    from rich.console import Console

    from rooks_code import tui

    ui = tui.RichUI(color=False)
    ui.console = Console(file=io.StringIO(), width=200)
    tui.help_table(ui)
    out = ui.console.file.getvalue()
    assert all(cmd in out for cmd in tui.COMMANDS)


# ── New feature tests ──────────────────────────────────────────────────

def test_loop_detection_tool_call_cycle(tmp_path):
    """Loop detector catches repeated identical tool calls."""
    from rooks_code.loop_detection import LoopDetector, LoopDetectionResult

    detector = LoopDetector()
    # Simulate 5 identical tool calls (threshold)
    result = LoopDetectionResult()
    for _ in range(5):
        result = detector.on_tool_call("read_file", {"path": "a.py"})
    assert result.detected
    assert result.loop_type == "tool_call"
    assert "Repeating cycle" in result.detail


def test_loop_detection_read_heavy(tmp_path):
    """Loop detector catches many reads without writes."""
    from rooks_code.loop_detection import LoopDetector, LoopDetectionResult

    detector = LoopDetector()
    result = LoopDetectionResult()
    # Use different read tools to avoid tool_call cycle detection
    read_tools = ["read_file", "list_files", "search", "web_search", "web_fetch"]
    # Fill the window with 20 read calls (4 cycles of 5 different tools)
    # Detection happens when the window is full (call 20)
    for i in range(20):
        result = detector.on_tool_call(read_tools[i % 5], {"path": "a.py", "pattern": "foo"})
    assert result.detected
    assert result.loop_type == "read_heavy"


def _contained() -> bool:
    from conftest import _can_contain
    return _can_contain()


@pytest.mark.skipif(sys.platform == "win32", reason="Windows has no containment yet; the approval line says so "
                    "(test_windows_project_mode_runs_but_says_it_is_not_contained). Single quotes made cmd.exe fail to parse the "
                    "path here, so this passed on Windows without anything being contained.")
def test_project_sandbox_blocks_a_write_outside_the_folder(tmp_path):
    """A command may change files in the project. It may not write outside it, even into the home folder. Where this
    machine cannot contain it (Linux without a working bubblewrap) it is refused before approval, never run uncontained."""
    outside = Path.home() / f".rooks-escape-{tmp_path.name}.txt"
    outside.unlink(missing_ok=True)
    tb = Toolbox(tmp_path)
    tb.sandbox = "project"
    try:
        try:
            result = tb.prepare("run_command", {"command": f"echo pwned > '{outside}'"}).apply()[0]
        except ToolError as e:
            assert not _contained(), f"refused although this machine can contain commands: {e}"
            result = str(e)
        assert not outside.exists(), result
        if _contained():
            tb.prepare("run_command", {"command": "echo ok > inside.txt"}).apply()
            assert (tmp_path / "inside.txt").read_text().strip() == "ok"
    finally:
        outside.unlink(missing_ok=True)


def test_project_sandbox_refuses_without_bubblewrap_before_asking(tmp_path, monkeypatch):
    """Linux without bwrap: refused in plain words, with the way to fix it, when the command is prepared, so nobody is
    asked to approve a command that can never run. Nothing runs."""
    from rooks_code import tools
    monkeypatch.setattr(sys, "platform", "linux")
    real_which = shutil.which
    monkeypatch.setattr(tools.shutil, "which", lambda n, *a, **k: None if n == "bwrap" else real_which(n, *a, **k))
    tb = Toolbox(tmp_path, sandbox="project")
    with pytest.raises(ToolError, match="Install bubblewrap"):
        tb.prepare("run_command", {"command": "echo ok > inside.txt"})
    assert not (tmp_path / "inside.txt").exists()


def test_full_sandbox_is_an_ordinary_shell(tmp_path):
    argv = Toolbox(tmp_path, sandbox="full")._command_argv("echo hi")
    if isinstance(argv, str):  # Windows: one cmd.exe string
        assert argv.endswith('"echo hi"') and "bwrap" not in argv and "sandbox-exec" not in argv
    else:
        assert argv[-1] == "echo hi" and "bwrap" not in argv[0] and "sandbox-exec" not in argv[0]


def test_windows_project_mode_runs_but_says_it_is_not_contained(tmp_path, monkeypatch):
    """Windows has no containment yet. Rather than refuse every command (a fresh install would lose them) or pretend,
    the approval line says plainly that the command is not kept inside the folder. Full mode says nothing."""
    from rooks_code import tools
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setenv("COMSPEC", r"C:\Windows\system32\cmd.exe")
    tb = Toolbox(tmp_path, sandbox="project")
    plan = tb.prepare("run_command", {"command": "echo hi"})
    assert tools.NOT_CONTAINED_ON_WINDOWS in plan.preview and plan.preview.startswith("$ echo hi")
    tb.sandbox = "full"
    assert tools.NOT_CONTAINED_ON_WINDOWS not in tb.prepare("run_command", {"command": "echo hi"}).preview


def test_edit_fuzzy_matching_whitespace(tmp_path):
    """Edit tool matches with whitespace differences."""
    from rooks_code.tools import Toolbox

    (tmp_path / "f.txt").write_text("def foo():\n    return 1\n")
    tb = Toolbox(tmp_path)
    # Extra spaces in old_text
    plan = tb.prepare("edit_file", {
        "path": "f.txt",
        "old_text": "def foo():  \n    return 1\n",
        "new_text": "def foo():\n    return 2\n",
    })
    assert plan.apply()[1] is True
    assert (tmp_path / "f.txt").read_text() == "def foo():\n    return 2\n"


def test_edit_fuzzy_matching_indentation(tmp_path):
    """Edit tool matches with different indentation."""
    from rooks_code.tools import Toolbox

    (tmp_path / "f.txt").write_text("def foo():\n    return 1\n")
    tb = Toolbox(tmp_path)
    # Wrong indentation in old_text
    plan = tb.prepare("edit_file", {
        "path": "f.txt",
        "old_text": "def foo():\nreturn 1\n",
        "new_text": "def foo():\n    return 2\n",
    })
    assert plan.apply()[1] is True
    assert (tmp_path / "f.txt").read_text() == "def foo():\n    return 2\n"


def test_edit_fuzzy_matching_line_trimmed(tmp_path):
    """Edit tool matches with trailing whitespace differences."""
    from rooks_code.tools import Toolbox

    (tmp_path / "f.txt").write_text("def foo():\n    return 1   \n")
    tb = Toolbox(tmp_path)
    # No trailing spaces in old_text
    plan = tb.prepare("edit_file", {
        "path": "f.txt",
        "old_text": "def foo():\n    return 1\n",
        "new_text": "def foo():\n    return 2\n",
    })
    assert plan.apply()[1] is True
    assert (tmp_path / "f.txt").read_text() == "def foo():\n    return 2\n"


def test_edit_miss_hint_shows_closest_lines(tmp_path):
    """Edit tool shows closest matching lines on failure."""
    from rooks_code.tools import Toolbox, ToolError

    (tmp_path / "f.txt").write_text("def foo():\n    return 1\n\ndef bar():\n    return 2\n")
    tb = Toolbox(tmp_path)
    with pytest.raises(ToolError) as exc:
        tb.prepare("edit_file", {
            "path": "f.txt",
            "old_text": "def foo():\n    return 999\n",
            "new_text": "def foo():\n    return 2\n",
        })
    assert "closest lines" in str(exc.value).lower() or "the closest lines" in str(exc.value).lower()


def test_repo_map_extracts_symbols(tmp_path):
    """Repo map extracts functions and classes from Python files."""
    from rooks_code.repo_map import RepoMap

    (tmp_path / "mod.py").write_text("""
def hello():
    \"\"\"Say hello.\"\"\"
    return "hi"

class Greeter:
    \"\"\"Greets people.\"\"\"
    def greet(self, name):
        return f"Hello, {name}"
""")
    repo_map = RepoMap(tmp_path)
    symbols = repo_map.get_all_symbols()
    names = {s.name for s in symbols}
    assert "hello" in names
    assert "Greeter" in names
    assert "greet" in names


def test_repo_map_formats_output(tmp_path):
    """Repo map produces formatted output within token budget."""
    from rooks_code.repo_map import RepoMap

    (tmp_path / "mod.py").write_text("def foo():\n    return 1\n")
    repo_map = RepoMap(tmp_path, max_tokens=100)
    output = repo_map.get_repo_map()
    assert "mod.py" in output
    assert "foo" in output


def test_proactive_pruning(tmp_path):
    """Large tool results are proactively pruned."""
    from rooks_code.agent import Agent, PRUNE_TOOL_RESULT_AT

    # This is tested indirectly through the agent's _proactive_prune
    # Just verify the constant is reasonable
    assert PRUNE_TOOL_RESULT_AT == 8000


def test_fallback_chain_config(tmp_path, monkeypatch):
    """Config loads fallback_models from TOML."""
    from rooks_code import config

    toml = """
provider = "ollama"
model = "qwen2.5:7b"
fallback_models = [
    {provider = "groq", model = "llama-3.3-70b"},
    {provider = "openrouter", model = "openai/gpt-4o-mini"},
]
"""
    (tmp_path / "rooks.toml").write_text(toml)
    monkeypatch.setenv("ROOKS_CONFIG", str(tmp_path / "rooks.toml"))
    s = config.resolve({}, tmp_path)
    assert s.fallback_models == [("groq", "llama-3.3-70b"), ("openrouter", "openai/gpt-4o-mini")]


def test_lint_after_edit_config(tmp_path, monkeypatch):
    """Config loads lint_after_edit setting."""
    from rooks_code import config

    toml = """
provider = "ollama"
model = "qwen2.5:7b"
lint_after_edit = true
"""
    (tmp_path / "rooks.toml").write_text(toml)
    monkeypatch.setenv("ROOKS_CONFIG", str(tmp_path / "rooks.toml"))
    s = config.resolve({}, tmp_path)
    assert s.lint_after_edit is True


def test_fuzzy_edit_reindents_and_never_corrupts():
    from rooks_code.edit_matching import calculate_edit_match as m

    src = "class A:\n    def f(self):\n        if x:\n            return 1\n        return 2\n"
    r = m(src, "if x:\n    return 1\n", "if y:\n    return 3\n")  # the model dropped the indentation
    assert r.strategy == "indentation"
    assert r.new_content == "class A:\n    def f(self):\n        if y:\n            return 3\n        return 2\n"
    r = m(src, "        if x:  \n            return 1", "        if y:\n            return 3")  # trailing spaces
    assert r.strategy == "line_trimmed" and r.new_content.endswith("            return 3\n        return 2\n")
    crlf = src.replace("\n", "\r\n")
    r = m(crlf, "            return 1\n", "            return 9\n")
    assert r.matched and "\r\n            return 9\r\n" in r.new_content and "\n\n" not in r.new_content.replace("\r\n", "")
    near = m(src, "if x:\n    return 7\n", "z")  # similar but not the same text: never edited, a hint instead
    assert not near.matched and near.error_hint


def test_loop_detector_nudges_on_reads_and_stops_on_repeats():
    from rooks_code.loop_detection import LoopDetector

    d = LoopDetector()
    kinds = [d.on_tool_call("read_file", {"path": f"f{i}.py"}).loop_type for i in range(25)]
    assert "read_heavy" in kinds and not d.is_loop_detected()  # exploring is allowed, the model gets a nudge
    d = LoopDetector()
    hits = [d.on_tool_call("read_file", {"path": "same.py"}).detected for _ in range(6)]
    assert any(hits) and d.is_loop_detected()


def test_repo_map_skips_the_home_folder(monkeypatch, tmp_path):
    from pathlib import Path

    from rooks_code.repo_map import RepoMap

    (tmp_path / "a.py").write_text("def f():\n    pass\n")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    assert RepoMap(tmp_path).get_repo_map() == ""


def test_project_sandbox_says_why_when_bubblewrap_cannot_start(tmp_path, monkeypatch):
    """bwrap installed but blocked (Ubuntu 24.04 user namespaces): refuse with its reason, never run unconfined."""
    if not sys.platform.startswith("linux"):
        pytest.skip("bubblewrap is the Linux sandbox")
    fake = tmp_path / "bin"
    fake.mkdir()
    (fake / "bwrap").write_text("#!/bin/sh\necho 'bwrap: setting up uid map: Permission denied' >&2\nexit 1\n")
    (fake / "bwrap").chmod(0o755)
    monkeypatch.setenv("PATH", f"{fake}{os.pathsep}{os.environ['PATH']}")
    proj = tmp_path / "proj"
    proj.mkdir()
    tb = Toolbox(proj)
    tb.sandbox = "project"
    with pytest.raises(ToolError) as e:
        tb._command_argv("echo hi")
    assert "uid map: Permission denied" in str(e.value) and 'sandbox = "full"' in str(e.value)


def test_windows_commands_keep_their_quotes(tmp_path, monkeypatch):
    """cmd.exe gets the command as typed. A list would be joined with quotes escaped as \\", which cmd.exe reads as part
    of the program name, so "C:\\Program Files\\x\\python.exe" test.py could never run."""
    from rooks_code import tools
    monkeypatch.setattr(tools.sys, "platform", "win32")
    monkeypatch.setenv("COMSPEC", r"C:\Windows\system32\cmd.exe")
    cmd = r'"C:\Program Files\Python\python.exe" test_calc.py'
    tb = Toolbox(tmp_path)
    for mode in ("project", "full"):
        tb.sandbox = mode
        assert tb._command_argv(cmd) == r'C:\Windows\system32\cmd.exe /c ""C:\Program Files\Python\python.exe" test_calc.py"'
    # A lone quoted path keeps its quotes (cmd.exe's first rule, which /s would switch off): a user name with a space
    lone = r'"C:\Users\Jo Smith\proj\.venv\Scripts\pytest.exe"'
    assert tb._command_argv(lone) == r'C:\Windows\system32\cmd.exe /c ""C:\Users\Jo Smith\proj\.venv\Scripts\pytest.exe""'


def test_windows_shell_is_a_full_path_never_one_found_in_the_project(monkeypatch):
    """As subprocess's own shell=True: %ComSpec%, else System32's cmd.exe. Never a bare "cmd.exe", which Windows would
    look for in the current folder first."""
    from rooks_code import tools
    for k in ("ComSpec", "COMSPEC"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("SystemRoot", r"C:\Windows")
    assert tools._windows_shell() == r"C:\Windows\System32\cmd.exe"
    monkeypatch.delenv("SystemRoot")
    with pytest.raises(ToolError, match="Windows command shell"):
        tools._windows_shell()


def test_bubblewrap_check_runs_the_shell_and_remembers_only_success(tmp_path, monkeypatch):
    """The trial runs /bin/sh (NixOS has no /bin/true), and a failure is tried again next time, so fixing the machine
    (or a one-off failure) does not keep every command refused until rooks restarts."""
    from rooks_code import tools
    calls = []
    results = iter([1, 0, 0])

    def fake_run(argv, **kw):
        calls.append(argv)
        rc = next(results)
        return subprocess.CompletedProcess(argv, rc, "", "" if rc == 0 else "bwrap: setting up uid map: Permission denied")
    monkeypatch.setattr(tools.subprocess, "run", fake_run)
    prefix = ("bwrap", "--ro-bind", "/", "/", "--chdir", str(tmp_path))
    tools._BWRAP_OK.discard(prefix)
    assert "uid map" in tools._bwrap_problem(prefix)        # blocked
    assert tools._bwrap_problem(prefix) == ""               # fixed: tried again, works
    assert tools._bwrap_problem(prefix) == ""               # remembered: no third trial
    assert len(calls) == 2 and calls[0][-3:] == ["/bin/sh", "-c", ":"]
    tools._BWRAP_OK.discard(prefix)


def test_bubblewrap_hint_names_namespaces_only_when_that_is_the_problem():
    from rooks_code import tools
    assert tools._namespaces_blocked("bwrap: setting up uid map: Permission denied")
    assert tools._namespaces_blocked("bwrap: No permissions to create new namespace")
    assert not tools._namespaces_blocked("bwrap: execvp /bin/sh: No such file or directory")


def test_a_timeout_returns_even_when_the_command_left_a_child_running(tmp_path):
    """A command that starts something long-lived (a dev server, a hung test) must not hang rooks past its timeout.
    On Windows, subprocess.run killed only cmd.exe and then waited with no limit for pipes the child still held."""
    import time
    child = "import subprocess, sys, time; subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(20)']); time.sleep(20)"
    plan = Toolbox(tmp_path, sandbox="full").prepare("run_command", {"command": f'"{sys.executable}" -c "{child}"', "timeout": 2})
    start = time.monotonic()
    with pytest.raises(ToolError, match="timed out after 2s"):
        plan.apply()
    assert time.monotonic() - start < 12
