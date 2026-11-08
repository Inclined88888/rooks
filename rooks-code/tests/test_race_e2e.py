"""Race, the surfaces (design record 0009 sections 2, 5, 6 and 7): the terminal's /race commands with the scoreboard and
the diff view, `rooks race` from the shell (headless -p with json and stream-json, and show, pick and drop on the saved
race), and the terminal's side of the app's race card (the job posted at start and on each change, a pick made in the
app applied here through the normal approval).

Every candidate is driven by the scripted fake model in fakes.py over real HTTP; no real model key is used. Two fake
servers are named as two providers in the config file (fakea, fakeb), so `--models fakea/fake-model,fakeb/fake-model`
gives each candidate its own script. The app is a fake too (FakeApp): it records what the terminal posted and answers
a pick. The tests check what Rooks printed, refused, applied and put back, never what the fake model chose.
"""

import io
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from conftest import PKG
from fakes import FakeModel, openai_reply

SCHEMA = PKG / "rooks_code" / "schema" / "headless.schema.json"
PY = sys.executable
TEST_CMD = f'"{PY}" -m pytest -q -p no:cacheprovider'
GOOD_TEST = "from calc import add\n\n\ndef test_add_negative():\n    assert add(-2, 3) == 1\n"
WEAK_TEST = "def test_nothing():\n    assert True\n"
FIX = ("edit_file", {"path": "calc.py", "old_text": "return a - b", "new_text": "return a + b"})
TASK = "make add() handle negative numbers"


def _candidate(test_text, fix=True, name="test_add_neg.py"):
    script = [openai_reply("", [("write_file", {"path": name, "content": test_text})])]
    if fix:
        script.append(openai_reply("", [FIX]))
    script.append(openai_reply("Done: test written and add() fixed." if fix else "Done: test written."))
    return script


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
def calc(project):
    (project / "test_calc.py").write_text("from calc import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n")
    cfg = Path(os.environ["ROOKS_CONFIG"])
    cfg.write_text(cfg.read_text() + f"\ntest_command = '{TEST_CMD}'\n")
    return project


def two_models(fake, a_script, b_script) -> str:
    """Two fake servers as two providers in the config: the --models value that races one candidate on each."""
    a, b = fake(a_script), fake(b_script)
    cfg = Path(os.environ["ROOKS_CONFIG"])
    cfg.write_text(cfg.read_text() + f'\n[providers.fakea]\nkind = "openai"\nbase_url = "{a.url}"\n'
                                     f'\n[providers.fakeb]\nkind = "openai"\nbase_url = "{b.url}"\n')
    return "fakea/fake-model,fakeb/fake-model"


def _validator(part: str):
    import jsonschema

    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    jsonschema.Draft202012Validator.check_schema(schema)
    return jsonschema.Draft202012Validator({**schema, "$ref": f"#/$defs/{part}"})


def _env(extra=None):
    return {**os.environ, "PYTHONPATH": str(PKG), "NO_COLOR": "1", "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1",
            **(extra or {})}


def shell(project, *args, stdin="", timeout=180, env=None):
    """`rooks race ...` as a process, standard input a pipe."""
    return subprocess.run([PY, "-m", "rooks_code", "race", "-C", str(project), *args], input=stdin, capture_output=True,
                          text=True, encoding="utf-8", env=_env(env), timeout=timeout)


def _snapshot(root: Path) -> dict:
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*")
            if p.is_file() and ".rooks" not in p.parts and ".git" not in p.parts}


# 1. headless: every question denied, exit 3, every stream line validates ------------------------------------------------------
def test_headless_race_denies_every_question_exits_3_and_every_stream_line_validates(calc, fake):
    models = two_models(fake, _candidate(GOOD_TEST), _candidate(WEAK_TEST))
    before = _snapshot(calc)
    r = shell(calc, "-p", "--output-format", "stream-json", "--n", "2", "--models", models, "--time", "2m", TASK)
    assert r.returncode == 3, r.stdout + r.stderr
    check = _validator("event")
    events = []
    for line in r.stdout.splitlines():
        ev = json.loads(line)
        check.validate(ev)
        events.append(ev)
    kinds = [e["type"] for e in events]
    assert kinds[0] == "race_start" and kinds[-1] == "race_end" and kinds.count("race_end") == 1, kinds
    assert kinds.count("candidate_start") == 2 and kinds.count("candidate_end") == 2
    assert {e["candidate"] for e in events if e["type"] in ("tool_call", "approval_asked", "approval_denied")} == {1, 2}
    denied = [e for e in events if e["type"] == "approval_denied"]
    assert denied and all(d["by"] == "headless" for d in denied), denied
    judged = [e for e in events if e["type"] == "judge"]
    assert {e["check"] for e in judged} == {"proof", "cross", "project"}
    assert "scoreboard" in kinds
    end = events[-1]
    assert end["exit_code"] == 3 and end["picked"] is None and len(end["candidates"]) == 2
    assert all(c["score"]["proof"] == "no proof" for c in end["candidates"])  # nothing was written: no test to run
    assert _snapshot(calc) == before
    assert "127.0.0.1" not in r.stdout and "Traceback" not in r.stderr


