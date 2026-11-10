"""/room, /needs and /jobs reach the app's Room, Needs you and Jobs with the terminal's own key, and say plainly when an
older app does not let them."""

import io
import json
import os
import sys
import threading
from pathlib import Path
import types
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from rooks_code import tui, workroom
from rooks_code.cli import UI

GOOD = "g" * 32


class FakeApp:
    """The app's /api/room, /api/needs-you and /api/jobs, behind the terminal's check (require_user_or_terminal): the key,
    and the terminal's channel header that a bridge key needs."""

    def __init__(self):
        self.calls: list[tuple[str, str, dict | None]] = []
        self.room = {"available": True, "running": False, "screen": False, "pointer": False, "isolation": "namespace",
                     "label": "A private folder and shell", "note": "Commands run as you, in a folder of its own.",
                     "driver": "shell", "last_checkpoint": None, "checkpoints": [], "home": "/rooms/home",
                     "offline": False, "terminals": [], "terminal_max": 4, "can": {"terminal": True, "files": True}}
        self.tails: dict[str, dict] = {}  # a terminal's last lines, as GET /api/room/terminals/{id}/tail answers
        self.verified = True  # what the service could confirm about a saved point or a start over
        self.older = False  # an app without the Room's terminals and files yet
        self.needs = [{"id": "a:7", "kind": "approval", "title": "Send an email to Ana", "detail": "Subject: Friday",
                       "since": "2026-11-06T10:00:00", "actions": ["approve", "deny"]},
                      {"id": "j:3", "kind": "job", "title": "Tidy the downloads folder", "detail": "",
                       "since": "2026-11-06T09:00:00", "actions": ["approve", "deny"]}]
        self.answers: list[str] = []  # what the app reports for the next answers (approved, done, failed, held, denied)
        app = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, body):
                data = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _handle(self, method):
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n)) if n else None
                app.calls.append((method, self.path, body))
                if self.headers.get("Authorization") != f"Bearer {GOOD}" or self.headers.get("X-Workbench-Channel") != "rooks-code":
                    return self._send(401, {"detail": "Not signed in"})
                p = self.path
                if p == "/api/room/status":
                    return self._send(200, app.room)
                if p == "/api/room/up":
                    app.room["running"] = True
                    return self._send(200, {"running": True, "label": app.room["label"]})
                if p == "/api/room/down":
                    app.room["running"] = False
                    closed = 0
                    for t in app.room["terminals"]:
                        closed += bool(t["alive"])
                        t.update(alive=False, busy=False, ended_reason="stop")
                    return self._send(200, {"running": False, "terminals_closed": closed})
                if p == "/api/room/run":
                    if not app.room["running"]:
                        return self._send(409, {"detail": "The Room is off. Start it first."})
                    if body["command"].startswith("sleep"):
                        return self._send(200, {"ok": False, "code": 124, "stdout": "", "stderr": "",
                                                "error": "Timed out after 120 s"})
                    return self._send(200, {"ok": True, "code": 0, "stdout": f"ran {body['command']}\n", "stderr": ""})
                if p == "/api/needs-you":
                    return self._send(200, app.needs)
                if p.startswith("/api/needs-you/") and method == "POST":
                    item, answer = p.split("/")[3:5]
                    app.needs = [i for i in app.needs if i["id"] != item]
                    status = app.answers.pop(0) if app.answers else ("approved" if answer == "approve" else "denied")
                    return self._send(200, {"id": item, "status": status})
                path, _, query = p.partition("?")
                q = dict(urllib.parse.parse_qsl(query))
                if app.older and path.startswith(("/api/room/terminals", "/api/room/files")):
                    return self._send(404, {"detail": "Not Found"})  # an app from before the Room's terminals
                terms = app.room["terminals"]
                if path == "/api/room/terminals" and method == "GET":
                    return self._send(200, {"terminals": terms, "max": app.room["terminal_max"]})
                if path == "/api/room/terminals" and method == "POST":
                    if not app.room["running"]:
                        return self._send(409, {"detail": "The Room is off. Start it first."})
                    body = body or {}
                    rooks = bool(body.get("command"))
                    t = {"id": f"t{len(terms) + 1:07d}", "name": body.get("name") or f"Terminal {len(terms) + 1}",
                         "owner": "rooks" if rooks else "person", "alive": True, "busy": rooks,
                         "started": "2026-11-07T14:02:11Z", "exit_code": None, "ended_reason": None,
                         "command": body.get("command"), "elapsed_s": 0}
                    terms.append(t)
                    return self._send(200, {k: t[k] for k in ("id", "name", "owner", "alive", "started")})
                if path.startswith("/api/room/terminals/"):
                    tid, _, verb = path[len("/api/room/terminals/"):].partition("/")
                    t = next((x for x in terms if x["id"] == tid), None)
                    if t is None:
                        return self._send(404, {"detail": "No such terminal"})
                    if verb == "tail" and method == "GET":
                        return self._send(200, app.tails.get(tid) or {
                            "text": "", "alive": t["alive"], "busy": t["busy"], "exit_code": t["exit_code"],
                            "owner": t["owner"], "taken": False, "elapsed_s": t["elapsed_s"]})
                    if verb == "send" and method == "POST":
                        if not t["alive"]:
                            return self._send(409, {"detail": "This terminal has ended."})
                        if t["owner"] == "rooks" and t["busy"]:
                            return self._send(409, {"detail": "Rooks is working in that terminal. Take it first, or open your own."})
                        return self._send(200, {"ok": True, "bytes": len(body["text"]) + (1 if body.get("enter") else 0)})
                    if verb == "" and method == "DELETE":
                        terms.remove(t)
                        return self._send(200, {"ok": True, "exit_code": 0, "closed": True})
                if path == "/api/room/files":
                    where = q.get("path", "")
                    if ".." in where.split("/"):
                        return self._send(400, {"detail": "That is outside the Room."})
                    if where == "":
                        return self._send(200, {"path": "", "parent": None, "root_label": "Home", "truncated": False, "entries": [
                            {"name": "Desktop", "kind": "folder", "size": None, "modified": "2026-11-07T14:02:11Z"},
                            {"name": ".profile", "kind": "file", "size": 230, "modified": "2026-11-07T14:02:11Z"}]})
                    if where == "Desktop":
                        return self._send(200, {"path": "Desktop", "parent": "", "root_label": "Home", "truncated": False, "entries": [
                            {"name": "hermes", "kind": "folder", "size": None, "modified": "2026-11-07T14:02:11Z"},
                            {"name": "notes.txt", "kind": "file", "size": 2048, "modified": "2026-11-03T09:00:00Z"},
                            {"name": "out", "kind": "link", "why": "outside", "size": None,
                             "modified": "2026-11-03T09:00:00Z"},
                            {"name": "gone", "kind": "link", "why": "broken", "size": None,
                             "modified": "2026-11-03T09:00:00Z"}]})
                    return self._send(404, {"detail": "That folder is gone."})
                if path == "/api/room/checkpoint" and method == "POST":
                    label = (body or {}).get("label") or "save"
                    name = "20261107T140211-" + label.replace(" ", "-")
                    if app.verified:
                        app.room["checkpoints"].insert(0, {"name": name})
                    return self._send(200, {"name": name, "label": label, "verified": app.verified})
                if path == "/api/room/reset" and method == "POST":
                    closed = sum(1 for t in terms if t["alive"])
                    for t in terms:
                        t.update(alive=False, busy=False, ended_reason="start over")
                    return self._send(200, {"name": (body or {}).get("name"), "restored": app.verified,
                                            "verified": app.verified, "terminals_closed": closed,
                                            "terminal": {"id": "t0000009", "name": "Terminal 1"}})
                if path == "/api/room/handoff" and method == "POST":
                    return self._send(200, {"ok": False, "held": True, "needs_you_id": "a:9", "request_id": "r1",
                                            "note": "Nothing was copied. It waits for your OK in Needs you."})
                if p == "/api/jobs":
                    return self._send(200, {"running": [{"id": 4, "title": "Weekly report", "status": "running"}],
                                            "you": [], "done": []})
                return self._send(404, {"detail": "Not found"})

            def do_GET(self):
                self._handle("GET")

            def do_POST(self):
                self._handle("POST")

            def do_DELETE(self):
                self._handle("DELETE")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()


