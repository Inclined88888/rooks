"""The Room's browser in the app (design 0007, sections 1.1, 1.3, 1.4, 1.6, 1.7 and 3).

A real Chromium the app starts over a pipe, with its profile in the Room's home, seen only as a stream over a socket
that follows the Room terminal's rules (signed in, same origin, loopback, one viewer). Tabs, the address bar, back,
forward, reload, input, page text, a still for the phone, downloads into the Room's files, the tab and memory caps, Stop,
Save a point and Start over closing it first, and an app restart that reopens the tabs and says why the browser closed.
Status says whether the Room has a browser here and, when not, why.

The tests that need a real Chromium start one (Playwright's, or the system's) and skip when none can start here,
except with ROOM_BROWSER_TESTS_REQUIRED=1 (CI), where that fails the test instead.
"""

from __future__ import annotations

import http.server
import json
import os
import sys
import threading
import time
from pathlib import Path

import pytest
from starlette.websockets import WebSocketDisconnect

ROOT = Path(__file__).resolve().parents[3] / "rooks-try"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="the Room's browser is not on Windows yet")
ORIGIN = {"origin": "http://testserver"}

PAGE = """<!doctype html><title>Test page</title>
<body style="margin:0">
<button id="b" style="position:absolute;left:20px;top:20px;width:200px;height:80px"
  onclick="document.getElementById('out').textContent='clicked-' + (6*7)">Press</button>
<input id="i" style="position:absolute;left:20px;top:140px;width:300px;height:30px"
  oninput="document.getElementById('echo').textContent='typed:' + this.value">
<p id="echo" style="position:absolute;left:400px;top:140px"></p>
<p id="out" style="position:absolute;left:20px;top:200px">waiting</p>
<a id="dl" href="notes.txt" download="notes.txt" style="position:absolute;left:20px;top:260px">get</a>
<a id="next" href="second.html" style="position:absolute;left:20px;top:300px">next</a>
</body>"""


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve_folder(folder: Path):
    """A loopback web server for `folder`, in a process of its own: a server in the test's own process would be on one
    of this app's own ports, which the Room's browser refuses. Returns (port, process)."""
    import socket
    import subprocess

    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    proc = subprocess.Popen([sys.executable, "-I", "-m", "http.server", str(port), "--bind", "127.0.0.1",
                             "--directory", str(folder)], cwd=str(folder), stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 15
    while True:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=1).close()
            return port, proc
        except OSError:
            if time.monotonic() > deadline or proc.poll() is not None:
                proc.kill()
                raise AssertionError("the test web server did not start")
            time.sleep(0.05)


def stop_serving(proc) -> None:
    proc.terminate()
    try:
        proc.wait(5)
    except Exception:  # noqa: BLE001
        proc.kill()


@pytest.fixture()
def site(tmp_path):
    """A small web site on loopback (not the app's port): a page with a button, a field and a download."""
    folder = tmp_path / "site"
    folder.mkdir()
    (folder / "page.html").write_text(PAGE)
    (folder / "second.html").write_text("<title>Second</title><p>the second page</p>")
    (folder / "notes.txt").write_text("words from the web")
    port, proc = serve_folder(folder)
    yield port
    stop_serving(proc)


@pytest.fixture()
def room_home(client, tmp_path, monkeypatch):
    from app import config, room, room_browser, room_terminal

    monkeypatch.setenv("ROOKS_TRY_HOME", str(tmp_path / "try"))
    monkeypatch.setenv("ROOKS_TRY_DRIVER", "shell")
    monkeypatch.delenv("ROOKS_TRY_OFFLINE", raising=False)
    if Path("/opt/pw-browsers").is_dir() and not os.environ.get("PLAYWRIGHT_BROWSERS_PATH"):
        monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers")
    monkeypatch.setattr(config, "TRY_URL", "")
    monkeypatch.setattr(config, "TRY_API_KEY", "")
    room.reset()
    room_terminal.reset_for_tests(restart=False)
    room_browser.reset_for_tests()
    yield tmp_path / "try"
    room_browser.reset_for_tests()
    room_terminal.reset_for_tests(restart=False)
    client.post("/api/room/down")
    room.reset()


