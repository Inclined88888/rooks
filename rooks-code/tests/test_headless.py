"""Headless runs for scripts and CI (plan phase 1a): `rooks -p`, a piped task, --output-format text|json|stream-json,
exit codes, and rooks_code/sdk.py in process.

The real `rooks` process (and sdk.run in this process) is driven by the scripted fake model in fakes.py over real
HTTP; no real model key is used. The tests check what Rooks asked, ran, refused, printed and stored, never what the
fake model chose: the fake model asks for a change, and the test checks that nobody was waited on and nothing changed.
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from conftest import PKG
from fakes import FakeModel, openai_reply

SCHEMA = PKG / "rooks_code" / "schema" / "headless.schema.json"
EDIT = openai_reply("", [("edit_file", {"path": "calc.py", "old_text": "return a - b", "new_text": "return a + b"})])
FIX = [
    openai_reply("Looking around.", [("list_files", {"path": "."})]),
    openai_reply("", [("read_file", {"path": "calc.py"})]),
    EDIT,
    openai_reply("", [("run_command", {"command": f'"{sys.executable}" test_calc.py'})]),
    openai_reply("Fixed add(): it subtracted. test_calc.py now passes.", tokens=(300, 15)),
]


@pytest.fixture
def fake():
    servers = []

    def make(script):
        servers.append(FakeModel(script))
        return servers[-1]
    yield make
    for s in servers:
        s.close()


def _validator(part: str):
    """A validator for one part of the schema file in the repo: "result" (json output) or "event" (one stream line)."""
    import jsonschema

    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    jsonschema.Draft202012Validator.check_schema(schema)
    return jsonschema.Draft202012Validator({**schema, "$ref": f"#/$defs/{part}"})


def _env(extra=None):
    return {**os.environ, "PYTHONPATH": str(PKG), "NO_COLOR": "1", "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1",
            **(extra or {})}


def _argv(project, m, *args):
    return [sys.executable, "-m", "rooks_code", "-C", str(project), "-P", "openai-compatible", "--base-url", m.url,
            "-m", "fake-model", *args]


def headless(project, m, *args, stdin=None, timeout=60):
    """Run rooks with stdin a pipe (stdin text, or closed at once when None)."""
    return subprocess.run(_argv(project, m, *args), input=stdin or "", capture_output=True, text=True, encoding="utf-8",
                          env=_env(), timeout=timeout)


def _receipts(project):
    return sorted((project / ".rooks" / "runs").glob("*.jsonl"))


def _allow(rule: str):
    cfg = Path(os.environ["ROOKS_CONFIG"])
    cfg.write_text(cfg.read_text() + f'\n[permissions]\nallow = ["{rule}"]\n')


# 1. a script pipes a task and parses JSON --------------------------------------------------------------------------
def test_a_piped_task_gives_one_json_result_a_script_can_parse(project, fake):
    m = fake([openai_reply("", [("read_file", {"path": "calc.py"})]),
              openai_reply("calc.py defines add(), which subtracts.", tokens=(120, 30))])
    r = headless(project, m, "-p", "--output-format", "json", stdin="Which file defines add()?\n")
    assert r.returncode == 0, r.stdout + r.stderr
    out = json.loads(r.stdout)  # the whole of stdout is one JSON object
    _validator("result").validate(out)
    assert out["type"] == "result" and out["exit_code"] == 0 and out["ok"] is True
    assert out["result"] == "calc.py defines add(), which subtracts."
    assert out["denied"] == [] and out["turns"] == 2
    assert out["tokens"] == {"input": 220, "output": 50, "cache_read": 0, "cache_write": 0}
    assert out["session_id"] == _receipts(project)[0].stem  # the receipt in .rooks/runs has the same name
    first = m.requests[0]["body"]["messages"]
    assert any("Which file defines add()?" in str(x.get("content")) for x in first if x["role"] == "user")


@pytest.mark.skipif(os.name != "posix", reason="a POSIX shell pipeline")
def test_a_shell_script_pipes_a_task_parses_json_and_sees_exit_3_on_a_denial(project, fake, tmp_path):
    m = fake([EDIT, openai_reply("I could not change calc.py.")])
    script = tmp_path / "ci.sh"
    script.write_text(
        'printf "fix the add function" | "$PY" -m rooks_code -C "$DIR" -P openai-compatible --base-url "$URL" '
        '-m fake-model -p --output-format json > "$OUT"\n'
        'code=$?\n'
        '"$PY" -c "import json,sys; d=json.load(open(sys.argv[1])); print(d[\'exit_code\'], len(d[\'denied\']))" "$OUT"\n'
        'exit $code\n')
    r = subprocess.run(["sh", str(script)], capture_output=True, text=True, timeout=60,
                       env=_env({"PY": sys.executable, "DIR": str(project), "URL": m.url, "OUT": str(tmp_path / "o.json")}))
    assert r.returncode == 3, r.stdout + r.stderr
    assert r.stdout.split() == ["3", "1"], r.stdout + r.stderr
    assert (project / "calc.py").read_text().endswith("a - b\n")


# 2. -p never waits for input ----------------------------------------------------------------------------------------
def test_p_never_waits_for_input_even_while_stdin_stays_open(project, fake, tmp_path):
    """A change that needs an OK, and a stdin pipe that is never written to nor closed: a one-shot run would wait
    forever for the answer. -p must deny it at once, say so, and exit 3."""
    m = fake([openai_reply("", [("write_file", {"path": "made.txt", "content": "x\n"})]),
              openai_reply("", [("run_command", {"command": "echo made > made2.txt"})]),
              openai_reply("I could not make the files.")])
    out, err = tmp_path / "out", tmp_path / "err"
    with open(out, "w") as o, open(err, "w") as e:
        p = subprocess.Popen(_argv(project, m, "-p", "make two files"), stdin=subprocess.PIPE, stdout=o, stderr=e,
                             env=_env())
        try:
            code = p.wait(timeout=30)
        except subprocess.TimeoutExpired:
            p.kill()
            pytest.fail("rooks -p waited for input")
        finally:
            p.stdin.close()
    assert code == 3, out.read_text() + err.read_text()
    assert not (project / "made.txt").exists() and not (project / "made2.txt").exists()
    assert out.read_text().strip() == "I could not make the files."  # text mode: stdout is the answer only
    said = err.read_text()
    assert said.count("Not done: nobody can answer") == 2, said
    assert "Needs your OK" not in out.read_text() + said  # never asked as if someone could answer


@pytest.mark.skipif(os.name != "posix", reason="closing file descriptor 0 in the child")
def test_p_runs_with_stdin_closed(project, fake):
    m = fake([EDIT, openai_reply("Left it.")])
    t0 = time.monotonic()
    r = subprocess.run(_argv(project, m, "-p", "--output-format", "json", "fix add"), capture_output=True, text=True,
                       env=_env(), timeout=30, preexec_fn=lambda: os.close(0))
    assert time.monotonic() - t0 < 30
    assert r.returncode == 3, r.stdout + r.stderr
    out = json.loads(r.stdout)
    assert out["exit_code"] == 3 and [d["tool"] for d in out["denied"]] == ["edit_file"]


# 3. a denial gives exit 3 --------------------------------------------------------------------------------------------
def test_a_denial_exits_3_and_json_says_what_was_denied_and_why(project, fake):
    m = fake([EDIT, openai_reply("OK, I will leave it.")])
    r = headless(project, m, "-p", "--output-format", "json", "fix add")
    assert r.returncode == 3, r.stdout + r.stderr
    out = json.loads(r.stdout)
    _validator("result").validate(out)
    assert out["exit_code"] == 3 and out["ok"] is False
    assert out["denied"] == [{"tool": "edit_file", "summary": "edit calc.py", "by": "headless"}], out["denied"]
    assert (project / "calc.py").read_text().endswith("a - b\n")
    rows = [json.loads(x) for x in _receipts(project)[0].read_text().splitlines()]
    assert any(x["kind"] == "decision" and x["outcome"] == "denied" for x in rows)


def test_a_permission_rule_denial_with_yes_exits_3_and_yes_alone_still_runs(project, fake):
    cfg = Path(os.environ["ROOKS_CONFIG"])
    base = cfg.read_text()
    cfg.write_text(base + '\n[permissions]\ndeny = ["edit(calc.py)"]\n')
    m = fake([EDIT, openai_reply("Not allowed.")])
    r = headless(project, m, "-p", "--yes", "--output-format", "json", "fix add")
    assert r.returncode == 3, r.stdout + r.stderr
    assert [d["by"] for d in json.loads(r.stdout)["denied"]] == ["rule"]
    cfg.write_text(base)
    m = fake([EDIT, openai_reply("Fixed.")])
    r = headless(project, m, "-p", "--yes", "--output-format", "json", "fix add")
    assert r.returncode == 0, r.stdout + r.stderr  # --yes is the explicit way to let a headless run change things
    assert (project / "calc.py").read_text().endswith("a + b\n")


# 4. every stream-json line validates ---------------------------------------------------------------------------------
def test_every_stream_json_line_validates_against_the_schema_file(project, fake):
    _allow("bash(echo *)")
    m = fake([openai_reply("Reading first.", [("read_file", {"path": "calc.py"})]),
              EDIT,
              openai_reply("", [("run_command", {"command": "echo checked"})]),
              openai_reply("Could not fix it: the change was not allowed.")])
    r = headless(project, m, "-p", "--output-format", "stream-json", "fix add")
    assert r.returncode == 3, r.stdout + r.stderr
    check = _validator("event")
    lines = r.stdout.splitlines()
    events = []
    for line in lines:
        ev = json.loads(line)  # every line of stdout is one JSON object
        check.validate(ev)
        events.append(ev)
    types = [e["type"] for e in events]
    assert types[0] == "start" and types[-1] == "end" and types.count("end") == 1, types
    assert types.count("tool_call") == 3 and types.count("tool_result") == 3, types
    assert types.index("approval_asked") < types.index("approval_denied"), types
    calls = {e["id"]: e for e in events if e["type"] == "tool_call"}
    results = [e for e in events if e["type"] == "tool_result"]
    assert [calls[e["id"]]["tool"] for e in results] == ["read_file", "edit_file", "run_command"]
    assert [e["outcome"] for e in results] == ["ok", "denied", "ok"], results
    assert "checked" in results[2]["result"]
    assert any(e["type"] == "assistant" and e["final"] and "Could not fix it" in e["text"] for e in events)
    start, end = events[0], events[-1]
    assert start["session_id"] == end["session_id"] == _receipts(project)[0].stem
    assert end["exit_code"] == 3 and end["denied"][0]["by"] == "headless"


def test_stream_json_hides_a_key_a_command_printed(project, fake):
    """Secrets never go in logs: CI keeps stdout, so a key in a tool's output is hidden as in the receipts."""
    _allow("bash(echo *)")
    key = "sk-" + "A1b2C3d4" * 4
    m = fake([openai_reply("", [("run_command", {"command": f"echo OPENAI_API_KEY={key}"})]), openai_reply("done")])
    r = headless(project, m, "-p", "--output-format", "stream-json", "show the key")
    assert r.returncode == 0, r.stdout + r.stderr
    assert key not in r.stdout and "redacted" in r.stdout