@pytest.fixture
def fake_app():
    a = FakeApp()
    yield a
    a.close()


def _agent(url=None, key=GOOD, root="."):
    s = SimpleNamespace(provider="workbench" if url else "openai", base_url=f"{url}/v1" if url else "http://x/v1", api_key=key,
                        model="default", mcp_servers={}, effort="")
    return SimpleNamespace(s=s, root=root, extras=None)


def _say(fn, agent, rest=""):
    out = io.StringIO()
    ui = UI(out=out, err=out, color=False)
    fn(agent, ui, rest)
    return out.getvalue()


@pytest.fixture(autouse=True)
def no_app_running(monkeypatch):
    monkeypatch.setattr("rooks_code.config.app_link", lambda: {})
    monkeypatch.setattr(workroom, "_SEEN", {"working": False, "last_rooks": None})  # what an earlier test saw


def test_without_the_app_the_room_and_needs_you_say_so_plainly():
    text = _say(workroom.room_command, _agent())
    assert "Rooks app" in text and "Open" in text
    text = _say(workroom.needs_command, _agent())
    assert "Needs you" in text and "Rooks app" in text


def test_room_status_start_run_stop(fake_app):
    agent = _agent(fake_app.url)
    text = _say(workroom.room_command, agent)
    assert "The Room" in text and "off" in text and "A private folder and shell" in text
    assert "No screen" in text
    for hidden in ("namespace", "driver", "http", "401"):
        assert hidden not in text, hidden
    off = _say(workroom.room_command, agent, "run ls")
    assert "The Room is off. Start it first." in off and "409" not in off
    assert "on" in _say(workroom.room_command, agent, "start")
    ran = _say(workroom.room_command, agent, "run ls -la")
    assert "ran ls -la" in ran
    assert ("POST", "/api/room/run", {"command": "ls -la"}) in fake_app.calls
    assert "off" in _say(workroom.room_command, agent, "stop")


