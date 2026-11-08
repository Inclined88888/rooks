"""Race (design record 0009): several candidates try one coding task, each in its own copy of the project; a judge
runs their tests; you pick the winner and only then does the real project change.

Every candidate is driven by the scripted fake model in fakes.py over real HTTP; no real model key is used. The tests
check what the race copied, refused, measured, applied and put back, never what the fake model chose: the fake asks for
a write outside its copy, and the test checks that nothing outside changed.
"""

import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

import pytest

from conftest import _can_contain
from fakes import FakeModel, openai_reply

PY = sys.executable
TEST_CMD = f'"{PY}" -m pytest -q -p no:cacheprovider'

GOOD_TEST = "from calc import add\n\n\ndef test_add_negative():\n    assert add(-2, 3) == 1\n"
WEAK_TEST = "def test_nothing():\n    assert True\n"
FIX = ("edit_file", {"path": "calc.py", "old_text": "return a - b", "new_text": "return a + b"})


def _candidate(test_text, fix=True, tokens=(100, 20), name="test_add_neg.py"):
    """A candidate's script: write a test, fix calc.py (or not), finish."""
    script = [openai_reply("", [("write_file", {"path": name, "content": test_text})], tokens=tokens)]
    if fix:
        script.append(openai_reply("", [FIX], tokens=tokens))
    script.append(openai_reply("Done: test written and add() fixed." if fix else "Done: test written.", tokens=tokens))
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
    """The conftest project with a real pytest test file and the project's test command set."""
    (project / "test_calc.py").write_text("from calc import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n")
    cfg = Path(os.environ["ROOKS_CONFIG"])
    cfg.write_text(cfg.read_text() + f"\ntest_command = '{TEST_CMD}'\n")
    return project


def _specs(*servers, briefs=("smallest", "robust", "fastest")):
    from rooks_code import race

    return [race.CandidateSpec(provider="openai-compatible", model="fake-model", base_url=m.url, brief=briefs[i % len(briefs)])
            for i, m in enumerate(servers)]


def _snapshot(root: Path) -> dict:
    out = {}
    for p in root.rglob("*"):
        if p.is_file() and ".rooks" not in p.parts and ".git" not in p.parts:
            out[p.relative_to(root).as_posix()] = p.read_bytes()
    return out


class Yes:
    """A terminal that says yes to one question and remembers what it was asked (the pick's one approval)."""

    conversation_id = None

    def __init__(self, answer="y"):
        self.answer, self.asked, self.said = answer, [], []

    def ask(self, plan):
        self.asked.append(plan)
        return self.answer

    def show_plan(self, plan):
        pass

    def tool_note(self, text, read=False):
        self.said.append(text)

    def warn(self, text):
        self.said.append(text)

    def p(self, text="", err=False):
        self.said.append(text)


