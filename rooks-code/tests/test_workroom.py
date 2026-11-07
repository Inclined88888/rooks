"""/room, /needs and /jobs reach the app's Room, Needs you and Jobs, and say plainly when this terminal can't."""

import io
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from rooks_code import tui, workroom
from rooks_code.cli import UI

GOOD = "g" * 32


class FakeApp:
    """The app's /api/room, /api/needs-you and /api/jobs, behind the same bearer check as require_user."""

    def __init__(self):
        self.calls: list[tuple[str, str, dict | None]] = []
        self.room = {"available": True, "running": False, "screen": False, "pointer": False, "isolation": "namespace",
                     "label": "A private folder and shell", "note": "Commands run as you, in a folder of its own.",
                     "driver": "shell", "last_checkpoint": None, "checkpoints": []}
        self.needs = [{"id": "a:7", "kind": "approval", "title": "Send an email to Ana", "detail": "Subject: Friday",
                       "since": "2026-11-06T10:00:00", "actions": ["approve", "deny"]},
                      {"id": "j:3", "kind": "job", "title": "Tidy the downloads folder", "detail": "",
                       "since": "2026-11-06T09:00:00", "actions": ["approve", "deny"]}]
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
                if self.headers.get("Authorization") != f"Bearer {GOOD}":
                    return self._send(401, {"detail": "Not signed in"})
                p = self.path
                if p == "/api/room/status":
                    return self._send(200, app.room)
                if p == "/api/room/up":
                    app.room["running"] = True
                    return self._send(200, {"running": True, "label": app.room["label"]})
                if p == "/api/room/down":
                    app.room["running"] = False
                    return self._send(200, {"running": False})
                if p == "/api/room/run":
                    if not app.room["running"]:
                        return self._send(409, {"detail": "The Room is off. Start it first."})
                    return self._send(200, {"ok": True, "code": 0, "stdout": f"ran {body['command']}\n", "stderr": ""})
                if p == "/api/needs-you":
                    return self._send(200, app.needs)
                if p.startswith("/api/needs-you/") and method == "POST":
                    item, answer = p.split("/")[3:5]
                    app.needs = [i for i in app.needs if i["id"] != item]
                    return self._send(200, {"id": item, "status": "approved" if answer == "approve" else "denied"})
                if p == "/api/jobs":
                    return self._send(200, {"running": [{"id": 4, "title": "Weekly report", "status": "running"}],
                                            "you": [], "done": []})
                return self._send(404, {"detail": "Not found"})

            def do_GET(self):
                self._handle("GET")

            def do_POST(self):
                self._handle("POST")

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


def test_a_key_that_cannot_reach_a_route_is_said_plainly_not_faked(fake_app):
    agent = _agent(fake_app.url, key="b" * 32)
    for fn in (workroom.room_command, workroom.needs_command):
        text = _say(fn, agent)
        assert "can't" in text and "in the app" in text, text
        assert "401" not in text and "HTTP" not in text and "Not signed in" not in text


def test_jobs_lists_the_terminal_jobs_and_the_apps_jobs(fake_app, tmp_path):
    agent = _agent(fake_app.url, root=tmp_path)
    agent.extras = SimpleNamespace(jobs=SimpleNamespace(check=lambda rest, n: "no background jobs", stop=lambda i: ""))
    out = io.StringIO()
    tui.command(agent, tui.RichUI(out=out, color=False), "/jobs", "")
    text = out.getvalue()
    assert "no background jobs" in text and "Weekly report" in text


def test_room_and_needs_are_reachable_from_the_command_list():
    assert "/room" in tui.COMMANDS and "/needs" in tui.COMMANDS