@pytest.fixture()
def on(client, room_home):
    assert client.post("/api/room/up").json()["running"] is True
    return room_home


@pytest.fixture()
def local(monkeypatch):
    from app import terminal_pty

    monkeypatch.setattr(terminal_pty, "_is_local", lambda ws: True)  # TestClient's peer is "testclient", not loopback
    return terminal_pty


_PROBE: dict = {}


@pytest.fixture()
def chromium(on):
    """A real browser can start here (once per run: a probe start and close), else the test is skipped."""
    from rooks_try import browser as rb

    if "ok" not in _PROBE:
        engine = rb.find_engine()
        reason = "no Chromium on this computer"
        if engine is not None:
            probe_home = on / "probe-home"
            probe_home.mkdir(parents=True, exist_ok=True)
            s = rb.Session(engine, probe_home)
            try:
                s.start()
                reason = ""
            except Exception as e:  # noqa: BLE001
                reason = f"Chromium cannot start here: {e}"
            finally:
                s.close()
        _PROBE["ok"], _PROBE["reason"] = not reason, reason
    if not _PROBE["ok"]:
        if os.environ.get("ROOM_BROWSER_TESTS_REQUIRED") == "1":  # CI: the walls are tested, never skipped quietly
            pytest.fail(f"ROOM_BROWSER_TESTS_REQUIRED is set but {_PROBE['reason']}")
        pytest.skip(_PROBE["reason"])
    return on


def _status(client) -> dict:
    return client.get("/api/room/status").json()


def _open(client, address: str, new_tab: bool = False) -> dict:
    r = client.post("/api/room/browser/open", json={"address": address, "new_tab": new_tab})
    assert r.status_code == 200, r.text
    return r.json()


def _page(client) -> dict:
    r = client.get("/api/room/browser/page")
    assert r.status_code == 200, r.text
    return r.json()


def _wait_page(client, needle: str, timeout: float = 15.0) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        p = _page(client)
        if needle in p["text"]:
            return p
        if time.monotonic() > deadline:
            raise AssertionError(f"never saw {needle!r}: {p}")
        time.sleep(0.15)


def _recv(ws, timeout: float = 15.0) -> dict:
    """The socket's next message, or a failure after `timeout` seconds (never a test that waits forever)."""
    import anyio

    async def get():
        with anyio.fail_after(timeout):
            return await ws._send_rx.receive()

    return ws.portal.call(get)


def _state(ws, until=lambda s: True, limit: int = 300) -> dict:
    """The next state message the socket sends that matches, skipping frames."""
    for _ in range(limit):
        msg = _recv(ws)
        if msg.get("type") == "websocket.close":
            raise AssertionError(f"closed: {msg}")
        if msg.get("bytes"):
            _FRAMES[id(ws)] = msg["bytes"]  # a frame that came first is kept for _frame
        if msg.get("text"):
            data = json.loads(msg["text"])
            if data.get("type") == "state" and until(data):
                return data
    raise AssertionError("no such state")


_FRAMES: dict = {}


def _frame(ws, limit: int = 300) -> bytes:
    """A frame the socket sent (the page only sends one when it changes, so one seen while waiting for state counts)."""
    if id(ws) in _FRAMES:
        return _FRAMES.pop(id(ws))
    for _ in range(limit):
        msg = _recv(ws)
        if msg.get("bytes"):
            return msg["bytes"]
    raise AssertionError("no frame arrived")