# 2. headless json: --auto applies the one full pass; without it nothing changes; no full pass exits 1 ---------------------------
def test_headless_race_json_auto_applies_the_one_full_pass_and_undo_puts_it_back(calc, fake):
    models = two_models(fake, _candidate(GOOD_TEST), _candidate(WEAK_TEST))
    before = _snapshot(calc)
    r = shell(calc, "-p", "--yes", "--auto", "--output-format", "json", "--models", models, "--time", "2m", TASK)
    assert r.returncode == 0, r.stdout + r.stderr
    out = json.loads(r.stdout)
    _validator("race_result").validate(out)
    assert out["type"] == "race_result" and out["ok"] is True and out["picked"] == 1
    assert [c["candidate"] for c in out["candidates"]] == [1, 2]
    assert out["candidates"][0]["score"]["proof"] == "fails first" and out["candidates"][1]["score"]["proof"] == "proves nothing"
    assert out["candidates"][0]["result"]["exit_code"] == 0 and out["candidates"][0]["result"]["tokens"]["input"] == 300
    assert (calc / "calc.py").read_text().endswith("a + b\n") and (calc / "test_add_neg.py").read_text() == GOOD_TEST
    assert "127.0.0.1" not in r.stdout
    undo = subprocess.run([PY, "-m", "rooks_code", "undo", "-C", str(calc)], capture_output=True, text=True, env=_env())
    assert "race: make add()" in undo.stdout, undo.stdout
    assert _snapshot(calc) == before

    # without --auto: the race finishes, nothing is applied, the pick waits in the terminal
    models = two_models(fake, _candidate(GOOD_TEST), _candidate(WEAK_TEST))
    r = shell(calc, "-p", "--yes", "--output-format", "json", "--models", models, "--time", "2m", TASK)
    assert r.returncode == 0, r.stdout + r.stderr
    out = json.loads(r.stdout)
    assert out["picked"] is None and _snapshot(calc) == before
    assert "rooks race pick" in out["note"]

    # --auto with no full pass: exit 1 and the reason in plain words
    models = two_models(fake, _candidate(WEAK_TEST), _candidate(GOOD_TEST, fix=False))
    r = shell(calc, "-p", "--yes", "--auto", "--output-format", "json", "--models", models, "--time", "2m", TASK)
    assert r.returncode == 1, r.stdout + r.stderr
    out = json.loads(r.stdout)
    assert out["picked"] is None and "full pass" in out["error"] and _snapshot(calc) == before


def test_headless_race_bad_usage_exits_2_in_plain_words(calc):
    r = shell(calc, "-p", "--output-format", "json")
    assert r.returncode == 2 and json.loads(r.stdout)["exit_code"] == 2 and "task" in json.loads(r.stdout)["error"], r.stdout + r.stderr
    r = shell(calc, "-p", "--models", "claude-code", TASK)
    assert r.returncode == 2 and "claude-code" in r.stderr and "Traceback" not in r.stderr, r.stderr


# 3. the shell: show, pick and drop work on the saved race --------------------------------------------------------------------
def test_race_show_pick_and_drop_from_the_shell_work_on_the_saved_race(calc, fake):
    models = two_models(fake, _candidate(GOOD_TEST), _candidate(WEAK_TEST))
    before = _snapshot(calc)
    r = shell(calc, "-p", "--yes", "--models", models, "--time", "2m", TASK)  # text: the scoreboard on stdout
    assert r.returncode == 0, r.stdout + r.stderr
    assert "fails first" in r.stdout and "proves nothing" in r.stdout and "rooks race pick" in r.stdout, r.stdout
    shown = shell(calc, "show", "1")
    assert shown.returncode == 0 and "+++ b/calc.py" in shown.stdout and "fails first" in shown.stdout, shown.stdout + shown.stderr
    assert "127.0.0.1" not in shown.stdout
    no = shell(calc, "pick", "1", stdin="n\n")
    assert no.returncode == 3 and "you said no" in no.stdout + no.stderr and _snapshot(calc) == before
    yes = shell(calc, "pick", "1", "--yes")
    assert yes.returncode == 0 and "Applied Candidate 1" in yes.stdout, yes.stdout + yes.stderr
    assert (calc / "calc.py").read_text().endswith("a + b\n")
    again = shell(calc, "pick", "1", "--yes")
    assert again.returncode != 0 and "already" in (again.stdout + again.stderr).lower()
    dropped = shell(calc, "drop")
    assert dropped.returncode == 0 and not any((calc / ".rooks" / "race").iterdir())
    gone = shell(calc, "show", "1")
    assert gone.returncode != 0 and "No race" in gone.stderr and "Traceback" not in gone.stderr