# 5. sdk.py in process ------------------------------------------------------------------------------------------------
def test_sdk_runs_a_task_in_process_and_returns_the_same_result(project, fake, monkeypatch):
    from rooks_code import sdk

    class NoInput:
        def __getattr__(self, name):
            raise AssertionError(f"sdk.run touched stdin ({name})")

    monkeypatch.setattr(sys, "stdin", NoInput())
    m = fake(list(FIX))
    events = []
    res = sdk.run("fix the failing test", cwd=project, provider="openai-compatible", base_url=m.url,
                  model="fake-model", yes=True, on_event=events.append)
    assert res.exit_code == 0 and res.ok, res.to_dict()
    assert (project / "calc.py").read_text().endswith("a + b\n")
    _validator("result").validate(res.to_dict())
    check = _validator("event")
    for ev in events:
        check.validate(ev)
    assert events[0]["type"] == "start" and events[-1]["type"] == "end"
    assert {k: v for k, v in events[-1].items() if k != "type"} == {k: v for k, v in res.to_dict().items() if k != "type"}
    assert res.result == "Fixed add(): it subtracted. test_calc.py now passes."
    assert res.turns == 5 and res.session_id == _receipts(project)[0].stem

    m = fake([EDIT, openai_reply("OK, left it.")])
    (project / "calc.py").write_text("def add(a, b):\n    return a - b\n")
    res = sdk.run("fix add", cwd=project, provider="openai-compatible", base_url=m.url, model="fake-model")
    assert res.exit_code == 3 and res.denied == [{"tool": "edit_file", "summary": "edit calc.py", "by": "headless"}]
    assert (project / "calc.py").read_text().endswith("a - b\n")