# --- status ------------------------------------------------------------------------------------------------------------------
def test_status_says_whether_the_room_has_a_browser_and_why_not(client, room_home, monkeypatch):
    from app import db, room_browser
    from rooks_try import browser as rb

    monkeypatch.setattr(room_browser, "_engine", lambda: rb.Engine("/x/chrome", "system"))
    can = _status(client)["can"]
    assert can["browser"] is True and can["browser_off_reason"] is None
    assert "browser" in _status(client)  # what the browser is doing: open, tabs, a note

    monkeypatch.setattr(room_browser, "_engine", lambda: None)
    can = _status(client)["can"]
    assert can["browser"] is False and can["browser_off_reason"] == "no_engine"

    monkeypatch.setattr(room_browser, "_engine", lambda: rb.Engine("/x/chrome", "system"))
    try:
        assert client.put("/api/settings", json={"room_browser": False}).json()["room_browser"] is False
        can = _status(client)["can"]
        assert can["browser"] is False and can["browser_off_reason"] == "switched_off"
    finally:
        db.set_setting("room_browser", "1")

    monkeypatch.setattr(room_browser, "_platform", lambda: "win32")
    can = _status(client)["can"]
    assert can["browser"] is False and can["browser_off_reason"] == "windows"


def test_a_helpers_room_has_no_browser_here(client, room_home, monkeypatch):
    from app import config, room

    monkeypatch.setattr(config, "TRY_URL", "http://127.0.0.1:9")
    monkeypatch.setattr(room, "_remote", _fake_remote)
    room.reset()
    can = _status(client)["can"]
    assert can["browser"] is False and can["browser_off_reason"] == "helper"


async def _fake_remote(method, path, json=None, timeout=0):
    class R:
        status_code = 200

        def json(self):
            return {"running": True, "driver": "shell", "label": "A private folder and shell", "isolation": "none"}

    return R()


def test_the_browser_needs_the_room_on_and_reads_never_start_it(client, room_home, monkeypatch):
    from app import room_browser
    from rooks_try import browser as rb

    monkeypatch.setattr(room_browser, "_engine", lambda: rb.Engine("/x/chrome", "system"))
    started = []
    monkeypatch.setattr(room_browser, "_new_session", lambda *a, **k: started.append(1))
    r = client.post("/api/room/browser/open", json={"address": "example.com"})
    assert r.status_code == 409 and r.json()["detail"] == "The Room is off. Start it first."
    assert client.post("/api/room/up").json()["running"] is True
    for path in ("/api/room/browser/page", "/api/room/browser/tabs", "/api/room/browser/frame"):
        r = client.get(path)
        assert r.status_code == 409, (path, r.text)
        assert r.json()["detail"] == "The Room's browser is closed. Open a page first."
    assert started == []
    monkeypatch.setattr(room_browser, "_engine", lambda: None)
    r = client.post("/api/room/browser/open", json={"address": "example.com"})
    assert r.status_code == 501 and r.json()["detail"] == "The Room has no browser yet."


# --- who may watch and drive ---------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("case", ["signed_out", "other_origin", "remote", "switched_off"])
def test_who_may_not_open_the_browsers_socket(client, on, monkeypatch, case):
    from app import db, room_browser, terminal_pty
    from rooks_try import browser as rb

    monkeypatch.setattr(room_browser, "_engine", lambda: rb.Engine("/x/chrome", "system"))
    monkeypatch.setattr(room_browser, "_new_session", lambda *a, **k: pytest.fail("a refused socket started the browser"))
    monkeypatch.setattr(terminal_pty, "_is_local", lambda ws: case != "remote")
    headers = {"origin": "https://evil.example"} if case == "other_origin" else ORIGIN
    if case == "signed_out":
        monkeypatch.setattr(terminal_pty, "check_session", lambda cookie: False)
    if case == "switched_off":
        db.set_setting("room_browser", "0")
    want = {"signed_out": 4401}.get(case, 4403)
    try:
        with client.websocket_connect("/api/room/browser/ws", headers=headers) as ws:
            with pytest.raises(WebSocketDisconnect) as e:
                ws.receive_text()
        assert e.value.code == want, (case, e.value.code, e.value.reason)
        assert "Workbench" not in e.value.reason and "pipe" not in e.value.reason
    finally:
        db.set_setting("room_browser", "1")


