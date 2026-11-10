"""/work: the work account (Microsoft 365) from the terminal, through the Rooks app on this computer (design 0012,
section 3.4). Same switches and words as the app's Work apps page (they come from the app), its own Terminal access
token (never the shared bridge key), and a post is only ever put in Needs you, never sent from here."""

import io
import json
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from rooks_code import words, workroom
from rooks_code.cli import UI

TOKEN = "t" * 32
BRIDGE = "b" * 32

STATUS = {
    "account": {"provider": "microsoft", "email": "ana@contoso.com", "name": "Ana Lima", "status": "connected", "needs_sign_in": False},
    "features": [
        {"id": "mail", "label": "Mail", "says": "Rooks can read your Outlook mail and save drafts.", "asks_first": False,
         "state": "on", "state_words": "On"},
        {"id": "files_read", "label": "Files: read", "says": "Rooks can find and read files in your OneDrive.", "asks_first": False,
         "state": "on", "state_words": "On"},
        {"id": "files_change", "label": "Files: change", "says": "Rooks can upload, share and edit files.", "asks_first": True,
         "state": "off", "state_words": "Off"},
        {"id": "chats_read", "label": "Chats: read", "says": "Rooks can read your Teams chats.", "asks_first": False,
         "state": "waiting", "state_words": "Waiting for your IT team", "waiting_words": "Your company asks an IT admin to approve apps."},
        {"id": "chats_post", "label": "Chats: post", "says": "Rooks can post in your Teams chats.", "asks_first": True,
         "state": "signin", "state_words": "Sign in to allow this"},
    ],
    "words": {"asks_first": "Rooks always asks you first"},
    "advanced": {"tenant": "11111111-aaaa", "granted": ["Files.Read.All"]},
}


class FakeApp:
    def __init__(self):
        self.calls: list[tuple[str, str, dict | None]] = []
        self.status = json.loads(json.dumps(STATUS))
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
                if self.headers.get("Authorization") != f"Bearer {TOKEN}":  # the app's /api/work takes only the terminal's own sign in
                    return self._send(401, {"detail": "Not signed in"})
                path, _, query = self.path.partition("?")
                q = dict(urllib.parse.parse_qsl(query))
                if path == "/api/work/status":
                    return self._send(200, app.status)
                if path in ("/api/work/connect/microsoft", "/api/work/connect/google") and method == "POST":
                    return self._send(200, {"url": "https://login.example/authorize?scope=openid", "state": "s1", "opened": False})
                if path.startswith("/api/work/features/") and path.endswith("/it-note"):
                    return self._send(200, {"note": "Hello IT team,\n- Chat.Read: read the person's Teams chats\nThank you."})
                if path.startswith("/api/work/features/") and method == "POST":
                    fid = path.rsplit("/", 1)[1]
                    if body["on"]:
                        return self._send(200, {"id": fid, "state": "signing_in", "url": "https://login.example/authorize?scope=Files",
                                                "opened": False})
                    return self._send(200, {"id": fid, "state": "off", "state_words": "Off"})
                if path == "/api/work/files":
                    if q.get("query") == "nothing":
                        return self._send(200, {"items": []})
                    return self._send(200, {"items": [
                        {"file": "drv-me/f1", "name": "Q3 plan.txt", "folder": False, "where": "OneDrive", "web_url": "https://contoso.sharepoint.com/f1"},
                        {"file": "drv-sales/s1", "name": "Price list.txt", "folder": False, "where": "Sales", "web_url": "https://contoso.sharepoint.com/s1"}]})
                if path == "/api/work/files/read":
                    return self._send(200, {"name": "Q3 plan.txt", "passages": ["[Q3 plan.txt, line 2] The Q3 budget is 42,000 euros."],
                                            "part": 1, "parts": 1})
                if path == "/api/work/files/save" and method == "POST":
                    return self._send(200, {"id": 12, "name": "Q3 plan.txt", "source": "onedrive", "remote": body["file"]})
                if path == "/api/work/chats":
                    return self._send(200, {"chats": [{"chat": "chat:19:lee", "name": "Lee Park", "kind": "chat"},
                                                      {"chat": "channel:team-1/19:general", "name": "Sales team, General", "kind": "channel"}]})
                if path == "/api/work/chats/read":
                    return self._send(200, {"name": "Lee Park", "messages": [
                        {"id": "m1", "from": "Lee Park", "when": "2026-11-09T09:00:00Z", "text": "Can you send me the Q3 plan?"}]})
                if path == "/api/work/hold" and method == "POST":
                    return self._send(200, {"held": True, "already_asked": False, "id": "a:5", "title": "Post in Teams: Lee Park"})
                if path == "/api/work/tasks/sync" and method == "POST":
                    return self._send(200, {"planner": 1, "todo": 1})
                if path == "/api/tasks":
                    return self._send(200, [{"id": 1, "title": "Draft the launch post", "status": "todo", "due": "2026-11-20", "origin": "planner"},
                                            {"id": 2, "title": "Call the printer", "status": "todo", "due": None, "origin": "todo"},
                                            {"id": 3, "title": "Water plants", "status": "todo", "due": None, "origin": ""}])
                return self._send(404, {"detail": "Not Found"})

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
def app():
    a = FakeApp()
    yield a
    a.close()