# 4. the terminal: /race, the scoreboard, /race show, /race pick, /race drop ------------------------------------------------------
class Yes:
    """The plain terminal with a hand that answers every question y and keeps what it was asked."""

    def __init__(self, answer="y"):
        from rooks_code.cli import UI

        self.out = io.StringIO()
        self.ui = UI(out=self.out, err=self.out, color=False)
        self.answer, self.asked = answer, []
        self.ui.ask = self.ask

    def ask(self, plan):
        self.asked.append(plan)
        return self.answer

    def text(self) -> str:
        return self.out.getvalue()


def _agent(root, provider="fakea"):
    from rooks_code import config
    from rooks_code.agent import Agent

    s = config.resolve({"provider": provider, "model": "fake-model"}, root)
    hand = Yes()
    return Agent(s, hand.ui), hand


def test_slash_race_runs_a_race_and_pick_applies_through_one_approval(calc, fake):
    from rooks_code import tui

    models = two_models(fake, _candidate(GOOD_TEST), _candidate(WEAK_TEST))
    agent, hand = _agent(calc)
    before = _snapshot(calc)
    try:
        tui.command(agent, hand.ui, "/race", f'"{TASK}" --n 2 --models {models} --time 2m')
        said = hand.text()
        assert "2 candidates will try this task, each on its own copy of this folder. Nothing here changes until you pick one." in said, said
        assert "Cap for the whole race:" in said
        # the candidates' questions name their candidate, and one yes covered the same file in every copy
        asked = [p.summary for p in hand.asked]
        assert any(s.startswith("Candidate 1 (") for s in asked) and any(s.startswith("Candidate 2 (") for s in asked), asked
        assert "fails first" in said and "proves nothing" in said and "Candidate" in said
        assert "/race pick N applies one" in said
        assert "http" not in said and "127.0.0.1" not in said and "Traceback" not in said
        assert _snapshot(calc) == before  # nothing changed here: the copies did the work
        hand.out.truncate(0); hand.out.seek(0)
        tui.command(agent, hand.ui, "/race", "show 1")
        assert "+++ b/calc.py" in hand.text() and "Its test on the untouched project" in hand.text(), hand.text()
        hand.asked.clear()
        tui.command(agent, hand.ui, "/race", "pick 1")
        assert len(hand.asked) == 1 and hand.asked[0].summary.startswith("Apply Candidate 1's changes: 2 files"), hand.asked
        assert "Applied Candidate 1" in hand.text() and (calc / "calc.py").read_text().endswith("a + b\n")
        from rooks_code.undo import ChangeSets

        label, _ = ChangeSets(calc).undo()
        assert label.startswith("race: make add()") and _snapshot(calc) == before
        hand.out.truncate(0); hand.out.seek(0)
        tui.command(agent, hand.ui, "/race", "pick 9")
        assert "no candidate 9" in hand.text(), hand.text()
        tui.command(agent, hand.ui, "/race", "drop")
        assert not any((calc / ".rooks" / "race").iterdir())
        hand.out.truncate(0); hand.out.seek(0)
        tui.command(agent, hand.ui, "/race", "show 1")
        assert "No race" in hand.text() and "Traceback" not in hand.text()
        tui.command(agent, hand.ui, "/race", "")
        assert "/race \"task\"" in hand.text()
    finally:
        agent.close()


def test_slash_race_pick_refuses_a_no_and_a_rule_in_the_terminals_words(calc, fake):
    from rooks_code import tui

    models = two_models(fake, _candidate(GOOD_TEST), _candidate(GOOD_TEST))
    agent, hand = _agent(calc)
    before = _snapshot(calc)
    try:
        tui.command(agent, hand.ui, "/race", f'"{TASK}" --models {models} --time 2m')
        hand.answer = "n"
        hand.out.truncate(0); hand.out.seek(0)
        tui.command(agent, hand.ui, "/race", "pick 1")
        assert "you said no" in hand.text() and _snapshot(calc) == before
        agent.s.deny_rules = ["edit(calc.py)"]
        hand.answer = "y"
        hand.out.truncate(0); hand.out.seek(0)
        tui.command(agent, hand.ui, "/race", "pick 2")
        assert "never allow" in hand.text() and "calc.py" in hand.text() and _snapshot(calc) == before
        tui.command(agent, hand.ui, "/race", "drop")
    finally:
        agent.close()