def test_needs_lists_and_answers_through_the_app(fake_app):
    agent = _agent(fake_app.url)
    text = _say(workroom.needs_command, agent)
    assert "Needs you" in text and "Send an email to Ana" in text and "Tidy the downloads folder" in text
    assert "a:7" not in text and "j:3" not in text  # no ids on a normal screen: items are numbered
    assert "Approved" in _say(workroom.needs_command, agent, "approve 1")
    assert any(c[0] == "POST" and c[1] == "/api/needs-you/a:7/approve" for c in fake_app.calls)
    denied = _say(workroom.needs_command, agent, "deny 1")
    assert "Denied" in denied
    assert any(c[0] == "POST" and c[1] == "/api/needs-you/j:3/deny" for c in fake_app.calls)
    assert "Nothing needs you" in _say(workroom.needs_command, agent)


def test_an_older_app_that_refuses_the_key_is_said_plainly_not_faked(fake_app):
    agent = _agent(fake_app.url, key="b" * 32)
    for fn in (workroom.room_command, workroom.needs_command):
        text = _say(fn, agent)
        assert "in the app" in text and "update" in text.lower(), text
        assert "401" not in text and "HTTP" not in text and "Not signed in" not in text
        assert "chat and models only" not in text  # the old claim: today's app lets the terminal's key in


def test_the_terminal_says_who_it_is_on_every_workroom_call(fake_app):
    """A bridge key opens these routes only with the terminal's channel header (the browser and desk helpers share it)."""
    agent = _agent(fake_app.url)
    assert "The Room" in _say(workroom.room_command, agent)
    assert "Send an email to Ana" in _say(workroom.needs_command, agent)


def test_an_approval_that_ran_says_approved_not_denied(fake_app):
    agent = _agent(fake_app.url)
    fake_app.answers[:] = ["done"]
    assert _say(workroom.needs_command, agent, "approve 1").strip().startswith("Approved: Send an email to Ana")
    fake_app.answers[:] = ["failed"]
    text = _say(workroom.needs_command, agent, "approve 1")
    assert text.strip().startswith("Approved") and "did not work" in text and "Denied" not in text, text