@pytest.fixture(autouse=True)
def no_real_app(monkeypatch):
    monkeypatch.setattr("rooks_code.config.app_link", lambda: {})
    opened: list[str] = []
    monkeypatch.setattr("webbrowser.open", lambda url, *a, **k: opened.append(url) or True)
    monkeypatch.setattr(workroom, "_WORK", {"files": [], "chats": []}, raising=False)
    return opened


def _agent(url, key=TOKEN):
    s = SimpleNamespace(provider="workbench", base_url=f"{url}/v1", api_key=key, model="default", mcp_servers={}, effort="")
    return SimpleNamespace(s=s, root=".", extras=None)


def _say(agent, rest=""):
    out = io.StringIO()
    workroom.work_command(agent, UI(out=out, err=out, color=False), rest)
    return out.getvalue()


def test_work_lists_the_account_and_every_switch_in_the_apps_words(app):
    out = _say(_agent(app.url))
    assert "Work apps" in out and "ana@contoso.com" in out and "Microsoft 365" in out
    for f in STATUS["features"]:
        assert f["label"] in out and f["state_words"] in out and f["says"] in out
    # the change switches say they ask first, in the app's words, and only those
    line = next(x for x in out.splitlines() if "Files: change" in x)
    assert "Rooks always asks you first" in out and out.count("Rooks always asks you first") == 2
    assert "Waiting for your IT team" in out and "/work it chats" in out
    assert "tenant" not in out.lower() and "Files.Read.All" not in out  # technical detail stays under Advanced in the app
    assert line


def test_work_without_an_account_says_how_to_connect(app):
    app.status = {**STATUS, "account": None, "features": [{**f, "state": "off", "state_words": "Off"} for f in STATUS["features"]]}
    out = _say(_agent(app.url))
    assert "No work account yet" in out and "/work connect microsoft" in out


def test_connect_and_switches_open_the_sign_in_in_your_browser(app, no_real_app):
    out = _say(_agent(app.url), "connect microsoft")
    assert no_real_app == ["https://login.example/authorize?scope=openid"]
    assert "Finish signing in, in your browser" in out
    out = _say(_agent(app.url), "on files")
    assert ("POST", "/api/work/features/files_read", {"on": True}) in app.calls
    assert no_real_app[-1] == "https://login.example/authorize?scope=Files" and "Finish signing in" in out
    out = _say(_agent(app.url), "off chats")
    assert ("POST", "/api/work/features/chats_read", {"on": False}) in app.calls and "Chats: read is off" in out
    _say(_agent(app.url), "on posting")
    assert ("POST", "/api/work/features/chats_post", {"on": True}) in app.calls
    out = _say(_agent(app.url), "on everything")
    assert "There is no switch called everything" in out


def test_files_search_read_save_and_open(app, monkeypatch):
    out = _say(_agent(app.url), "files budget")
    assert "1  Q3 plan.txt" in out and "OneDrive" in out and "2  Price list.txt" in out and "Sales" in out
    assert any(c[1].startswith("/api/work/files?") and "query=budget" in c[1] for c in app.calls)
    out = _say(_agent(app.url), "read 1")
    assert "The Q3 budget is 42,000 euros." in out and ("GET", "/api/work/files/read?file=drv-me%2Ff1", None) in app.calls
    out = _say(_agent(app.url), "save 1")
    assert "Saved to Files: Q3 plan.txt" in out and ("POST", "/api/work/files/save", {"file": "drv-me/f1"}) in app.calls
    opened = []
    monkeypatch.setattr(workroom, "_room_browse", lambda ui, link, arg: opened.append(arg))
    _say(_agent(app.url), "open 2")
    assert opened == ["https://contoso.sharepoint.com/s1"]  # the Room's browser, as /room browse does
    assert "Say which one" in _say(_agent(app.url), "read 9")
    assert "Nothing found" in _say(_agent(app.url), "files nothing")