def test_sdk_reports_bad_usage_as_exit_2_without_raising(project):
    from rooks_code import sdk

    res = sdk.run("", cwd=project, provider="openai-compatible", base_url="http://127.0.0.1:9/v1", model="m")
    assert res.exit_code == 2 and res.error and res.session_id is None
    res = sdk.run("hi", cwd=project, provider="no-such-provider")
    assert res.exit_code == 2 and "no-such-provider" in res.error
    _validator("result").validate(res.to_dict())


# 6. bad usage exits 2, and the README says so --------------------------------------------------------------------------
def test_bad_usage_exits_2_in_plain_words(project, fake):
    m = fake([])
    r = headless(project, m, "-p")  # no task, and nothing piped in
    assert r.returncode == 2 and "task" in r.stderr and "Traceback" not in r.stderr, r.stderr
    r = headless(project, m, "-p", "--output-format", "json")
    assert r.returncode == 2 and json.loads(r.stdout)["exit_code"] == 2, r.stdout + r.stderr
    r = headless(project, m, "-p", "--output-format", "yaml", "hi")
    assert r.returncode == 2
    r = headless(project, m, "-p", "--handoff", "abc", "hi")
    assert r.returncode == 2 and "Traceback" not in r.stderr
    assert m.requests == []  # none of these reached the model