def test_the_terminal_key_browses_and_reads_but_the_phone_routes_are_the_persons(client, on, monkeypatch):
    from fastapi.testclient import TestClient

    from app import main, room_browser

    from rooks_try import browser as rb

    monkeypatch.setattr(room_browser, "_engine", lambda: rb.Engine("/x/chrome", "system"))
    fake = _FakeSession()
    monkeypatch.setattr(room_browser, "_new_session", lambda *a, **k: fake)
    token = client.post("/api/cli-token").json()["token"]
    anon = TestClient(main.app)
    key = {"Authorization": f"Bearer {token}", "X-Workbench": "1"}
    r = anon.post("/api/room/browser/open", json={"address": "example.com/a?secret=1"}, headers=key)
    assert r.status_code == 200, r.text
    assert anon.get("/api/room/browser/tabs", headers=key).status_code == 200
    assert anon.get("/api/room/browser/page", headers=key).status_code == 200
    assert anon.get("/api/room/browser/frame", headers=key).status_code == 401
    assert anon.post("/api/room/browser/act", json={"kind": "click", "x": 1, "y": 1}, headers=key).status_code == 401
    assert anon.post("/api/room/browser/close", headers=key).status_code == 401
    assert anon.get("/api/room/browser/tabs").status_code == 401
    # the run log has where it went without its query
    from app import db

    row = db.one("SELECT args, detail FROM actions WHERE tool = 'use_room' AND args LIKE '%browse%' ORDER BY id DESC LIMIT 1")
    assert row and "example.com/a" in row["args"] and "secret" not in row["args"] and "secret" not in row["detail"]


def test_a_bridge_key_never_reads_the_rooms_signed_in_pages(client, on, monkeypatch):
    """Review finding: the helpers' shared key (app.json's, Rooks Desk's) read the Room browser's open page and tabs with
    the terminal's channel header. Pages steer those helpers, and the Room's browser holds sign-ins: reading it needs the
    person or the Terminal access token, as opening a page does."""
    from fastapi.testclient import TestClient

    from app import config, main, room_browser
    from rooks_try import browser as rb

    monkeypatch.setattr(room_browser, "_engine", lambda: rb.Engine("/x/chrome", "system"))
    monkeypatch.setattr(room_browser, "_new_session", lambda *a, **k: _FakeSession())
    monkeypatch.setattr(config, "BROWSER_API_KEY", "b" * 40)
    monkeypatch.setattr(config, "DESK_API_KEY", "d" * 40)
    assert client.post("/api/room/browser/open", json={"address": "example.com/a"}).status_code == 200
    anon = TestClient(main.app)
    for key in ("b" * 40, "d" * 40):
        shared = {"Authorization": f"Bearer {key}", "X-Workbench-Channel": "rooks-code"}
        assert anon.get("/api/room/browser/page", headers=shared).status_code == 401, key
        assert anon.get("/api/room/browser/tabs", headers=shared).status_code == 401, key
        assert anon.get("/api/room/status", headers=shared).status_code == 200  # the Room's status still reads
    token = client.post("/api/cli-token").json()["token"]
    mine = {"Authorization": f"Bearer {token}"}
    assert anon.get("/api/room/browser/page", headers=mine).status_code == 200
    assert anon.get("/api/room/browser/tabs", headers=mine).status_code == 200