# 5. the app: the race is a job there, and a pick made there is applied here ----------------------------------------------------
class FakeApp:
    """The Rooks app's race routes, enough for the terminal: records every post, answers one pick."""

    def __init__(self):
        self.posts: list[tuple[str, dict]] = []
        self.gets: list[str] = []
        self.picked = None
        self.status = "waiting"
        app = self

        class Handler(BaseHTTPRequestHandler):
            def _send(self, obj, code=200):
                data = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                app.gets.append(self.path)
                if self.path.startswith("/v1/rooks/race/"):
                    return self._send({"id": 7, "status": app.status, "picked": app.picked})
                self._send({"data": []} if self.path.endswith("/models") else {})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                app.posts.append((self.path, {**body, "_auth": self.headers.get("Authorization", "")}))
                if self.path == "/v1/rooks/race":
                    return self._send({"id": 7})
                self._send({"id": 7, "status": app.status, "picked": app.picked})

            def log_message(self, *a, **kw):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()


def test_the_terminal_posts_the_race_to_the_app_and_applies_a_pick_made_there(calc, fake, monkeypatch):
    from rooks_code import race_ui, tui

    app = FakeApp()
    monkeypatch.setenv("WORKBENCH_URL", app.url)
    monkeypatch.setenv("WORKBENCH_API_KEY", "app-key-for-test")
    models = two_models(fake, _candidate(GOOD_TEST), _candidate(WEAK_TEST))
    agent, hand = _agent(calc)
    before = _snapshot(calc)
    try:
        tui.command(agent, hand.ui, "/race", f'"{TASK}" --models {models} --time 2m')
        paths = [p for p, _ in app.posts]
        assert paths[0] == "/v1/rooks/race" and "/v1/rooks/race/7" in paths, paths
        start = app.posts[0][1]
        assert start["task"] == TASK and start["candidates"] == 2
        last = app.posts[-1][1]
        assert last["status"] == "waiting" and len(last["rows"]) == 2, last
        assert last["rows"][0]["proof"] == "fails first" and "+++ b/calc.py" in last["rows"][0]["diff_text"]
        assert all("app-key-for-test" not in json.dumps({k: v for k, v in b.items() if k != "_auth"}) for _, b in app.posts)
        assert _snapshot(calc) == before and agent.race.app_job == 7
        # the person picks in the app; the terminal reads it and applies it here through the normal approval
        app.picked = 1
        hand.asked.clear()
        assert race_ui.check_app_pick(agent, hand.ui) is True
        assert len(hand.asked) == 1 and hand.asked[0].summary.startswith("Apply Candidate 1's changes")
        assert (calc / "calc.py").read_text().endswith("a + b\n") and "Picked in the app" in hand.text()
        done = app.posts[-1][1]
        assert done["status"] == "done" and "Applied Candidate 1" in done["result"], done
        assert race_ui.check_app_pick(agent, hand.ui) is False  # applied once
        tui.command(agent, hand.ui, "/race", "drop")
    finally:
        agent.close()
        app.close()


def test_use_none_in_the_app_ends_the_race_here_and_a_stop_in_the_app_stops_it(calc, fake, monkeypatch):
    from rooks_code import race_ui, tui

    app = FakeApp()
    monkeypatch.setenv("WORKBENCH_URL", app.url)
    monkeypatch.setenv("WORKBENCH_API_KEY", "app-key-for-test")
    models = two_models(fake, _candidate(GOOD_TEST), _candidate(WEAK_TEST))
    agent, hand = _agent(calc)
    before = _snapshot(calc)
    try:
        tui.command(agent, hand.ui, "/race", f'"{TASK}" --models {models} --time 2m')
        app.picked = 0
        assert race_ui.check_app_pick(agent, hand.ui) is True
        assert hand.asked == [] or not any(p.summary.startswith("Apply") for p in hand.asked)
        assert _snapshot(calc) == before and "none" in hand.text().lower()
        assert app.posts[-1][1]["status"] == "done"
        tui.command(agent, hand.ui, "/race", "drop")
    finally:
        agent.close()
        app.close()


# 6. words -------------------------------------------------------------------------------------------------------------------
def test_readme_help_and_changelog_describe_race_in_plain_words():
    from rooks_code import words

    assert "/race" in words.COMMANDS and "/race" in words.GROUPS["Checks"]
    said = words.COMMANDS["/race"]
    assert "candidates" in said and "pick" in said and "http" not in said and "id" not in said.split()
    readme = (PKG / "README.md").read_text(encoding="utf-8")
    for needle in ("/race", "rooks race -p", "/race pick", "/race show", "/race drop", "Use this one", "fails first", "proves nothing"):
        assert needle in readme, needle
    changelog = (PKG.parent / "CHANGELOG.md").read_text(encoding="utf-8")
    assert "/race" in changelog and "test_race_e2e.py" in changelog