# 1 + 4 + 10. three candidates, one proves nothing; nothing changes until the pick; pick applies; /undo restores ----------
def test_three_candidates_race_the_judge_marks_proves_nothing_and_the_project_waits_for_the_pick(calc, fake):
    from rooks_code import race

    a, b, c = fake(_candidate(GOOD_TEST)), fake(_candidate(WEAK_TEST)), fake(_candidate(GOOD_TEST, fix=False))
    before = _snapshot(calc)
    events = []
    r = race.run("make add() handle negative numbers", cwd=calc, candidates=_specs(a, b, c), yes=True, time_limit=120,
                 on_event=events.append)
    assert r.error == "", r.error
    assert [x.status for x in r.candidates] == ["finished", "finished", "finished"], [x.status for x in r.candidates]
    # the real project is untouched: every candidate worked in its own copy under .rooks/race
    assert _snapshot(calc) == before
    for x in r.candidates:
        assert x.copy.is_dir() and x.copy.parent == r.dir and r.dir.parent.parent == calc / ".rooks"
    assert (r.candidates[0].copy / "calc.py").read_text().endswith("a + b\n")
    assert (calc / "calc.py").read_text().endswith("a - b\n")

    # the judge measured, it did not read claims: the weak test passes on base, the third never fixed add()
    s1, s2, s3 = (x.score for x in r.candidates)
    assert s1.proof == "fails first" and s1.proof_ok
    assert s2.proof == "proves nothing" and not s2.proof_ok
    assert s3.proof == "does not pass its own test" and not s3.proof_ok
    assert (s1.others_passed, s1.others_total) == (2, 2)          # c2's assert True and c3's real test both pass on c1
    assert (s2.others_passed, s2.others_total) == (2, 2)          # c2 fixed add() too, so the real tests pass on it
    assert (s3.others_passed, s3.others_total) == (1, 2)          # only the weak test passes on the unfixed c3
    assert s1.project == "2 passed" and s1.project_ok is True
    assert s2.project == "2 passed" and s2.project_ok is True     # a right fix with a vacuous test: proof is what it lacks
    assert s3.project == "2 failed" and s3.project_ok is False, s3.project
    assert s1.full_pass and not s2.full_pass and not s3.full_pass
    assert s1.files == 2 and s1.diff_added >= 6 and s1.diff_removed == 1
    assert s1.tokens == 360 and s1.seconds > 0                   # 3 fake calls of 100 + 20 tokens, measured from receipts
    assert [x.n for x in r.ranked()] == [1, 3, 2]                 # full pass first; proves nothing last
    board = race.scoreboard_text(r)
    assert "proves nothing" in board and "fails first" in board and "2/2" in board and "unknown" in board  # no price for fake-model
    assert "http" not in board and "127.0.0.1" not in board
    assert r.exit_code == 0
    # the stream: a race_start, one candidate_start each, ordinary events carrying the candidate, judge rows, the board
    kinds = [e["type"] for e in events]
    assert kinds[0] == "race_start" and kinds[-1] == "race_end" and kinds.count("candidate_start") == 3
    assert {e.get("candidate") for e in events if e["type"] == "tool_call"} == {1, 2, 3}
    judged = [e for e in events if e["type"] == "judge"]
    assert {e["check"] for e in judged} == {"proof", "cross", "project"} and all("passed" in e for e in judged)
    assert "scoreboard" in kinds
    record = r.dir / "race.json"
    assert record.is_file() and "127.0.0.1" not in record.read_text()

    # the pick applies through the normal edit path: one approval for the whole set, one change set, /undo puts it back
    ui = Yes()
    r.settings.auto_approve = False  # the candidates ran with --yes; the pick is asked about like any change
    said = race.apply(r, 1, settings=r.settings, ui=ui)
    assert "Applied Candidate 1" in said and "2 files" in said, said
    assert len(ui.asked) == 1 and ui.asked[0].effect == "write"
    assert ui.asked[0].summary.startswith("Apply Candidate 1's changes: 2 files"), ui.asked[0].summary
    assert "+++ b/calc.py" in ui.asked[0].preview and "+++ b/test_add_neg.py" in ui.asked[0].preview
    assert (calc / "calc.py").read_text().endswith("a + b\n")
    assert (calc / "test_add_neg.py").read_text() == GOOD_TEST
    assert r.picked == 1
    from rooks_code.undo import ChangeSets

    label, restored = ChangeSets(calc).undo()
    assert label.startswith("race: make add()") and sorted(restored) == ["calc.py", "test_add_neg.py (removed: it was new)"]
    assert _snapshot(calc) == before
    race.drop(r)
    assert not r.dir.exists()


def test_pick_refuses_the_whole_set_when_a_rule_never_allows_one_file_and_when_the_project_moved_on(calc, fake):
    from rooks_code import race

    a = fake(_candidate(GOOD_TEST))
    r = race.run("fix add", cwd=calc, candidates=_specs(a), yes=True, time_limit=120)
    assert r.candidates[0].status == "finished"
    before = _snapshot(calc)
    # a deny rule on one of the two files: nothing partial, the file is named
    s = r.settings
    s.auto_approve = False
    s.deny_rules = ["edit(calc.py)"]
    ui = Yes()
    with pytest.raises(race.RaceError) as e:
        race.apply(r, 1, settings=s, ui=ui)
    assert "calc.py" in str(e.value) and "never allow" in str(e.value) and ui.asked == []
    assert _snapshot(calc) == before
    s.deny_rules = []
    # a no at the one question applies nothing
    with pytest.raises(race.RaceError):
        race.apply(r, 1, settings=s, ui=Yes("n"))
    assert _snapshot(calc) == before
    # the real project changed since the race began: refused and named
    (calc / "calc.py").write_text("def add(a, b):\n    return a * b\n")
    with pytest.raises(race.RaceError) as e:
        race.apply(r, 1, settings=s, ui=Yes())
    assert "calc.py" in str(e.value) and "since the race began" in str(e.value)
    assert (calc / "calc.py").read_text().endswith("a * b\n")
    race.drop(r)