def test_the_apps_own_port_is_refused_before_any_browser_route_learns_it(client, on, monkeypatch):
    """Review finding: the app's port was learned only from the browser's own routes and socket, so a browser the
    assistant started first (and every browser after an app restart, until the person opened the Browser window)
    refused nothing. The ports this app's process listens on are known when the browser starts."""
    import asyncio
    import socket

    from app import room_browser
    from rooks_try import browser as rb

    monkeypatch.setattr(room_browser, "_engine", lambda: rb.Engine("/x/chrome", "system"))
    made: dict = {}

    def new(engine, home, **kw):
        made.update(kw)
        return _FakeSession()

    monkeypatch.setattr(room_browser, "_new_session", new)
    room_browser.reset_for_tests()  # a new run of the app: nothing learned from a request yet
    listener = socket.socket()  # where this app's process is reached, as uvicorn's own socket is
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    port = listener.getsockname()[1]
    try:
        asyncio.run(room_browser.ensure())
        assert port in made["app_ports"], made.get("app_ports")
    finally:
        listener.close()


def test_a_browser_that_cannot_tell_where_the_app_is_does_not_start(client, on, monkeypatch):
    """Fail closed: when no port of this app is known (nothing found listening, no request seen), the browser stays shut
    and says why in plain words."""
    import asyncio

    from fastapi import HTTPException

    from app import room_browser
    from rooks_try import browser as rb

    monkeypatch.setattr(room_browser, "_engine", lambda: rb.Engine("/x/chrome", "system"))
    monkeypatch.setattr(room_browser, "_new_session", lambda *a, **k: _FakeSession())
    monkeypatch.setattr(room_browser, "listening_ports", lambda: set())
    room_browser.reset_for_tests()
    with pytest.raises(HTTPException) as e:
        asyncio.run(room_browser.ensure())
    assert e.value.detail == room_browser.APP_UNKNOWN
    assert "port" not in e.value.detail.lower() and room_browser.session() is None


def test_every_request_to_the_app_tells_the_browser_its_port(client, on, monkeypatch):
    """A running browser learns a new port of this app from any request, not only from its own routes."""
    from app import room_browser

    room_browser.reset_for_tests()
    client.get("/api/room/status", headers={"host": "127.0.0.1:47123"})
    assert 47123 in room_browser._PORTS


class _FakeSession:
    """Stands in for a running browser where the test is about the app's side only."""

    def __init__(self):
        self.tabs_ = []
        self.closed_reason = None
        self.walled = True
        self.inside_home = Path("/home/x")
        self.on_change = self.on_frame = None
        self.proc = None
        self.notes = []
        self.view = (1280, 800)

    @property
    def tabs(self):
        return self.tabs_

    def start(self):
        pass

    def alive(self):
        return self.closed_reason is None

    def close(self, reason="closed"):
        self.closed_reason = reason

    def rows(self):
        return [{"id": t, "url": "https://example.com/a?secret=1", "title": "Example", "asleep": False,
                 "loading": False, "blocked": None} for t in self.tabs_]

    @property
    def active(self):
        return self.tabs_[-1] if self.tabs_ else None

    def new_tab(self, url=None, activate=True):
        self.tabs_.append(f"t{len(self.tabs_)}")
        return self.tabs_[-1]

    def navigate(self, tid, address, wait=False, timeout=20.0):
        return {"url": "https://example.com/a?secret=1"}

    def restore(self, saved, active=0):
        return []

    def page_text(self, tid=None, limit=8000):
        return "hello"

    def history(self, tid=None):
        return {"back": False, "forward": False}

    def take_notes(self):
        return []

    def tab(self, tid=None):
        class T:
            url, title, blocked = "https://example.com/a?secret=1", "Example", None
        return T()

    def watch(self, on):
        pass