def test_jobs_lists_the_terminal_jobs_and_the_apps_jobs(fake_app, tmp_path):
    agent = _agent(fake_app.url, root=tmp_path)
    agent.extras = SimpleNamespace(jobs=SimpleNamespace(check=lambda rest, n: "no background jobs", stop=lambda i: ""))
    out = io.StringIO()
    tui.command(agent, tui.RichUI(out=out, color=False), "/jobs", "")
    text = out.getvalue()
    assert "no background jobs" in text and "Weekly report" in text


def test_room_and_needs_are_reachable_from_the_command_list():
    assert "/room" in tui.COMMANDS and "/needs" in tui.COMMANDS


# --- the Room as a small computer (design record 0006, sections 6, 7.1 and 9.9) -------------------------------------------
HONEST = "Commands run as you, in a folder of its own. It is not a locked off computer."


def _term(name, owner="person", alive=True, busy=False, exit_code=None, elapsed_s=0, ended_reason=None, tid=None):
    return {"id": tid or ("t" + name.lower().replace(" ", "")[:7]).ljust(8, "0"), "name": name, "owner": owner,
            "alive": alive, "busy": busy, "started": "2026-11-07T14:02:11Z", "exit_code": exit_code,
            "ended_reason": ended_reason, "command": "./install.sh" if owner == "rooks" else None, "elapsed_s": elapsed_s}


def _answer(monkeypatch, line: str) -> None:
    """What the person types at a (y/N) question."""
    monkeypatch.setattr("sys.stdin", io.StringIO(line + "\n"))


def test_room_lists_terminals_and_the_honest_line(fake_app):
    fake_app.room["running"] = True
    fake_app.room["terminals"] = [_term("Terminal 1"), _term("Rooks", owner="rooks", busy=True, elapsed_s=184)]
    text = _say(workroom.room_command, _agent(fake_app.url))
    assert "The Room  ·  On" in text, text
    assert "Terminal 1 · yours" in text and "Rooks · running, 3 min" in text, text
    assert HONEST in text, text
    for hidden in [t["id"] for t in fake_app.room["terminals"]] + ["namespace", "driver", "/rooms/home", "http"]:
        assert hidden not in text, hidden
    fake_app.room["terminals"] = [_term("Rooks", owner="rooks", alive=False, exit_code=0, ended_reason="exited")]
    assert "Rooks · ended, code 0" in _say(workroom.room_command, _agent(fake_app.url))
    fake_app.room["terminals"] = [_term("Terminal 1", alive=False, ended_reason="restart")]
    assert "the app restarted" in _say(workroom.room_command, _agent(fake_app.url))


def test_room_stop_says_everything_is_kept_and_how_many_terminals_closed(fake_app):
    fake_app.room["running"] = True
    fake_app.room["terminals"] = [_term("Terminal 1"), _term("Terminal 2", tid="t0000002")]
    text = _say(workroom.room_command, _agent(fake_app.url), "stop")
    assert "The Room is off. Everything in it is kept. 2 terminals closed." in text, text
    assert "Off" in _say(workroom.room_command, _agent(fake_app.url))


def test_room_run_cut_off_at_two_minutes_points_to_a_terminal(fake_app):
    fake_app.room["running"] = True
    text = _say(workroom.room_command, _agent(fake_app.url), "run sleep 200")
    assert "Stopped after 120 seconds. For something long: /room open COMMAND" in text, text
    assert "124" not in text