# 1. copies: a git repository's uncommitted edit is in every copy, and in base -----------------------------------------
@pytest.mark.skipif(not __import__("shutil").which("git"), reason="git makes the copies as worktrees")
def test_race_makes_one_copy_per_candidate_plus_base_from_the_working_tree(calc, fake):
    from rooks_code import race

    git = lambda *a: subprocess.run(["git", *a], cwd=calc, capture_output=True, text=True, check=True)  # noqa: E731
    git("init", "-q")
    git("-c", "user.name=t", "-c", "user.email=t@t", "add", "-A")
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "start")
    (calc / "calc.py").write_text("def add(a, b):\n    return a - b  # uncommitted note\n")   # tracked, not committed
    (calc / "notes.txt").write_text("untracked\n")                                           # untracked, not ignored
    (calc / ".env").write_text("SECRET=1\n")                                                 # ignored by the project
    (calc / ".gitignore").write_text(".env\n")
    a, b = fake(_candidate(GOOD_TEST)), fake(_candidate(GOOD_TEST))
    r = race.run("fix add", cwd=calc, candidates=_specs(a, b), yes=True, time_limit=120)
    assert r.error == "", r.error
    for copy in [r.base, *(x.copy for x in r.candidates)]:
        assert (copy / ".git").is_file(), "a worktree's .git names the real repository"
        assert (copy / "notes.txt").read_text() == "untracked\n"
        assert not (copy / ".env").exists()
    assert (r.base / "calc.py").read_text().endswith("# uncommitted note\n")
    assert (r.candidates[0].copy / "calc.py").read_text() == "def add(a, b):\n    return a + b  # uncommitted note\n"
    assert (calc / "calc.py").read_text().endswith("# uncommitted note\n")
    assert r.candidates[0].score.proof == "fails first"
    listed = subprocess.run(["git", "worktree", "list"], cwd=calc, capture_output=True, text=True).stdout
    assert str(r.base) in listed
    race.drop(r)
    listed = subprocess.run(["git", "worktree", "list"], cwd=calc, capture_output=True, text=True).stdout
    assert str(r.dir) not in listed and not r.dir.exists()


# 2. a candidate's file tools stay inside its copy -------------------------------------------------------------------------
def test_a_candidate_cannot_write_outside_its_copy(calc, fake):
    from rooks_code import race

    escape = [openai_reply("", [("write_file", {"path": "../c2/planted.txt", "content": "x\n"})]),
              openai_reply("", [("write_file", {"path": "../../../../calc.py", "content": "def add(a, b):\n    return 0\n"})]),
              openai_reply("", [("edit_file", {"path": "../base/calc.py", "old_text": "a - b", "new_text": "a + b"})]),
              openai_reply("Could not write there.")]
    before = _snapshot(calc)
    r = race.run("fix add", cwd=calc, candidates=_specs(fake(escape), fake(_candidate(GOOD_TEST))), yes=True, time_limit=120)
    c1, c2 = r.candidates
    assert c1.status == "finished"
    assert c1.result.denied == []  # refused as bad arguments before any approval, as every outside path is
    assert not (c2.copy / "planted.txt").exists() and (r.base / "calc.py").read_text().endswith("a - b\n")
    assert _snapshot(calc) == before
    results = [x for x in r.candidates[0].events if x["type"] == "tool_result"]
    assert [x["outcome"] for x in results] == ["bad_args", "bad_args", "bad_args"], results
    assert all("outside the project folder" in x["result"] for x in results)
    assert c1.changed == [] and c1.score.proof == "no proof"
    race.drop(r)