# --- a real browser --------------------------------------------------------------------------------------------------------------
def test_frames_and_state_reach_the_socket_and_a_click_changes_the_page(client, chromium, local, site):
    with client.websocket_connect("/api/room/browser/ws", headers=ORIGIN) as ws:
        first = _state(ws)
        assert first["open"] is True
        ws.send_text(json.dumps({"type": "resize", "width": 800, "height": 600}))
        ws.send_text(json.dumps({"type": "nav", "action": "go", "address": f"127.0.0.1:{site}/page.html"}))
        st = _state(ws, lambda s: any("page.html" in (t.get("url") or "") and not t.get("loading") for t in s["tabs"]))
        tab = next(t for t in st["tabs"] if t["id"] == st["active"])
        assert tab["url"] == f"http://127.0.0.1:{site}/page.html"  # a typed address, as the address bar reads it
        jpeg = _frame(ws)
        assert jpeg[:3] == b"\xff\xd8\xff"  # a real JPEG frame
        import io

        from PIL import Image

        assert Image.open(io.BytesIO(jpeg)).size == (800, 600)  # the page area at the window's size: clicks land true
        for event in ("move", "down", "up"):
            ws.send_text(json.dumps({"type": "mouse", "event": event, "x": 100, "y": 50, "button": "left", "clicks": 1}))
        _wait_page(client, "clicked-42")
        # typing into the field: a click to focus it, then characters and a paste
        for event in ("down", "up"):
            ws.send_text(json.dumps({"type": "mouse", "event": event, "x": 100, "y": 155, "button": "left", "clicks": 1}))
        for ch in "hi":
            ws.send_text(json.dumps({"type": "key", "event": "down", "key": ch, "code": f"Key{ch.upper()}", "text": ch}))
            ws.send_text(json.dumps({"type": "key", "event": "up", "key": ch, "code": f"Key{ch.upper()}"}))
        ws.send_text(json.dumps({"type": "text", "text": " there"}))
        _wait_page(client, "typed:hi there")
        # back, forward, reload
        ws.send_text(json.dumps({"type": "nav", "action": "go", "address": f"http://127.0.0.1:{site}/second.html"}))
        _wait_page(client, "the second page")
        ws.send_text(json.dumps({"type": "nav", "action": "back"}))
        assert _wait_page(client, "Press")["url"].endswith("/page.html")  # back (the page may come back as it was)
        ws.send_text(json.dumps({"type": "nav", "action": "forward"}))
        _wait_page(client, "the second page")
        st = client.get("/api/room/browser").json()
        assert st["back"] is True and st["forward"] is False


def test_tabs_new_switch_close_and_eight_at_most(client, chromium, local, site, monkeypatch):
    from app import room_browser

    monkeypatch.setattr(room_browser, "TAB_MAX", 3)
    _open(client, f"127.0.0.1:{site}/page.html")
    _open(client, f"127.0.0.1:{site}/second.html", new_tab=True)
    _open(client, "about:blank", new_tab=True)
    r = client.post("/api/room/browser/open", json={"address": "about:blank", "new_tab": True})
    assert r.status_code == 429 and r.json()["detail"] == "Eight tabs are open. Close one to open another."
    tabs = client.get("/api/room/browser/tabs").json()
    assert len(tabs["tabs"]) == 3
    first = tabs["tabs"][0]["id"]
    with client.websocket_connect("/api/room/browser/ws", headers=ORIGIN) as ws:
        _state(ws)
        ws.send_text(json.dumps({"type": "tab", "action": "switch", "id": first}))
        _state(ws, lambda s: s["active"] == first)
        _wait_page(client, "waiting")
        ws.send_text(json.dumps({"type": "tab", "action": "close", "id": first}))
        st = _state(ws, lambda s: all(t["id"] != first for t in s["tabs"]))
        assert len(st["tabs"]) == 2
    assert room_browser.TABS_FULL == "Eight tabs are open. Close one to open another."


def test_one_viewer_at_a_time(client, chromium, local):
    with client.websocket_connect("/api/room/browser/ws", headers=ORIGIN) as first:
        _state(first)
        with client.websocket_connect("/api/room/browser/ws", headers=ORIGIN) as second:
            _state(second)
            closed = None
            for _ in range(300):
                msg = _recv(first)
                if msg.get("type") == "websocket.close":
                    closed = msg
                    break
            assert closed and closed["reason"] == "This browser was opened in another window."