def test_room_files_points_and_open_tail_close(fake_app, monkeypatch):
    agent = _agent(fake_app.url)
    files = _say(workroom.room_command, agent, "files Desktop")
    assert ("GET", "/api/room/files?path=Desktop", None) in fake_app.calls
    assert "Home › Desktop" in files, files
    rows = {ln.split()[0]: ln for ln in files.splitlines()[1:] if ln.strip()}
    assert "folder" in rows["hermes"] and "2 KB" in rows["notes.txt"] and "3 Nov" in rows["notes.txt"], files
    assert "link" in rows["out"], files
    home = _say(workroom.room_command, agent, "files")
    assert "Home" in home and ".profile" in home, home
    outside = _say(workroom.room_command, agent, "files ../etc")
    assert "That is outside the Room." in outside and "400" not in outside

    fake_app.room["checkpoints"] = [{"name": "20261101T090000-first"}, {"name": "20261107T140211-before-hermes"}]
    points = _say(workroom.room_command, agent, "points")
    assert "before hermes · 7 Nov, 14:02" in points and "first · 1 Nov, 09:00" in points, points
    assert points.index("before hermes") < points.index("first")  # newest first
    assert "20261107T140211" not in points

    assert "The Room is off. Start it first." in _say(workroom.room_command, agent, "open echo hi")
    fake_app.room["running"] = True
    opened = _say(workroom.room_command, agent, "open echo hi")
    assert ("POST", "/api/room/terminals", {"name": "Rooks", "command": "echo hi"}) in fake_app.calls
    assert 'Started in the Room\'s terminal "Rooks". /room tail shows how it goes.' in opened, opened
    tid = fake_app.room["terminals"][0]["id"]
    assert workroom.room_working()  # the status line's live dot while Rooks's command runs

    fake_app.tails[tid] = {"text": "Installing hermes…\nstill going", "alive": True, "busy": True, "exit_code": None,
                           "owner": "rooks", "taken": False, "elapsed_s": 184}
    running = _say(workroom.room_command, agent, "tail")
    assert ("GET", f"/api/room/terminals/{tid}/tail?lines=60", None) in fake_app.calls
    assert "Installing hermes…" in running and "still running (3 min)" in running, running
    fake_app.tails[tid] = {"text": "hi", "alive": True, "busy": False, "exit_code": 0, "owner": "rooks", "taken": False,
                           "elapsed_s": 2}
    done = _say(workroom.room_command, agent, "tail Rooks")
    assert "hi" in done and "ended with code 0" in done, done
    assert not workroom.room_working()  # the dot goes once the command is seen done
    assert "No terminal called Nope" in _say(workroom.room_command, agent, "tail Nope")

    fake_app.room["terminals"][0]["busy"] = True
    busy = _say(workroom.room_command, agent, "send Rooks y")
    assert "Rooks is working in that terminal. Take it first, or open your own." in busy, busy
    fake_app.room["terminals"][0]["busy"] = False
    _say(workroom.room_command, agent, "send Rooks hermes --version")
    assert ("POST", f"/api/room/terminals/{tid}/send", {"text": "hermes --version", "enter": True}) in fake_app.calls

    _answer(monkeypatch, "n")
    kept = _say(workroom.room_command, agent, "close Rooks")
    assert "Close Rooks? What it is running stops. (y/N)" in kept, kept
    assert not any(c[0] == "DELETE" for c in fake_app.calls)
    _answer(monkeypatch, "y")
    closed = _say(workroom.room_command, agent, "close rooks")
    assert ("DELETE", f"/api/room/terminals/{tid}", None) in fake_app.calls
    assert "Closed Rooks." in closed, closed


def test_an_app_without_room_terminals_is_said_plainly(fake_app):
    fake_app.older = True
    fake_app.room["running"] = True
    for rest in ("files", "open echo hi", "tail"):
        text = _say(workroom.room_command, _agent(fake_app.url), rest)
        assert "Not Found" not in text and "404" not in text, text
        assert "update" in text.lower(), text


def test_room_send_finds_a_name_with_spaces(fake_app):
    fake_app.room["running"] = True
    fake_app.room["terminals"] = [_term("Terminal 1", tid="t0000001")]
    _say(workroom.room_command, _agent(fake_app.url), "send Terminal 1 ls -la")
    assert ("POST", "/api/room/terminals/t0000001/send", {"text": "ls -la", "enter": True}) in fake_app.calls


