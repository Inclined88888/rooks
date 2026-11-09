"""Start a frozen workbench-server, check it answers like the desktop shell expects, stop it.

Usage: python desktop/scripts/smoke_sidecar.py [--room-browser] <path to workbench-server[.exe]>
Exit code 0 means: /healthz is ok, the launch token opens a session that lands on /welcome,
a wrong token is refused, and the built frontend is served.

With --room-browser it also proves the Room's browser starts from the packaged program (macOS and Linux): the Room is
started in a throwaway folder, the browser opens a test page served on loopback by a separate process, the page's text
is read back and a frame (a JPEG of the page) arrives. When it does not start, the plain reason and the Advanced detail
the app keeps are printed. A path ending in .py runs that script with this Python (for trying it out of a checkout).
"""

import http.cookiejar
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

PAGE = ("<!doctype html><title>Room smoke page</title>"
        "<body style='background:#2a6;color:#fff;font:40px sans-serif'><h1 id='m'>room-browser-smoke-42</h1></body>")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def get(url: str, follow: bool = True):
    opener = urllib.request.build_opener() if follow else urllib.request.build_opener(NoRedirect)
    try:
        r = opener.open(url, timeout=5)
        return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Signed:
    """Calls to the app as the signed-in desktop window: the launch token's session cookie and the X-Workbench header."""

    def __init__(self, base: str, token: str) -> None:
        self.base = base
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), NoRedirect)
        try:
            self.opener.open(f"{base}/api/desktop/session?token={token}", timeout=10)
        except urllib.error.HTTPError as e:
            if e.code != 303:
                raise
        assert any(c.name == "wb_session" for c in self.jar), "no session cookie"

    def call(self, method: str, path: str, body: dict | None = None, timeout: float = 90):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(f"{self.base}{path}", data=data, method=method,
                                     headers={"X-Workbench": "1", "Content-Type": "application/json"})
        try:
            r = self.opener.open(req, timeout=timeout)
            return r.status, r.headers.get("content-type", ""), r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers.get("content-type", ""), e.read()


def serve_page(folder: Path):
    """The test page on loopback, from a process of its own (the browser refuses the app's own ports)."""
    (folder / "page.html").write_text(PAGE)
    port = free_port()
    proc = subprocess.Popen([sys.executable, "-I", "-m", "http.server", str(port), "--bind", "127.0.0.1",
                             "--directory", str(folder)], cwd=str(folder), stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL)
    deadline = time.time() + 20
    while True:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=1).close()
            return port, proc
        except OSError:
            if time.time() > deadline or proc.poll() is not None:
                proc.kill()
                raise AssertionError("the test page server did not start")
            time.sleep(0.1)


def why_not(app: Signed) -> str:
    """What the app says about the browser's last start: the plain words and the Advanced detail."""
    _, _, body = app.call("GET", "/api/room/browser")
    try:
        failed = json.loads(body).get("failed") or {}
    except ValueError:
        return body.decode(errors="replace")[:800]
    return f"{failed.get('words')}\n  reason: {failed.get('reason')}\n  advanced:\n{failed.get('advanced')}"