def test_chats_read_and_a_post_waits_in_needs_you(app):
    out = _say(_agent(app.url), "chats")
    assert "1  Lee Park" in out and "2  Sales team, General" in out
    out = _say(_agent(app.url), "chat 1")
    assert "Lee Park" in out and "Can you send me the Q3 plan?" in out
    out = _say(_agent(app.url), "post 1 Sending it now")
    assert ("POST", "/api/work/hold", {"tool": "work_chat_post", "args": {"chat": "chat:19:lee", "text": "Sending it now"}}) in app.calls
    assert "Waiting for your OK in Needs you: Post in Teams: Lee Park" in out and "/needs approve" in out
    # nothing else was asked of the app: the terminal never posts by itself
    assert [c for c in app.calls if c[0] == "POST" and c[1] != "/api/work/hold"] == []
    assert "Say what to post" in _say(_agent(app.url), "post 1")


def test_tasks_and_the_note_for_it(app):
    out = _say(_agent(app.url), "tasks")
    assert ("POST", "/api/work/tasks/sync", None) in app.calls
    assert "Draft the launch post" in out and "Planner" in out and "Call the printer" in out and "To Do" in out
    assert "Water plants" not in out
    out = _say(_agent(app.url), "it chats")
    assert "Hello IT team" in out and "Chat.Read" in out


def test_the_shared_bridge_key_is_refused_and_said_plainly(app):
    out = _say(_agent(app.url, key=BRIDGE))
    assert "terminal's own sign in" in out and "rooks login" in out


def test_work_is_listed_in_help():
    assert "/work" in words.COMMANDS
    assert "/work" in words.help_text()


# --- Google Workspace: the same /work, the suite's own words (design 0012, section 2.3) --------------------------------
GOOGLE_NAMES = {"suite": "Google Workspace", "files": "Google Drive", "home": "My Drive", "sites": "Shared drives",
                "chats": "Google Chat", "meetings": "Google Meet", "tasks": "Google Tasks"}


def _google(app):
    app.status = {**STATUS, "account": {**STATUS["account"], "provider": "google", "email": "ana@contoso.example"}, "names": GOOGLE_NAMES}


def test_work_without_an_account_offers_both_suites(app):
    app.status = {**STATUS, "account": None, "features": [{**f, "state": "off", "state_words": "Off"} for f in STATUS["features"]]}
    out = _say(_agent(app.url))
    assert "/work connect microsoft" in out and "/work connect google" in out and "comes next" not in out


def test_connect_google_opens_googles_own_sign_in(app, no_real_app):
    out = _say(_agent(app.url), "connect google")
    assert ("POST", "/api/work/connect/google", {}) in app.calls
    assert no_real_app and "Finish signing in, in your browser" in out and "Microsoft" not in out


def test_a_google_account_speaks_googles_words(app, monkeypatch):
    _google(app)
    out = _say(_agent(app.url))
    assert "Google Workspace" in out and "ana@contoso.example" in out
    # Google Tasks in the tasks header, never Planner or To Do
    real = workroom.call

    def fake_call(link, method, path, body=None, timeout=30):
        if path == "/api/work/tasks/sync":
            return {"gtasks": 2}
        if path == "/api/tasks":
            return [{"id": 7, "title": "Send the invoice", "status": "todo", "due": "2026-11-20", "origin": "gtasks"}]
        return real(link, method, path, body, timeout=timeout) if body is not None else real(link, method, path, timeout=timeout)

    monkeypatch.setattr(workroom, "call", fake_call)
    out = _say(_agent(app.url), "tasks")
    assert "2 in Google Tasks" in out and "Send the invoice" in out and "Planner" not in out


def test_google_chat_spaces_and_a_post_say_google_chat(app, monkeypatch):
    _google(app)
    real = workroom.call

    def fake_call(link, method, path, body=None, timeout=30):
        if path.startswith("/api/work/chats?"):
            return {"chats": [{"chat": "space:DM1", "name": "Direct message", "kind": "chat"},
                              {"chat": "space:AAA", "name": "Sales team", "kind": "space"}]}
        if path == "/api/work/hold":
            return {"held": True, "already_asked": False, "id": "a:9", "title": "Post in Google Chat: Sales team"}
        return real(link, method, path, body, timeout=timeout) if body is not None else real(link, method, path, timeout=timeout)

    monkeypatch.setattr(workroom, "call", fake_call)
    out = _say(_agent(app.url), "chats")
    assert "2  Sales team" in out and "space" in out
    out = _say(_agent(app.url), "post 2 Numbers please")
    assert "Post in Google Chat: Sales team" in out and "Nothing was posted yet" in out
