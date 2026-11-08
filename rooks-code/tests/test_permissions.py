"""Permission rules by tool and command pattern, and folder trust for a project's own rules (plan phase 1a).

Allow `pytest *` and deny `rm *`: pytest runs unasked, rm is refused in every mode, echo still asks; `pytest; rm -rf x`
is never matched by `pytest *`; an untrusted project's allow rule is ignored and the terminal says so.

The agent loop and the real `rooks` process are driven by the scripted fake model in fakes.py over real HTTP; no real
model key is used. The tests check what Rooks asked, ran, refused and stored, never what the fake model chose.
"""

import io
import json
import os
import sys
from pathlib import Path

import pytest

from conftest import rooks
from fakes import FakeModel, openai_reply


@pytest.fixture
def fake():
    servers = []

    def make(script):
        servers.append(FakeModel(script))
        return servers[-1]
    yield make
    for s in servers:
        s.close()


@pytest.fixture
def bin_pytest(tmp_path, monkeypatch):
    """A `pytest` on PATH that leaves a mark, so a test sees it really ran."""
    b = tmp_path / "bin"
    b.mkdir()
    mark = tmp_path / "pytest-ran"
    if sys.platform == "win32":
        exe = b / "pytest.cmd"
        exe.write_text(f"@echo ran>> \"{mark}\"\r\n@echo 1 passed\r\n")
    else:
        exe = b / "pytest"
        exe.write_text(f"#!/bin/sh\necho ran >> '{mark}'\necho '1 passed'\n")
        exe.chmod(0o755)
    monkeypatch.setenv("PATH", f"{b}{os.pathsep}{os.environ.get('PATH', '')}")
    return mark


def _settings(project, url, rules=None, **kw):
    from rooks_code import config

    file = {"permissions": rules} if rules is not None else {}
    s = config.resolve({"provider": "openai-compatible", "base_url": url, "model": "fake-model"}, project, file=file)
    s.sandbox, s.learn, s.stream = "full", False, False
    for k, v in kw.items():
        setattr(s, k, v)
    return s


class AskUI:
    """The plain terminal UI writing to buffers; answers each question from a list and records what was asked."""

    def __new__(cls, answers=()):
        from rooks_code.cli import UI

        ui = UI(out=io.StringIO(), err=io.StringIO(), color=False)
        ui.asked, ui.offered_here, queue = [], [], list(answers)

        def ask(plan):
            ui.asked.append(plan.summary)
            ui.offered_here.append(bool(getattr(plan, "here", False)))
            return queue.pop(0) if queue else "n"
        ui.ask = ask
        return ui


def _run_commands(fake, project, commands, answers=(), rules=None, **kw):
    from rooks_code.agent import Agent

    m = fake([openai_reply("", [("run_command", {"command": c})]) for c in commands] + [openai_reply("done")])
    ui = AskUI(answers)
    agent = Agent(_settings(project, m.url, rules, **kw), ui)
    try:
        agent.run("go")
    finally:
        agent.close()
    return agent, ui, m


RULES = {"allow": ["bash(pytest *)"], "deny": ["bash(rm *)"]}


# 1. allow pytest, deny rm, echo still asks -----------------------------------------------------------------------------
def test_allowed_command_runs_unasked_denied_one_is_refused_and_others_still_ask(project, fake, bin_pytest):
    (project / "x").mkdir()
    agent, ui, m = _run_commands(fake, project, ["pytest -q", "rm -rf x", "echo hi"], answers=["y", "y", "y"], rules=RULES)
    assert ui.asked == ["run: echo hi"], ui.asked          # pytest unasked, rm never even asked, echo asked
    assert bin_pytest.read_text() == "ran\n"               # pytest really ran
    assert (project / "x").is_dir()                        # rm did not
    assert agent.denials == 1
    results = [x["content"] for x in m.requests[2]["body"]["messages"] if x.get("role") == "tool"]
    assert "never allow" in results[-1], results            # the model is told plainly, so it does not retry
    rows = [json.loads(line) for f in (project / ".rooks" / "runs").glob("*.jsonl") for line in f.read_text().splitlines()]
    assert any(r["kind"] == "tool_call" and r["outcome"] == "denied" and "rm" in r["args"] for r in rows)