def room_browser(app: Signed, scratch: Path) -> int:
    site = scratch / "site"
    site.mkdir()
    port, server = serve_page(site)
    try:
        status, _, body = app.call("POST", "/api/room/up")
        assert status == 200 and json.loads(body).get("running") is True, f"the Room did not start: {status} {body[:400]!r}"
        print("ok   the Room started")
        _, _, body = app.call("GET", "/api/room/status")
        can = json.loads(body).get("can") or {}
        if can.get("browser") is not True:
            print(f"FAIL the Room has no browser here: {can.get('browser_off_reason')}")
            return 1
        print("ok   status says the Room has a browser here")
        status, _, body = app.call("POST", "/api/room/browser/open", {"address": f"127.0.0.1:{port}/page.html"})
        if status != 200:
            print(f"FAIL the Room's browser did not open the page ({status}): {body[:300]!r}\n  {why_not(app)}")
            return 1
        print("ok   the Room's browser opened the test page")
        deadline = time.time() + 30
        while True:
            status, _, body = app.call("GET", "/api/room/browser/page")
            text = json.loads(body).get("text", "") if status == 200 else ""
            if "room-browser-smoke-42" in text:
                break
            if time.time() > deadline:
                print(f"FAIL the page's text never arrived ({status}): {body[:300]!r}")
                return 1
            time.sleep(0.5)
        print("ok   the page's text came back through the browser's pipe")
        status, kind, frame = app.call("GET", "/api/room/browser/frame")
        if status != 200 or kind != "image/jpeg" or frame[:3] != b"\xff\xd8\xff" or len(frame) < 1000:
            print(f"FAIL no frame arrived: {status} {kind} {len(frame)} bytes")
            return 1
        print(f"ok   a frame arrived: a {len(frame)} byte JPEG of the page")
        status, _, _ = app.call("POST", "/api/room/browser/close")
        assert status == 200, f"close gave {status}"
        print("ok   the browser closed")
        return 0
    finally:
        app.call("POST", "/api/room/down")
        server.terminate()
        try:
            server.wait(5)
        except subprocess.TimeoutExpired:
            server.kill()


def main(binary: str, with_browser: bool = False) -> int:
    port = free_port()
    token = "smoke-" + "x" * 40
    base = f"http://127.0.0.1:{port}"
    argv = [sys.executable, binary] if binary.endswith(".py") else [binary]
    with tempfile.TemporaryDirectory() as scratch:
        data = Path(scratch) / "data"
        data.mkdir()
        env = {**os.environ, "WORKBENCH_DESKTOP_TOKEN": token}
        if with_browser:  # a throwaway Room: a folder and shell of its own, never this computer's real one
            env.update(ROOKS_TRY_HOME=str(Path(scratch) / "room"), ROOKS_TRY_DRIVER="shell")
            env.pop("ROOKS_TRY_OFFLINE", None)
        proc = subprocess.Popen([*argv, "--port", str(port), "--data-dir", str(data), "--exit-with-parent"],
                                stdin=subprocess.PIPE, env=env)
        started = time.time()
        try:
            while True:
                try:
                    status, _, body = get(f"{base}/healthz")
                    if status == 200:
                        break
                except OSError:
                    pass
                if proc.poll() is not None:
                    print(f"FAIL: sidecar exited with {proc.returncode}")
                    return 1
                if time.time() - started > 120:
                    print("FAIL: no /healthz answer in 120 s")
                    return 1
                time.sleep(0.5)
            print(f"ok   /healthz after {time.time() - started:.1f}s: {body.decode()}")
            status, headers, _ = get(f"{base}/api/desktop/session?token=wrong", follow=False)
            assert status == 403, f"wrong token gave {status}"
            print("ok   wrong launch token refused (403)")
            status, headers, _ = get(f"{base}/api/desktop/session?token={token}", follow=False)
            assert status == 303 and headers.get("location") == "/welcome", (status, headers)
            assert "wb_session=" in headers.get("set-cookie", ""), "no session cookie"
            print("ok   launch token opens a session and lands on /welcome")
            status, _, body = get(f"{base}/welcome")
            assert status == 200 and b'<div id="root">' in body, "frontend not served"
            print("ok   frontend served")
            if with_browser:
                return room_browser(Signed(base, token), Path(scratch))
            return 0
        finally:
            proc.stdin.close()  # --exit-with-parent: closing stdin is how the shell's exit looks to the sidecar
            try:
                proc.wait(timeout=10)
                print(f"ok   sidecar exited by itself when its stdin closed (code {proc.returncode})")
            except subprocess.TimeoutExpired:
                proc.kill()
                print("WARN sidecar did not exit on stdin close; killed")


if __name__ == "__main__":
    args = sys.argv[1:]
    browser = "--room-browser" in args
    args = [a for a in args if a != "--room-browser"]
    sys.exit(main(args[0], with_browser=browser))