# 3. a candidate's command cannot write the real project or another copy (the command sandbox) --------------------------
@pytest.mark.skipif(not sys.platform.startswith("linux") or not _can_contain(), reason="the Linux sandbox is bubblewrap")
def test_a_candidates_command_cannot_write_the_real_project_or_another_copy(fake, monkeypatch, tmp_path):
    """The sandbox makes only the candidate's copy and the temp folders writable. Pytest's tmp_path is a temp folder,
    so this project lives under the home folder for the test (as test_units' containment test does), and is removed."""
    from rooks_code import race
    import shutil

    home = Path.home() / f".rooks-race-test-{uuid.uuid4().hex[:8]}"
    home.mkdir()
    try:
        (home / "calc.py").write_text("def add(a, b):\n    return a - b\n")
        (home / "test_calc.py").write_text("from calc import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n")
        cfg = tmp_path / "rooks.toml"
        cfg.write_text(f"test_command = '{TEST_CMD}'\n")
        monkeypatch.setenv("ROOKS_CONFIG", str(cfg))
        monkeypatch.setenv("AI_WORKSPACE_APP_FILE", str(tmp_path / "no-app.json"))
        monkeypatch.setenv("ROOKS_DESK_MCP", "0")
        real, other = home / "calc.py", home / ".rooks" / "race"
        # the candidate learns the real paths the way a curious model would: they are in its own path
        script = [
            openai_reply("", [("run_command", {"command": f"echo pwned > '{real}'; echo rc=$?"})]),
            openai_reply("", [("run_command", {"command": "echo pwned > \"$(dirname \"$PWD\")/c2/planted.txt\"; echo rc=$?"})]),
            openai_reply("", [("run_command", {"command": "echo pwned > \"$(dirname \"$PWD\")/base/planted.txt\"; echo rc=$?"})]),
            openai_reply("", [("run_command", {"command": "echo inside > here.txt; echo rc=$?"})]),
            openai_reply("Tried."),
        ]
        r = race.run("fix add", cwd=home, candidates=_specs(fake(script), fake(_candidate(GOOD_TEST))), yes=True, time_limit=120)
        assert r.error == "", r.error
        c1 = r.candidates[0]
        assert c1.status == "finished", c1.status
        outs = [x["result"] for x in c1.events if x["type"] == "tool_result"]
        assert len(outs) == 4, outs
        for out in outs[:3]:
            assert "rc=0" not in out and ("ermission denied" in out or "ead-only" in out), out
        assert "rc=0" in outs[3] and (c1.copy / "here.txt").read_text() == "inside\n"
        assert (real).read_text().endswith("a - b\n")
        assert not (r.candidates[1].copy / "planted.txt").exists() and not (r.base / "planted.txt").exists()
        race.drop(r)
    finally:
        shutil.rmtree(home, ignore_errors=True)


# 6. one cap for the whole race --------------------------------------------------------------------------------------------
def test_the_race_shares_one_cap_and_stops_the_candidate_that_would_cross_it(calc, fake):
    """fake-model is priced at $100 per million input tokens and nothing for output, and the fake reports 3,000 input
    tokens a call, so each call costs $0.30 and the cap's estimate of the next call is about the same. Cap $1.00 for
    the race: three calls fit, the fourth would cross, whichever candidate asks for it."""
    from rooks_code import race

    cfg = Path(os.environ["ROOKS_CONFIG"])
    cfg.write_text(cfg.read_text() + '\n[prices]\n"fake-model" = [100.0, 0.0]\n')
    quick = [openai_reply("Nothing to do.", tokens=(3000, 20))]
    long = [openai_reply("", [("read_file", {"path": "calc.py"})], tokens=(3000, 20)) for _ in range(5)] + [openai_reply("done", tokens=(3000, 20))]
    a, b = fake(quick), fake(long)
    r = race.run("look around", cwd=calc, candidates=_specs(a, b), yes=True, max_usd=1.0, time_limit=120)
    assert r.error == "", r.error
    statuses = [x.status for x in r.candidates]
    assert "stopped: cost cap" in statuses, statuses
    assert r.candidates[0].status in ("finished", "stopped: cost cap")
    calls = len(a.requests) + len(b.requests)
    assert 2 <= calls <= 3, calls                      # never the fourth call
    total = sum(x.score.cost_usd for x in r.candidates)
    assert total == pytest.approx(calls * 0.30) and total < 1.0
    assert race.scoreboard_text(r).count("$") >= 2
    board = race.scoreboard_text(r)
    assert "stopped: cost cap" in board
    race.drop(r)