@pytest.mark.parametrize("mode", ["asks first", "auto-accept", "trusted folder", "dry run", "allow everything"])
def test_a_deny_rule_refuses_in_every_mode(project, fake, mode):
    """Deny wins over allow and applies in auto-accept (--yes, /auto, Shift+Tab), a trusted folder and a dry run."""
    (project / "x").mkdir()
    rules = dict(RULES)
    kw = {}
    if mode == "auto-accept":
        kw["auto_approve"] = True
    elif mode == "trusted folder":
        kw["trusted_folders"] = [str(project)]
    elif mode == "dry run":
        kw["dry_run"] = True
    elif mode == "allow everything":
        rules = {"allow": ["bash(*)"], "deny": ["bash(rm *)"]}
    for cmd in ("rm -rf x", "/bin/rm -rf x", "sudo rm -rf x", "echo ok && rm -rf x", "echo $(rm -rf x)", "echo `rm -rf x`",
                "bash -c 'rm -rf x'", "r\\m -rf x", "'rm' -rf x", "env A=1 rm -rf x", "if true; then rm -rf x; fi"):
        agent, ui, _ = _run_commands(fake, project, [cmd], answers=["y"], rules=rules, **kw)
        assert ui.asked == [], (mode, cmd, ui.asked)
        assert agent.denials == 1, (mode, cmd)
        assert (project / "x").is_dir(), (mode, cmd)
        assert "permission rule" in ui.out.getvalue(), ui.out.getvalue()


def test_a_command_hard_to_read_is_asked_about_even_in_auto_accept_when_deny_rules_exist(project, fake):
    """`$CMD -rf x` could be rm: with deny rules, auto-accept never runs it silently. Without deny rules it changes
    nothing (auto-accept runs it as before)."""
    agent, ui, _ = _run_commands(fake, project, ["X=rm; $X -rf nothing"], answers=["n"], rules=RULES, auto_approve=True)
    assert ui.asked == ["run: X=rm; $X -rf nothing"], ui.asked
    assert "hard to read" in ui.out.getvalue()
    agent, ui, _ = _run_commands(fake, project, ["echo $HOME"], answers=[], rules={}, auto_approve=True)
    assert ui.asked == []


# 2. compound commands never match unless every part does ---------------------------------------------------------------
def test_a_compound_command_never_matches_an_allow_rule_unless_every_part_does(project, fake, bin_pytest, tmp_path):
    allow = {"allow": ["bash(pytest *)", "bash(echo ok)"]}
    sneaky = ["pytest; rm -rf x", "pytest && curl http://example.invalid", "pytest || touch y", "pytest | sh",
              "pytest $(touch y)", "pytest `touch y`", "pytest > out.txt", "pytest >> out.txt", "pytest\ntouch y",
              "pytest & touch y", "PATH=. pytest", "LD_PRELOAD=x.so pytest", "pytest <(touch y)", "(pytest)",
              "pytest; echo ok; touch y", "./pytest", "sudo pytest", "pytest < secret.txt"]
    agent, ui, _ = _run_commands(fake, project, ["pytest -q", *sneaky], answers=["n"] * len(sneaky), rules=allow)
    assert ui.asked == [f"run: {c}" for c in sneaky], ui.asked
    assert bin_pytest.read_text() == "ran\n"  # only the plain one ran
    assert not (project / "y").exists() and not (project / "out.txt").exists()

    # every part allowed: runs unasked; harmless redirects to the terminal or nowhere are fine
    fine = ["pytest; echo ok", "pytest -q && echo ok", "pytest 2>&1", "pytest > /dev/null 2>&1", "pytest"]
    agent, ui, _ = _run_commands(fake, project, fine, rules=allow)
    assert ui.asked == [], ui.asked