def test_readme_documents_headless_mode_and_its_exit_codes():
    readme = (PKG / "README.md").read_text(encoding="utf-8")
    for needle in ("rooks -p", "--output-format json", "stream-json", "rooks_code.sdk", "headless.schema.json"):
        assert needle in readme, needle
    for code in ("0", "1", "2", "3"):
        assert f"| `{code}` |" in readme


# 7. through the app: nothing waits in Needs you ------------------------------------------------------------------------
class FakeApp:
    """The Rooks app's /v1 bridge, enough for rooks: chat completions from a script; every other call recorded."""

    def __init__(self, script):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        import threading

        self.script, self.paths = list(script), []
        app = self

        class Handler(BaseHTTPRequestHandler):
            def _send(self, obj):
                data = json.dumps(obj).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                app.paths.append(("GET", self.path))
                self._send({"data": []} if self.path.endswith("/models") else {})

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                app.paths.append(("POST", self.path))
                if self.path.endswith("/chat/completions"):
                    return self._send(app.script.pop(0) if app.script else openai_reply("(script exhausted)"))
                self._send({"id": 1, "conversation_id": 1, "status": "pending"})

            def log_message(self, *a, **kw):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


def test_a_headless_run_through_the_app_never_links_a_chat_or_waits_in_needs_you(project):
    """Linked to an app chat, a question would wait up to 15 minutes in Needs you (shared_approval.REMOTE_WAIT_S)
    for someone to answer. A headless run uses the app's models only: no chat link, no question posted, no wait."""
    app = FakeApp([EDIT, openai_reply("Left it.")])
    try:
        r = subprocess.run([sys.executable, "-m", "rooks_code", "-C", str(project), "-P", "workbench", "-p",
                            "--output-format", "json", "fix add"], capture_output=True, text=True, timeout=30,
                           env=_env({"WORKBENCH_URL": app.url, "WORKBENCH_API_KEY": "terminal-token-for-test",
                                     "ROOKS_SHARED_LOOP": "1"}))
    finally:
        app.server.shutdown()
    assert r.returncode == 3, r.stdout + r.stderr
    assert json.loads(r.stdout)["denied"][0]["by"] == "headless"
    asked = [p for _, p in app.paths if "/rooks/conversation" in p or "/rooks/approvals" in p or "/rooks/run_turn" in p]
    assert asked == [], app.paths
    assert ("POST", "/v1/chat/completions") in app.paths  # it did use the app's model
    assert (project / "calc.py").read_text().endswith("a - b\n")


def test_with_yes_an_mcp_servers_question_to_the_person_is_still_denied_headless(project, fake):
    """--yes approves the agent's own steps, never a question meant for the person (the Room's hand-off asks before a
    file leaves it). Nobody can answer a headless run, so the answer is no, it is reported, and the exit code is 3."""
    server = Path(__file__).with_name("fake_mcp_asks.py")
    (project / ".mcp.json").write_text(json.dumps({"mcpServers": {"room": {"command": sys.executable, "args": [str(server)]}}}))
    m = fake([openai_reply("", [("mcp__room__copy_out", {"src": "notes.txt"})]), openai_reply("Could not copy it.")])
    r = headless(project, m, "-p", "--yes", "--output-format", "stream-json", "copy notes out", timeout=60)
    assert r.returncode == 3, r.stdout + r.stderr
    events = [json.loads(x) for x in r.stdout.splitlines()]
    check = _validator("event")
    for ev in events:
        check.validate(ev)
    denied = [e for e in events if e["type"] == "approval_denied"]
    assert [(d["tool"], d["by"]) for d in denied] == [("mcp__room__copy_out", "headless")], denied
    assert m.requests[1]["body"]["messages"][-1]["content"] == "NOT COPIED: the person said no"


def test_a_model_error_exits_1_and_says_so_in_plain_words(project, fake):
    m = fake([{"__status__": 400}])
    r = headless(project, m, "-p", "--output-format", "json", "hi")
    assert r.returncode == 1, r.stdout + r.stderr
    out = json.loads(r.stdout)
    _validator("result").validate(out)
    assert out["exit_code"] == 1 and out["outcome"] == "model_error" and out["error"] and out["result"] == ""
    assert "127.0.0.1" not in r.stdout + r.stderr and "Traceback" not in r.stderr  # no address, no stack trace