def test_room_save_and_back_say_done_only_when_verified(fake_app, monkeypatch):
    agent = _agent(fake_app.url)
    fake_app.verified = False
    unsure = _say(workroom.room_command, agent, "save x")
    assert ("POST", "/api/room/checkpoint", {"label": "x"}) in fake_app.calls
    assert "Saved a point" not in unsure and "could not be confirmed" in unsure, unsure
    fake_app.verified = True
    assert "Saved a point: x." in _say(workroom.room_command, agent, "save x")

    fake_app.room["running"] = True
    fake_app.room["terminals"] = [_term("Terminal 1")]
    fake_app.room["checkpoints"] = [{"name": "20261107T140211-before-hermes"}]
    _answer(monkeypatch, "")
    asked = _say(workroom.room_command, agent, "back before hermes")
    assert ("Yes to start over from before hermes · 7 Nov, 14:02? Anything done since is lost and open terminals close."
            " (y/N)") in asked, asked
    assert not any(c[1] == "/api/room/reset" for c in fake_app.calls)
    fake_app.verified = False
    _answer(monkeypatch, "y")
    failed = _say(workroom.room_command, agent, "back 1")
    assert ("POST", "/api/room/reset", {"name": "20261107T140211-before-hermes"}) in fake_app.calls
    assert "The Room is back" not in failed and "could not be confirmed" in failed, failed
    fake_app.verified = True
    fake_app.room["terminals"] = [_term("Terminal 1")]
    _answer(monkeypatch, "y")
    back = _say(workroom.room_command, agent, "back before hermes")
    assert "The Room is back at before hermes · 7 Nov, 14:02." in back and "1 terminal closed" in back, back
    assert "Say which point" in _say(workroom.room_command, agent, "back nothing-like-it")


def test_room_handoff_waits_in_needs_you(fake_app):
    text = _say(workroom.room_command, _agent(fake_app.url), "handoff Desktop/notes.txt ~/Desktop")
    assert ("POST", "/api/room/handoff", {"src": "Desktop/notes.txt", "dest": "~/Desktop"}) in fake_app.calls
    assert "Waiting for your OK in Needs you (/needs)." in text, text
    assert "a:9" not in text


def _fake_room_shell(monkeypatch, calls):
    shell = types.ModuleType("rooks_try.drivers.shell")
    shell.login_argv = lambda home, offline: ["sh", "-c", "login", "room", str(home), str(offline)]
    shell.room_env = lambda home, offline, base=None: {"HOME": str(home), "PATH": f"{home}/.local/bin:/usr/bin"}
    monkeypatch.setitem(sys.modules, "rooks_try.drivers.shell", shell)
    monkeypatch.setattr("subprocess.call", lambda argv, **kw: calls.append((argv, kw)) or 0)


def test_room_shell_runs_the_same_login_shell_or_says_where_it_is(fake_app, monkeypatch):
    calls: list = []
    _fake_room_shell(monkeypatch, calls)
    fake_app.room["running"] = True
    text = _say(workroom.room_command, _agent(fake_app.url), "shell")
    assert calls, text
    argv, kw = calls[0]
    assert os.path.isabs(argv[0]) and os.path.splitext(os.path.basename(argv[0]))[0].lower() == "sh"  # found on this computer, by its full path
    assert argv[1:] == ["-c", "login", "room", str(Path("/rooms/home")), "False"]
    assert kw["env"]["HOME"] == str(Path("/rooms/home"))
    assert "exit" in text and "/rooms/home" not in text, text

    calls.clear()
    fake_app.room["can"] = {"terminal": False, "files": False}  # a Room run by a helper elsewhere
    remote = _say(workroom.room_command, _agent(fake_app.url), "shell")
    assert "The Room's terminal opens in the app on this computer." in remote and not calls, remote

    fake_app.room["can"] = {"terminal": True, "files": True}
    monkeypatch.setitem(sys.modules, "rooks_try.drivers.shell", None)  # rooks-try not installed with this terminal
    assert "The Room's terminal opens in the app on this computer." in _say(workroom.room_command, _agent(fake_app.url), "shell")
    assert not calls


def test_room_shell_waits_for_the_room_to_be_on(fake_app, monkeypatch):
    calls: list = []
    _fake_room_shell(monkeypatch, calls)
    text = _say(workroom.room_command, _agent(fake_app.url), "shell")
    assert "The Room is off" in text and "/room start" in text and not calls, text