def test_the_rule_matcher_reads_quotes_like_the_shell(project):
    from rooks_code import permissions

    p = permissions.Permissions(user_allow=["bash(pytest *)", "bash(git commit *)"], user_deny=["bash(rm *)"], root=project)
    assert p.check_command('pytest -k "a; b"').verdict == "allow"            # one quoted argument, not two commands
    assert p.check_command('git commit -m "rm stuff"').verdict == "allow"    # rm inside a message is not rm
    assert p.check_command("pytest; rm -rf x").verdict == "deny"
    assert p.check_command("pytest; echo hi").verdict == "ask"
    assert p.check_command("pytest 'unterminated").verdict != "allow"
    assert p.check_command("pytesting").verdict == "ask"                    # "pytest *" is pytest and its arguments
    assert p.check_command("rmdir x").verdict == "ask"                      # "rm *" is not rmdir


# 3. folder trust ------------------------------------------------------------------------------------------------------
def _project_rules(project, allow=(), deny=()):
    (project / ".rooks").mkdir(exist_ok=True)
    (project / ".rooks" / "settings.json").write_text(json.dumps({"permissions": {"allow": list(allow), "deny": list(deny)}}))


def test_an_untrusted_projects_allow_rules_are_ignored_and_it_says_so_but_its_deny_rules_apply(project, fake):
    from rooks_code import tui

    _project_rules(project, allow=["bash(echo *)"], deny=["bash(touch *)"])
    agent, ui, _ = _run_commands(fake, project, ["echo hi", "touch y"], answers=["n", "y"], rules={})
    assert ui.asked == ["run: echo hi"], ui.asked           # the project's allow rule is ignored
    assert not (project / "y").exists()                   # its deny rule applies all the same
    said = ui.err.getvalue()
    assert "ignored" in said and "trust" in said, said
    assert "bash(" not in said and "http" not in said     # plain words

    # the person trusts the folder (/permissions trust): from then on its allow rules apply, keyed by its real path
    tui.command(agent, ui, "/permissions", "trust")
    link = project.parent / "same-project"
    link.symlink_to(project, target_is_directory=True)
    agent, ui, _ = _run_commands(fake, link, ["echo hi"], rules={})
    assert ui.asked == [], ui.asked
    assert "ignored" not in ui.err.getvalue()

    tui.command(agent, ui, "/permissions", "untrust")
    agent, ui, _ = _run_commands(fake, project, ["echo hi"], answers=["n"], rules={})
    assert ui.asked == ["run: echo hi"]


def test_the_trust_question_is_asked_once_and_stored_by_real_path(project, tmp_path):
    from rooks_code import config, permissions

    _project_rules(project, allow=["bash(npm test)"])
    said = []
    assert permissions.ask_trust(project, ask=lambda _: "y", say=said.append) is True
    text = "\n".join(said)
    assert "npm test" in text and "trust" in text, text
    store = json.loads((config.config_path().parent / "rooks-trust.json").read_text())
    assert os.path.realpath(project) in store["folders"]
    assert permissions.ask_trust(project, ask=lambda _: pytest.fail("asked twice"), say=said.append) is True

    other = tmp_path / "cloned"
    other.mkdir()
    _project_rules(other, allow=["bash(*)"])
    assert permissions.ask_trust(other, ask=lambda _: "n", say=said.append) is False
    assert permissions.ask_trust(other, ask=lambda _: pytest.fail("asked twice"), say=said.append) is False
    assert permissions.Permissions([], [], other).check_command("anything").verdict == "ask"