def test_a_download_lands_in_the_rooms_downloads_and_files_lists_it(client, chromium, site):
    _open(client, f"127.0.0.1:{site}/page.html")
    _wait_page(client, "waiting")
    r = client.post("/api/room/browser/act", json={"kind": "click", "x": 30, "y": 268})
    assert r.status_code == 200, r.text
    deadline = time.monotonic() + 15
    names = []
    while time.monotonic() < deadline:
        names = [e["name"] for e in client.get("/api/room/files", params={"path": "Downloads"}).json()["entries"]]
        if "notes.txt" in names:
            break
        time.sleep(0.2)
    assert names == ["notes.txt"]
    assert (chromium / "home" / "Downloads" / "notes.txt").read_text() == "words from the web"


def test_the_phone_gets_a_still_and_can_tap_scroll_and_type(client, chromium, site):
    _open(client, f"127.0.0.1:{site}/page.html")
    _wait_page(client, "waiting")
    r = client.get("/api/room/browser/frame")
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    assert r.headers["cache-control"] == "no-store" and r.content[:3] == b"\xff\xd8\xff"
    assert client.post("/api/room/browser/act", json={"kind": "click", "x": 100, "y": 50}).status_code == 200
    _wait_page(client, "clicked-42")
    assert client.post("/api/room/browser/act", json={"kind": "click", "x": 100, "y": 155}).status_code == 200
    assert client.post("/api/room/browser/act", json={"kind": "type", "text": "from the phone"}).status_code == 200
    _wait_page(client, "typed:from the phone")
    assert client.post("/api/room/browser/act", json={"kind": "scroll", "dy": 300}).status_code == 200
    assert client.post("/api/room/browser/act", json={"kind": "nav", "action": "go",
                                                       "address": f"127.0.0.1:{site}/second.html"}).status_code == 200
    _wait_page(client, "the second page")
    r = client.post("/api/room/browser/act", json={"kind": "nonsense"})
    assert r.status_code == 400


def test_the_page_text_is_cut_at_eight_thousand_characters(client, chromium, site, tmp_path):
    page = tmp_path / "site" / "long.html"
    page.write_text("<p>" + "word " * 4000 + "</p>")
    _open(client, f"127.0.0.1:{site}/long.html")
    p = _wait_page(client, "word")
    assert len(p["text"]) == 8000 and p["url"].endswith("/long.html")


def test_memory_steps_sleep_a_background_tab_then_close_and_keep_the_tabs(client, chromium, site, monkeypatch):
    from app import room_browser
    from rooks_try import browser as rb

    used = {"n": 0}
    monkeypatch.setattr(room_browser, "_memory_reader", lambda pid: used["n"])
    _open(client, f"127.0.0.1:{site}/page.html")
    _open(client, f"127.0.0.1:{site}/second.html", new_tab=True)
    s = room_browser.session()
    background = s.tabs[0].id
    used["n"] = rb.MEMORY_SLEEP + 1
    assert s.check_memory() == "slept"
    tabs = {t["id"]: t for t in client.get("/api/room/browser/tabs").json()["tabs"]}
    assert tabs[background]["asleep"] is True and tabs[background]["url"].endswith("/page.html")
    assert "A tab was put to sleep to save memory." in client.get("/api/room/browser").json()["notes"]
    used["n"] = rb.MEMORY_CLOSE + 1
    assert s.check_memory() == "closed"
    st = client.get("/api/room/browser").json()
    assert st["open"] is False
    saved, _ = rb.load_tabs(chromium / "home")
    assert [t["url"].rsplit("/", 1)[-1] for t in saved] == ["page.html", "second.html"]