def test_room_tail_prints_plain_text_never_escape_sequences(fake_app):
    """A program in the Room cannot switch modes in, retitle or write the clipboard of the person's own terminal."""
    fake_app.room["running"] = True
    fake_app.room["terminals"] = [_term("Rooks", owner="rooks", tid="t0000009")]
    fake_app.tails["t0000009"] = {"text": "\x1b]52;c;aGk=\x07hi\x1b[?2004h\n\x1b[31mred\x1b[0m\x1b]0;title\x07\rRED",
                                  "alive": True, "busy": False, "exit_code": 0, "owner": "rooks", "taken": False,
                                  "elapsed_s": 1}
    text = _say(workroom.room_command, _agent(fake_app.url), "tail Rooks")
    assert "\x1b" not in text and "\x07" not in text, repr(text)
    assert "hi" in text and "RED" in text and "52;" not in text, text


def test_room_files_says_where_a_link_leads(fake_app):
    files = _say(workroom.room_command, _agent(fake_app.url), "files Desktop")
    rows = {ln.split()[0]: ln for ln in files.splitlines()[1:] if ln.strip()}
    assert "link, leads outside the Room" in rows["out"] and "link, leads nowhere" in rows["gone"], files


def test_room_shell_says_when_terminals_are_switched_off(fake_app, monkeypatch):
    calls: list = []
    _fake_room_shell(monkeypatch, calls)
    fake_app.room["running"] = True
    fake_app.room["can"] = {"terminal": False, "files": True, "terminal_off_reason": "switched_off"}
    text = _say(workroom.room_command, _agent(fake_app.url), "shell")
    assert "Terminals are switched off in Settings." in text and "opens in the app" not in text and not calls, text


@pytest.mark.skipif(sys.platform == "win32", reason="a POSIX shell")
def test_room_shell_never_runs_a_wrapper_from_the_rooms_own_bins(fake_app, monkeypatch, tmp_path):
    """Even with an older rooks-try (a bare "sh" first, the Room's bins first on the PATH), the program that starts the
    Room's shell is found on this computer, never in a folder a Room program can write."""
    import shutil
    import subprocess as sp

    home = tmp_path / "try" / "home"
    marker = tmp_path / "planted.log"
    for folder in (home / ".local" / "bin", home / "bin", home / ".cargo" / "bin"):
        folder.mkdir(parents=True)
        for name in ("sh", "unshare", "setsid"):
            real = shutil.which(name, path="/usr/bin:/bin") or f"/bin/{name}"
            (folder / name).write_text(f'#!/bin/sh\necho "PLANTED $0" >> "{marker}"\nexec {real} "$@"\n')
            (folder / name).chmod(0o755)
    shell = types.ModuleType("rooks_try.drivers.shell")
    shell.login_argv = lambda h, offline: ["sh", "-c", 'cd "$1" && exec /bin/sh', "room", str(h)]
    bins = f"{home}/.local/bin:{home}/bin:{home}/.cargo/bin"
    shell.room_env = lambda h, offline, base=None: {"HOME": str(h), "PATH": f"{bins}:/usr/bin:/bin"}
    monkeypatch.setitem(sys.modules, "rooks_try.drivers.shell", shell)
    ran: list = []

    def call(argv, **kw):
        ran.append((argv, kw))
        return sp.run(argv, input="exit\n", capture_output=True, text=True, timeout=30, **kw).returncode

    monkeypatch.setattr("subprocess.call", call)
    fake_app.room.update(running=True, home=str(home))
    _say(workroom.room_command, _agent(fake_app.url), "shell")
    assert ran, "the shell never ran"
    assert not marker.exists(), marker.read_text()
    argv, kw = ran[0]
    assert os.path.isabs(argv[0]) and str(home) not in argv[0], argv
    assert str(home) not in kw["env"]["PATH"], kw["env"]["PATH"]


def test_help_lists_the_room_verbs():
    from rooks_code import words

    plain = words.help_text()
    out = io.StringIO()
    tui.help_table(tui.RichUI(out=out, color=False))
    for text in (plain, out.getvalue()):
        assert "The Room" in text
        for verb in ("open", "tail", "send", "close", "files", "points", "save", "back", "handoff", "shell"):
            assert f"/room {verb}" in text, verb