# 4. "always allow this command here" ----------------------------------------------------------------------------------
def test_always_allow_here_writes_one_precise_rule_for_the_trusted_project(project, fake):
    from rooks_code import permissions

    permissions.set_folder_trust(project, True)
    agent, ui, _ = _run_commands(fake, project, ["echo hi && echo 'a *'"], answers=["h"], rules={})
    assert ui.offered_here == [True]
    saved = json.loads((project / ".rooks" / "settings.json").read_text())["permissions"]["allow"]
    assert saved == ["bash(echo hi)", "bash(echo a \\*)"], saved   # one exact rule per part; a star is kept literal
    agent, ui, _ = _run_commands(fake, project, ["echo hi && echo 'a *'", "echo a b", "echo hi; touch y"], answers=["n", "n"],
                                 rules={})
    assert ui.asked == ["run: echo a b", "run: echo hi; touch y"], ui.asked

    # not offered where the folder is not trusted, nor for a command that cannot be pinned down exactly
    permissions.set_folder_trust(project, False)
    agent, ui, _ = _run_commands(fake, project, ["echo bye"], answers=["n"], rules={})
    assert ui.offered_here == [False]
    permissions.set_folder_trust(project, True)
    agent, ui, _ = _run_commands(fake, project, ["echo $(date)"], answers=["n"], rules={})
    assert ui.offered_here == [False]


def test_the_question_offers_always_here_in_plain_words(project, monkeypatch):
    from rooks_code.cli import UI
    from rooks_code.tools import Plan

    plan = Plan("command", "run: echo hi", "", lambda: ("", None, ""))
    plan.scope, plan.here = "command", True
    out = io.StringIO()
    monkeypatch.setattr("sys.stdin", io.StringIO("h\n"))
    assert UI(out=out, err=io.StringIO(), color=False).ask(plan) == "h"
    assert "[h] Always allow this command in this folder" in out.getvalue(), out.getvalue()
    plan.here = False
    monkeypatch.setattr("sys.stdin", io.StringIO("h\nn\n"))
    out = io.StringIO()
    assert UI(out=out, err=io.StringIO(), color=False).ask(plan) == "n"   # h is not a choice here


# 5. /permissions -------------------------------------------------------------------------------------------------------
def test_permissions_command_shows_the_rules_in_plain_words(project, fake):
    from rooks_code import tui
    from rooks_code.agent import Agent

    _project_rules(project, allow=["bash(npm test)"], deny=["edit(secrets/**)"])
    m = fake([openai_reply("done")])
    ui = AskUI()
    agent = Agent(_settings(project, m.url, {"allow": ["bash(pytest *)", "mcp(notes/search)", "edit(src/**)"],
                                             "deny": ["bash(rm *)", "nonsense("]}), ui)
    tui.command(agent, ui, "/permissions", "")
    out = ui.out.getvalue()
    agent.close()
    for want in ("pytest", "rm", "npm test", "src", "secrets", "notes", "search", "Never", "without asking", "ignored",
                 "not understood"):
        assert want in out, (want, out)
    assert "bash(" not in out and "edit(" not in out, out


# 6. edits and extra tools ---------------------------------------------------------------------------------------------
def test_edit_and_mcp_rules(project, fake):
    from rooks_code.agent import Agent

    (project / "src").mkdir()
    (project / "secrets").mkdir()
    server = Path(__file__).with_name("fake_mcp_server.py")
    m = fake([openai_reply("", [("write_file", {"path": "src/a.py", "content": "x = 1\n"})]),
              openai_reply("", [("write_file", {"path": "secrets/key.txt", "content": "k\n"})]),
              openai_reply("", [("write_file", {"path": "README.md", "content": "hi\n"})]),
              openai_reply("", [("mcp__fake__shout", {"text": "a"})]),
              openai_reply("done")])
    ui = AskUI(["n"])
    rules = {"allow": ["edit(src/**)", "edit(secrets/**)", "mcp(fake/shout)"], "deny": ["edit(secrets/**)"]}
    agent = Agent(_settings(project, m.url, rules, auto_approve=False,
                            mcp_servers={"fake": {"command": sys.executable, "args": [str(server)]}}), ui)
    agent.run("go")
    agent.close()
    assert ui.asked == ["created README.md"], ui.asked
    assert (project / "src" / "a.py").read_text() == "x = 1\n"
    assert not (project / "secrets" / "key.txt").exists()