def test_an_app_restart_reopens_the_tabs_and_says_why_the_browser_closed(client, chromium, site):
    from app import actions, assistant, restart, room_browser

    _open(client, f"127.0.0.1:{site}/page.html")
    _open(client, f"127.0.0.1:{site}/second.html", new_tab=True)
    room_browser._at_exit()            # what the app's exit does: the browser closes, its record says a restart did it
    room_browser.reset_for_tests()  # a new run of the app: the files stay
    # the thread cut off by the restart is told, once
    cid = assistant.new_conversation("web")
    actions.add("turn", "running", trace={"channel": "web", "conversation_id": cid}, model="x")
    done = restart.interrupt_running_turns()
    note = next(d for d in done if d["conversation_id"] == cid)
    rows = client.get(f"/api/conversations/{cid}").json()["messages"]
    assert rows[-1]["id"] == note["message_id"]
    assert "The app restarted, so the browser closed. Your tabs and sign-ins are kept." in rows[-1]["content"]
    # the next start reopens the tabs and says which
    st = client.get("/api/room/browser").json()
    assert st["open"] is False and len(st["tabs"]) == 2  # listed from what was saved, before anything starts
    r = client.post("/api/room/browser/start")
    assert r.status_code == 200, r.text
    st = client.get("/api/room/browser").json()
    assert st["open"] is True
    assert st["note"] == "The app restarted, so the browser closed. Your tabs and sign-ins are kept."
    assert st["reopened"] == ["Test page", "Second"]
    assert [t["url"].rsplit("/", 1)[-1] for t in st["tabs"]] == ["page.html", "second.html"]
    _wait_page(client, "the second page")  # the tab that was in front loads; the other waits asleep
    assert [t["asleep"] for t in st["tabs"]] == [True, False]


def test_stop_save_a_point_and_start_over_close_the_browser_first(client, chromium, site):
    from app import room_browser

    _open(client, f"127.0.0.1:{site}/page.html")
    home = chromium / "home"
    cache = home / ".room-browser" / "profile" / "Default" / "Cache"
    deadline = time.monotonic() + 10
    while not cache.exists() and time.monotonic() < deadline:
        time.sleep(0.1)
    r = client.post("/api/room/checkpoint", json={"label": "with browser"})
    assert r.status_code == 200, r.text
    point = Path(r.json()["path"])
    assert (point / ".room-browser" / "profile").is_dir()
    assert not (point / ".room-browser" / "profile" / "Default" / "Cache").exists()
    assert r.json()["browser_reopened"] is True
    st = client.get("/api/room/browser").json()
    assert st["open"] is True and len(st["tabs"]) == 1  # closed for the copy, then back with its tab
    first = room_browser.session()
    assert client.post("/api/room/down").json()["running"] is False
    assert not first.alive() and first.closed_reason == "stop"
    assert client.get("/api/room/browser").json()["open"] is False
    assert len(client.get("/api/room/browser").json()["tabs"]) == 1  # kept
    assert client.post("/api/room/up").json()["running"] is True
    _open(client, "about:blank", new_tab=True)
    second = room_browser.session()
    r = client.post("/api/room/reset", json={"name": point.name})
    assert r.status_code == 200, r.text
    assert not second.alive() and second.closed_reason == "start over"
    assert client.get("/api/room/browser").json()["open"] is False


def test_open_close_and_browse_are_in_the_run_log_without_queries(client, chromium, site):
    from app import db

    before = db.one("SELECT COALESCE(MAX(id), 0) AS n FROM actions")["n"]
    _open(client, f"127.0.0.1:{site}/page.html?token=abc123")
    assert client.post("/api/room/browser/close").status_code == 200
    rows = db.all("SELECT args, detail FROM actions WHERE id > ? AND tool = 'use_room' ORDER BY id", before)
    text = json.dumps(rows)
    assert "open browser" in text and "close browser" in text and "browse" in text
    assert "abc123" not in text and "token=" not in text
    assert f"127.0.0.1:{site}/page.html" in text