def test_a_candidate_whose_price_is_unknown_is_said_so_and_the_token_cap_still_holds(calc, fake):
    from rooks_code import race

    long = [openai_reply("", [("read_file", {"path": "calc.py"})], tokens=(1000, 20)) for _ in range(5)] + [openai_reply("done")]
    r = race.run("look around", cwd=calc, candidates=_specs(fake(long)), yes=True, max_usd=1.0, max_tokens=6000, time_limit=120)
    assert r.candidates[0].status == "stopped: token cap", r.candidates[0].status
    assert r.candidates[0].score.cost_usd is None
    assert any("price" in n and "unknown" in n for n in r.notices), r.notices
    race.drop(r)


# 7. a stalled candidate is stopped at the time limit -----------------------------------------------------------------------
@pytest.mark.skipif(sys.platform == "win32", reason="sleep and process groups")
def test_a_stalled_candidate_is_stopped_at_the_time_limit(calc, fake):
    from rooks_code import race

    stall = [openai_reply("", [("run_command", {"command": "sleep 60", "timeout": 600})]), openai_reply("", [("read_file", {"path": "calc.py"})]),
             openai_reply("never reached")]
    t0 = time.monotonic()
    r = race.run("hang", cwd=calc, candidates=_specs(fake(stall), fake(_candidate(GOOD_TEST))), yes=True, time_limit=3)
    took = time.monotonic() - t0
    assert took < 30, took
    c1, c2 = r.candidates
    assert c1.status == "stopped: time", c1.status
    assert c2.status in ("finished", "stopped: time")
    results = [x for x in c1.events if x["type"] == "tool_result"]
    assert results and results[0]["outcome"] == "tool_error" and "time limit" in results[0]["result"], results
    assert len(results) == 1, [x["tool"] for x in results]  # the next model call never happened: the limit stopped it
    assert "stopped: time" in race.scoreboard_text(r)
    race.drop(r)


def test_stop_ends_every_candidate(calc, fake):
    from rooks_code import race

    stall = [openai_reply("", [("run_command", {"command": "sleep 60", "timeout": 600})]), openai_reply("never reached")]
    r = race.Race.prepare("hang", cwd=calc, candidates=_specs(fake(stall), fake(stall)), yes=True, time_limit=120)
    assert r.error == "", r.error
    r.start()
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline and not all(x.events and x.events[-1]["type"] == "tool_call" for x in r.candidates):
        time.sleep(0.05)
    r.stop()
    r.wait()
    assert [x.status for x in r.candidates] == ["stopped", "stopped"], [x.status for x in r.candidates]
    for x in r.candidates:
        kinds = [e["type"] for e in x.events]
        assert kinds[-1] == "candidate_end" and "tool_result" in kinds, kinds
        ended = [e for e in x.events if e["type"] == "tool_result"][0]
        assert ended["outcome"] == "tool_error" and "race was stopped" in ended["result"], ended
    race.drop(r)


# 11. a race writes no memory, skills or chat history -------------------------------------------------------------------------
def test_a_race_writes_no_memory_skills_or_chat_history(calc, fake, tmp_path):
    from rooks_code import race
    from rooks_code import learning

    remember = [openai_reply("", [("remember", {"fact": "the user likes tabs"})]), openai_reply("Noted.")]
    r = race.run("fix add", cwd=calc, candidates=_specs(fake(remember)), yes=True, time_limit=120)
    c = r.candidates[0]
    results = [x for x in c.events if x["type"] == "tool_result"]
    assert results and results[0]["outcome"] == "unknown_tool", results   # remember is not offered to a candidate
    assert "remember" not in {t["name"] for t in c.agent.tool_specs()}
    assert not learning.local_path().exists(), "a race saved a fact to memory.json"
    assert not list(c.copy.glob(".rooks/runs/*.messages.json")), "a candidate saved a conversation to resume"
    assert (c.copy / ".rooks" / "runs").is_dir()  # its receipt is kept, as for any run
    race.drop(r)


def test_a_delegate_candidate_is_refused_at_start_in_plain_words(calc):
    from rooks_code import race

    r = race.run("fix add", cwd=calc, candidates=[race.CandidateSpec(provider="claude-code", model=None, base_url=None, brief="smallest")],
                 yes=True, time_limit=120)
    assert r.exit_code == 2 and "claude-code" in r.error and "Traceback" not in r.error and "http" not in r.error
    assert not (calc / ".rooks" / "race").exists() or not any((calc / ".rooks" / "race").iterdir())