# 7. the real terminal -------------------------------------------------------------------------------------------------
def test_rooks_with_yes_refuses_a_denied_command_and_exits_non_zero(project, fake, tmp_path):
    (project / "x").mkdir()
    cfg = Path(os.environ["ROOKS_CONFIG"])
    cfg.write_text(cfg.read_text() + '\n[permissions]\ndeny = ["bash(rm *)"]\n')
    m = fake([openai_reply("", [("run_command", {"command": "rm -rf x"})]), openai_reply("I could not remove it.")])
    r = rooks(project, "-P", "openai-compatible", "--base-url", m.url, "-m", "fake-model", "--yes", "remove x")
    assert r.returncode == 3, r.stdout + r.stderr
    assert (project / "x").is_dir()
    assert "permission rule" in r.stdout, r.stdout


def test_rooks_says_an_untrusted_projects_allow_rules_are_ignored(project, fake):
    _project_rules(project, allow=["bash(echo *)"])
    m = fake([openai_reply("", [("run_command", {"command": "echo hi"})]), openai_reply("ok")])
    r = rooks(project, "-P", "openai-compatible", "--base-url", m.url, "-m", "fake-model", "say hi", stdin="n\n")
    assert r.returncode == 3, r.stdout + r.stderr          # asked, the answer was no
    assert "Needs your OK: run this command." in r.stdout
    assert "ignored" in r.stderr and "trust" in r.stderr, r.stderr


# 8. the agent cannot grant itself a rule ------------------------------------------------------------------------------
def test_the_agent_never_changes_rooks_own_rule_files_unasked(project, fake):
    """An allow rule for every edit, auto-accept and a trusted folder still never let the agent write the folder's
    .rooks/settings.json unasked: otherwise it could allow itself anything from the next session on. The file tools
    refuse .rooks outright; a command naming the file is asked about in every mode."""
    from rooks_code.agent import Agent

    grant = json.dumps({"permissions": {"allow": ["bash(*)"]}})
    m = fake([openai_reply("", [("write_file", {"path": ".rooks/settings.json", "content": grant})]),
              openai_reply("", [("run_command", {"command": f"mkdir -p .rooks && echo '{grant}' > .rooks/settings.json"})]),
              openai_reply("", [("write_file", {"path": "src/ok.py", "content": "x = 1\n"})]),
              openai_reply("done")])
    ui = AskUI(["n"])
    agent = Agent(_settings(project, m.url, {"allow": ["edit(**)", "bash(*)"]}, auto_approve=True,
                            trusted_folders=[str(project)]), ui)
    agent.run("go")
    agent.close()
    assert ui.asked == [f"run: mkdir -p .rooks && echo '{grant}' > .rooks/settings.json"], ui.asked
    assert not (project / ".rooks" / "settings.json").exists()
    assert (project / "src" / "ok.py").exists()             # an ordinary edit still runs unasked
    assert "own permission settings" in ui.out.getvalue()


# 9. what a review found: deny rules and the own-files guard read commands the way the shell does -----------------------
@pytest.mark.parametrize("cmd", ["echo 'rm -rf x' | bash -s", "echo 'rm -rf x' | sh -e", "echo 'rm -rf x' | sh -",
                                 "X='rm -rf x'; bash -c \"$X\"", "script -qc 'rm -rf x' /dev/null",
                                 "bash -c '{rm,-rf,x}'", "unshare -r rm -rf x", "su -c 'rm -rf x' root",
                                 "$'rm' -rf x", "X=rm; sudo $X -rf x", "bash -c -- 'rm -rf x'"])
def test_shell_tricks_never_slip_past_a_deny_rule_in_auto_accept(project, fake, cmd):
    """Each of these runs `rm -rf x` (or could): with a deny rule for rm, auto-accept refuses it or asks first."""
    (project / "x").mkdir()
    agent, ui, _ = _run_commands(fake, project, [cmd], answers=["n"], rules=RULES, auto_approve=True)
    assert ui.asked or agent.denials == 1, (cmd, ui.asked, agent.denials)
    assert (project / "x").is_dir(), cmd


def test_the_matcher_sees_through_more_wrappers_and_shells(project):
    from rooks_code import permissions

    p = permissions.Permissions(user_allow=[], user_deny=["bash(rm *)"], root=project)
    for cmd in ("busybox rm -rf x", "fakeroot rm -rf x", "unshare -r rm -rf x", "su -c 'rm -rf x' root",
                "su root -c 'rm -rf x'", "script --command='rm -rf x' /dev/null", "busybox sh -c 'rm -rf x'",
                "timeout 5 bash -lc 'rm -rf x'", "pkexec rm -rf x"):
        assert p.check_command(cmd).verdict == "deny", cmd
    for cmd in ("echo 'rm -rf x' | bash -s", "echo 'rm -rf x' | sudo bash", "echo 'rm -rf x' | busybox sh",
                "echo 'rm -rf x' | su", "echo 'rm -rf x' | sudo -s", "timeout 5 $X -rf x", "bash -c \"$X\"",
                "bash -c '{rm,-rf,x}'", "{rm,-rf,x}", "$'rm' -rf x", "echo 'rm -rf x' | script -q /dev/null"):
        assert p.check_command(cmd).verdict in ("deny", "unclear"), cmd
    # ordinary commands are not made hard to read
    for cmd in ("bash script.sh", "bash -c 'pytest -q'", "echo {a,b}", "sudo -u bob pytest", "git status"):
        assert p.check_command(cmd).verdict == "ask", cmd


@pytest.mark.parametrize("deny", [["bash(rm *)"], []])
def test_a_command_reaching_rooks_own_rule_files_is_asked_however_it_is_spelled(project, deny):
    from rooks_code import permissions

    p = permissions.Permissions(user_allow=["bash(*)"], user_deny=deny, root=project)
    for cmd in ("printf '{}' > .rooks/set''tings.json", "cd .rooks && cp /tmp/evil settings.json",
                "tee .rooks/sett\\ings.json", "sed -i s/deny/xx/ ~/.config/ai-workspace/rook''s.toml",
                "bash -c 'cp x .rooks/sett\"\"ings.json'", "D=.rooks; cp x $D/settings.json",
                "cp x ./.rooks//settings.json", "cd ~/.config/ai-workspace && cp x rooks-trust.json", "cd ~/.config/ai-workspace && cp x ./trust"):
        d = p.check_command(cmd)
        assert d.verdict == "unclear" and d.why == permissions.OWN_SETTINGS, (cmd, d)
    for cmd in ("cd rooks-code && pytest", "git status", "cat README.md"):
        assert p.check_command(cmd).verdict == "allow", cmd


def test_auto_accept_never_writes_itself_a_rule_by_splitting_the_name(project, fake):
    (project / ".rooks").mkdir()
    cmd = "printf '{\"permissions\":{\"allow\":[\"bash\"]}}' > .rooks/set''tings.json"
    agent, ui, _ = _run_commands(fake, project, [cmd], answers=["n"], rules=RULES, auto_approve=True)
    assert ui.asked == [f"run: {cmd}"], ui.asked
    assert not (project / ".rooks" / "settings.json").exists()


def test_always_allow_here_is_not_offered_where_trust_would_switch_on_skills_or_commands(project, fake):
    """Choosing h trusts the folder, which turns on its own skills and commands: so it is offered only where trusting
    turns on nothing the person has not seen (the trust question lists them)."""
    from rooks_code import permissions

    (project / ".rooks" / "commands").mkdir(parents=True)
    (project / ".rooks" / "commands" / "deploy.md").write_text("Deploy it.\n")
    assert permissions.folder_trust(project) is None
    assert permissions.Permissions([], [], project).can_remember_here("npm test") is False
    agent, ui, _ = _run_commands(fake, project, ["echo hi"], answers=["n"], rules={})
    assert ui.offered_here == [False]
    assert permissions.folder_trust(project) is None
    (project / ".rooks" / "commands" / "deploy.md").unlink()
    skill = project / ".claude" / "skills" / "tests"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: tests\ndescription: run the tests\n---\n\nRun them.\n")
    assert permissions.Permissions([], [], project).can_remember_here("npm test") is False
    skill.joinpath("SKILL.md").unlink()
    assert permissions.Permissions([], [], project).can_remember_here("npm test") is True  # nothing else to turn on
