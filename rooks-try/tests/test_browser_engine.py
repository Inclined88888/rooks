"""The Room's browser engine (design 0007, sections 1.1, 1.2, 1.4 and 3).

Where the engine comes from (first found wins: the Room's own checked build, Playwright's Chromium, the system's
Chromium but never the Snap one, then Chrome and Edge as engines only), how it is started (the DevTools protocol over
a pipe, never a debugging port, never without Chromium's own sandbox), what wall it runs behind (bwrap with the Room's
home over the person's home, an unprivileged id inside, the engine read-only, no network when the Room is offline) and
what it never gets (secrets). With a real Chromium (skipped without one): no listening port appears, a file outside the
Room's home is refused while a Room file opens, the app's own address fails, and a download lands in Downloads.
"""

from __future__ import annotations

import hashlib
import http.server
import os
import re
import socket
import sys
import threading
import time
from pathlib import Path

import pytest

from rooks_try import browser as rb

LINUX = pytest.mark.skipif(not sys.platform.startswith("linux"), reason="Linux paths")


def _exe(path: Path, text: str = "#!/bin/sh\nexit 0\n") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(0o755)
    return path


def _which(table: dict):
    return lambda name: table.get(name)


# --- where the engine comes from ------------------------------------------------------------------------------------------
@LINUX
def test_search_order_own_then_playwright_then_system_then_chrome_then_edge(tmp_path):
    root, home = tmp_path / "try", tmp_path / "me"
    own = _exe(root / "tools" / "browser" / "chrome-linux64" / "chrome")
    (root / "tools" / "browser" / "engine.json").write_text('{"sha256": "x", "path": "chrome-linux64/chrome"}')
    pw = _exe(home / ".cache" / "ms-playwright" / "chromium-1200" / "chrome-linux64" / "chrome")
    system = _exe(tmp_path / "usr" / "bin" / "chromium")
    chrome = _exe(tmp_path / "usr" / "bin" / "google-chrome")
    edge = _exe(tmp_path / "usr" / "bin" / "microsoft-edge")
    which = _which({"chromium": str(system), "google-chrome": str(chrome), "microsoft-edge": str(edge)})
    kw = dict(root=root, home=home, env={}, which=which, platform="linux")

    assert rb.find_engine(**kw) == rb.Engine(str(own), "own")
    (root / "tools" / "browser" / "engine.json").unlink()  # a build that was never checked is not the Room's own
    assert rb.find_engine(**kw) == rb.Engine(str(pw), "playwright")
    pw.unlink()
    assert rb.find_engine(**kw) == rb.Engine(str(system), "system")
    system.unlink()
    assert rb.find_engine(**kw) == rb.Engine(str(chrome), "chrome")
    chrome.unlink()
    assert rb.find_engine(**kw) == rb.Engine(str(edge), "edge")
    edge.unlink()
    assert rb.find_engine(**kw) is None


@LINUX
def test_playwright_newest_chromium_wins_and_its_headless_shell_is_never_used(tmp_path):
    cache = tmp_path / "pw"
    _exe(cache / "chromium-999" / "chrome-linux" / "chrome")
    newest = _exe(cache / "chromium-1243" / "chrome-linux64" / "chrome")
    _exe(cache / "chromium_headless_shell-2000" / "chrome-linux" / "headless_shell")
    found = rb.find_engine(root=tmp_path / "try", home=tmp_path / "me", env={"PLAYWRIGHT_BROWSERS_PATH": str(cache)},
                           which=_which({}), platform="linux")
    assert found == rb.Engine(str(newest), "playwright")


@LINUX
def test_snap_chromium_is_skipped(tmp_path):
    wrapper = _exe(tmp_path / "usr" / "bin" / "chromium-browser",
                   "#!/bin/sh\n# This wrapper runs the snap\nexec /snap/bin/chromium \"$@\"\n")
    snapped = tmp_path / "snap" / "bin" / "chromium"
    _exe(snapped)
    which = _which({"chromium-browser": str(wrapper), "chromium": "/snap/bin/chromium"})
    assert rb.find_engine(root=tmp_path / "try", home=tmp_path / "me", env={}, which=which, platform="linux") is None
    assert rb.is_snap("/snap/bin/chromium")
    assert rb.is_snap(str(wrapper))


def test_no_engine_and_windows_reasons(tmp_path):
    assert rb.off_reason(None, platform="linux") == "no_engine"
    assert rb.off_reason(rb.Engine("/x/chrome", "system"), platform="linux") is None
    # Windows has a browser now (design 0011): its only extra reason is the organisation's policy
    assert rb.off_reason(rb.Engine("C:/chrome.exe", "chrome"), platform="win32", policy_read=lambda *a: None) is None
    assert rb.OFF_WORDS["no_engine"] == "The Room has no browser yet."
    assert rb.OFF_WORDS["windows"] == "The Room's browser is not on Windows yet."


def test_a_download_with_the_wrong_sha256_is_refused_and_never_found(tmp_path):
    import tarfile

    src = tmp_path / "build"
    _exe(src / "chrome-linux64" / "chrome")
    archive = tmp_path / "engine.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(src / "chrome-linux64", arcname="chrome-linux64")
    good = hashlib.sha256(archive.read_bytes()).hexdigest()
    root = tmp_path / "try"
    with pytest.raises(ValueError) as e:
        rb.install_engine(archive, "0" * 64, root=root, inner="chrome-linux64/chrome")
    assert "did not match" in str(e.value)
    assert not (root / "tools" / "browser" / "engine.json").exists()
    assert rb.find_engine(root=root, home=tmp_path / "me", env={}, which=_which({}), platform="linux") is None
    path = rb.install_engine(archive, good, root=root, inner="chrome-linux64/chrome")
    assert Path(path).is_file()
    found = rb.find_engine(root=root, home=tmp_path / "me", env={}, which=_which({}), platform="linux")
    assert found == rb.Engine(str(path), "own")


def test_an_archive_that_reaches_outside_its_folder_is_refused(tmp_path):
    import io
    import tarfile

    archive = tmp_path / "evil.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        data = b"x"
        info = tarfile.TarInfo("../../escaped")
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    sha = hashlib.sha256(archive.read_bytes()).hexdigest()
    with pytest.raises(ValueError):
        rb.install_engine(archive, sha, root=tmp_path / "try", inner="chrome-linux64/chrome")
    assert not (tmp_path / "escaped").exists()


# --- how it is started ----------------------------------------------------------------------------------------------------
def test_flags_pipe_headless_profile_in_the_room_and_nothing_forbidden(tmp_path):
    flags = rb.chrome_flags(tmp_path / "home")
    assert "--remote-debugging-pipe" in flags
    assert "--headless=new" in flags
    assert f"--user-data-dir={tmp_path / 'home' / '.room-browser' / 'profile'}" in flags
    assert "--disk-cache-size=104857600" in flags
    for bad in rb.FORBIDDEN_FLAGS:
        assert not any(f == bad or f.startswith(bad + "=") for f in flags), bad
    with pytest.raises(ValueError):
        rb.check_flags([*flags, "--remote-debugging-port=9222"])
    with pytest.raises(ValueError):
        rb.check_flags([*flags, "--no-sandbox"])


@LINUX
def test_bwrap_binds_the_room_home_over_the_persons_home_maps_the_uid_and_goes_offline(tmp_path):
    room_home, me = tmp_path / "try" / "home", tmp_path / "me"
    room_home.mkdir(parents=True)
    engine = rb.Engine(str(_exe(me / ".cache" / "ms-playwright" / "chromium-1" / "chrome-linux64" / "chrome")),
                       "playwright")
    argv, inside = rb.launch_argv(engine, room_home, person_home=me, offline=False, bwrap="/usr/bin/bwrap", uid=0,
                                  gid=0, fds=(7, 8))
    assert argv[0] == sys.executable  # puts the two pipe ends at fds 3 and 4, then runs bwrap
    i = argv.index("/usr/bin/bwrap")
    wall = argv[i:]
    assert inside == me
    assert _pair(wall, "--bind", str(room_home)) == str(me)
    assert _pair(wall, "--uid") == "1000" and _pair(wall, "--gid") == "1000"  # Chromium will not run as root
    assert "--unshare-user" in wall and "--die-with-parent" in wall
    assert "--unshare-net" not in wall
    # the engine lies under the person's home, which the Room's home hides: bound read-only at a fixed place first
    engine_dir = str(Path(engine.path).parent)
    assert _pair(wall, "--ro-bind", engine_dir) == rb.ENGINE_MOUNT
    assert wall.index("--ro-bind", wall.index(engine_dir) - 1) < wall.index("--bind")
    assert rb.ENGINE_MOUNT + "/chrome" in wall
    assert f"--user-data-dir={me / '.room-browser' / 'profile'}" in wall
    off, _ = rb.launch_argv(engine, room_home, person_home=me, offline=True, bwrap="/usr/bin/bwrap", uid=1234,
                            gid=1234, fds=(7, 8))
    assert "--unshare-net" in off
    assert _pair(off, "--uid") == "1234"
    rb.check_flags(argv)


def test_without_bwrap_the_engine_runs_as_the_person_in_the_rooms_home(tmp_path):
    room_home = tmp_path / "try" / "home"
    room_home.mkdir(parents=True)
    engine = rb.Engine("/opt/chromium/chrome", "system")
    argv, inside = rb.launch_argv(engine, room_home, person_home=tmp_path / "me", offline=False, bwrap=None, uid=1000,
                                  gid=1000, fds=(7, 8))
    assert inside == room_home
    assert not any(a.endswith("/bwrap") for a in argv) and "--unshare-user" not in argv
    assert "/opt/chromium/chrome" in argv
    assert f"--user-data-dir={room_home / '.room-browser' / 'profile'}" in argv


def test_the_engines_environment_has_no_secrets_and_its_home_is_the_room(tmp_path):
    base = {"PATH": "/usr/bin:/bin", "OPENAI_API_KEY": "sk-should-not-leak", "APP_SECRET": "s" * 40,
            "GITHUB_TOKEN": "ghp-should-not-leak", "MY_PASSWORD": "pw", "LANG": "C.UTF-8"}
    env = rb.browser_env(tmp_path / "home", base=base)
    assert env["HOME"] == str(tmp_path / "home")
    assert env["LANG"] == "C.UTF-8"
    for name in ("OPENAI_API_KEY", "APP_SECRET", "GITHUB_TOKEN", "MY_PASSWORD"):
        assert name not in env
    assert not any("should-not-leak" in v for v in env.values())


def test_downloads_get_a_safe_unique_name(tmp_path):
    assert rb.safe_name("../../etc/passwd") == "passwd"
    assert rb.safe_name("") == "download"
    assert rb.safe_name("report (final).pdf") == "report _final_.pdf"
    (tmp_path / "a.txt").write_text("1")
    assert rb.unique(tmp_path / "a.txt").name == "a (2).txt"


def test_the_address_bar_rules_match_rooks_browser():
    """The fixtures of rooks-browser/app/test/address.test.mjs, word for word."""
    for s in ["localhost", "localhost:3000/x", "127.0.0.1", "10.0.0.1:8080", "192.168.1.5", "172.16.0.5",
              "172.31.255.1:81/p", "169.254.1.1", "[::1]", "[::1]:8000/y", "[fe80::1]", "printer.local", "nas.internal",
              "app.localhost:5173"]:
        assert rb.normalise(s) == "http://" + s, s
    for s in ["example.com", "172.32.0.1", "8.8.8.8", "en.wikipedia.org/wiki/X", "shop.example.com:8443/cart",
              "[2001:4860::1]"]:
        assert rb.normalise(s) == "https://" + s, s
    assert rb.normalise(" https://example.com/a?b=1 ") == "https://example.com/a?b=1"
    assert rb.normalise("http://example.com") == "http://example.com"
    assert rb.normalise("about:blank") == "about:blank"
    assert rb.normalise("blue widget price") == "https://duckduckgo.com/?q=blue%20widget%20price"
    assert rb.normalise("intranet") == "https://duckduckgo.com/?q=intranet"
    assert rb.normalise("") == rb.HOME_PAGE
    assert rb.normalise(None) == rb.HOME_PAGE


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX file addresses; Windows ones are in test_browser_windows.py")
def test_file_addresses_outside_the_rooms_home_and_the_apps_own_address_are_refused(tmp_path):
    home = tmp_path / "home"
    (home / "Desktop").mkdir(parents=True)
    rule = rb.Rules(home=home, app_ports={8950})
    assert rule.refused(f"file://{home}/Desktop/page.html") is None
    assert rule.refused(f"file://{home}") is None
    assert rule.refused("file:///etc/hostname") == rb.FILE_OUTSIDE
    assert rule.refused(f"file://{home}/../secret") == rb.FILE_OUTSIDE
    assert rule.refused(f"file://{tmp_path}/homeother/x") == rb.FILE_OUTSIDE
    for host in ("127.0.0.1", "localhost", "[::1]", "0.0.0.0", "127.1.2.3"):
        assert rule.refused(f"http://{host}:8950/api/room/status") == rb.APP_ADDRESS, host
    assert rule.refused("http://127.0.0.1:8000/") is None  # another program on this computer is just a page
    assert rule.refused("https://example.com/") is None


def test_save_a_point_leaves_the_browsers_caches_out(tmp_path, monkeypatch):
    from rooks_try import store

    monkeypatch.setenv("ROOKS_TRY_HOME", str(tmp_path / "try"))
    home = store.guest_home()
    prof = home / ".room-browser" / "profile" / "Default"
    for name in ("Cache", "Code Cache", "GPUCache"):
        (prof / name).mkdir(parents=True)
        (prof / name / "data_0").write_text("cached")
    (prof / "Cookies").write_text("signed in")
    (home / "Cache").mkdir()  # the person's own folder of that name is kept
    (home / "Cache" / "mine.txt").write_text("mine")
    meta = store.checkpoint("with browser")
    point = Path(meta["path"])
    assert (point / ".room-browser" / "profile" / "Default" / "Cookies").read_text() == "signed in"
    for name in ("Cache", "Code Cache", "GPUCache"):
        assert not (point / ".room-browser" / "profile" / "Default" / name).exists(), name
    assert (point / "Cache" / "mine.txt").read_text() == "mine"


def _pair(argv: list[str], flag: str, first: str | None = None) -> str | None:
    """The value after `flag` (and after `first`, for two-value flags like --bind SRC DEST)."""
    for i, a in enumerate(argv):
        if a != flag:
            continue
        if first is None:
            return argv[i + 1]
        if argv[i + 1] == first:
            return argv[i + 2]
    return None


# --- a real Chromium -------------------------------------------------------------------------------------------------------
def _real_engine():
    if sys.platform == "win32":
        return None
    env = dict(os.environ)
    if "PLAYWRIGHT_BROWSERS_PATH" not in env and Path("/opt/pw-browsers").is_dir():
        env["PLAYWRIGHT_BROWSERS_PATH"] = "/opt/pw-browsers"
    return rb.find_engine(env=env)


REAL = _real_engine()
needs_chromium = pytest.mark.skipif(REAL is None or sys.platform == "win32",
                                    reason="no Chromium here, or Windows (its real tests are in test_browser_windows.py)")


def _listening_inodes() -> set[str]:
    """The socket inode of every listening TCP socket on this computer (IPv4 and IPv6)."""
    out = set()
    for name in ("tcp", "tcp6"):
        try:
            lines = Path(f"/proc/net/{name}").read_text().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            parts = line.split()
            if parts[3] == "0A":  # LISTEN
                out.add(parts[9])
    return out


def _socket_inodes(pids: list[int]) -> set[str]:
    out = set()
    for pid in pids:
        try:
            for fd in os.listdir(f"/proc/{pid}/fd"):
                link = os.readlink(f"/proc/{pid}/fd/{fd}")
                if link.startswith("socket:["):
                    out.add(link[8:-1])
        except OSError:
            continue
    return out


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):  # noqa: D401
        pass


@pytest.fixture()
def served(tmp_path):
    """A loopback web server standing in for the app (its port is the app's own address)."""
    site = tmp_path / "site"
    site.mkdir()
    (site / "index.html").write_text("<title>app</title><p>the app itself</p>")
    (site / "file.txt").write_text("downloaded words")
    (site / "dl.html").write_text("<a id=a href=file.txt download=notes.txt>get</a>")
    handler = lambda *a, **k: _Quiet(*a, directory=str(site), **k)  # noqa: E731
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    yield srv.server_address[1]
    srv.shutdown()


@pytest.fixture()
def session(tmp_path):
    home = tmp_path / "try" / "home"
    (home / "Desktop").mkdir(parents=True)
    made = []

    def start(**kw):
        s = rb.Session(REAL, home, **kw)
        s.start()
        made.append(s)
        return s

    yield start, home
    for s in made:
        s.close()


def _settle(s, tab, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and not s.tab(tab).blocked:
        time.sleep(0.1)


@needs_chromium
@pytest.mark.skipif(not Path("/proc/net/tcp").exists(), reason="reads /proc")
def test_real_no_port_file_rule_app_address_and_download(session, served, tmp_path):
    start, home = session
    s = start(app_ports={served}, offline=False)
    assert s.alive()
    tab = s.new_tab()
    s.navigate(tab, "data:text/html,<p>up</p>", wait=True)
    tree = rb._tree(s.proc.pid)
    assert len(tree) > 2, "the browser's processes were not found"
    assert not _socket_inodes(tree) & _listening_inodes(), "the browser listens on a TCP port"
    (home / "Desktop" / "page.html").write_text("<title>mine</title><p>a page in the Room</p>")
    s.navigate(tab, f"file://{s.inside_home}/Desktop/page.html", wait=True)
    assert "a page in the Room" in s.page_text(tab)
    hostname = Path("/etc/hostname").read_text().strip() if Path("/etc/hostname").exists() else "no-such-text"
    # typed (or asked for by the assistant): refused before anything loads
    out = s.navigate(tab, "file:///etc/hostname", wait=True)
    assert out["blocked"] == rb.FILE_OUTSIDE
    # a page that sends itself there: the request is refused by the browser's own request rule
    s.evaluate(tab, "location.href = 'file:///etc/hostname'")
    _settle(s, tab)
    assert s.tab(tab).blocked == rb.FILE_OUTSIDE
    assert hostname not in s.page_text(tab)
    out = s.navigate(tab, f"http://127.0.0.1:{served}/", wait=True)
    assert out["blocked"] == rb.APP_ADDRESS
    s.navigate(tab, f"file://{s.inside_home}/Desktop/page.html", wait=True)
    s.evaluate(tab, f"location.href = 'http://localhost:{served}/'")
    _settle(s, tab)
    assert s.tab(tab).blocked == rb.APP_ADDRESS
    assert "the app itself" not in s.page_text(tab)
    # a download from another local server (not the app's port) lands in the Room's Downloads
    s.close()  # one browser on a profile at a time
    s2 = start(app_ports=set(), offline=False)
    t2 = s2.new_tab()
    s2.navigate(t2, f"http://127.0.0.1:{served}/dl.html", wait=True)
    s2.evaluate(t2, "document.getElementById('a').click()")
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline and not (home / "Downloads" / "notes.txt").exists():
        time.sleep(0.2)
    assert (home / "Downloads" / "notes.txt").read_text() == "downloaded words"
    assert not [p for p in (home / "Downloads").iterdir() if p.name != "notes.txt"], "a half named file was left"


@needs_chromium
def test_real_a_tab_is_named_by_its_page_title_after_a_form_post(session, tmp_path):
    """A tab's name is the page's own title, also after a form posts and redirects (the browser's own title event does
    not always come; the title is read when the page has loaded). Never the address standing in for a title."""
    import urllib.parse

    class Site(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body="", where=""):
            data = body.encode()
            self.send_response(code)
            if where:
                self.send_header("Location", where)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path.startswith("/done"):
                return self._send(200, "<title>All done here</title><p>done</p>")
            return self._send(200, "<title>Form</title><form method=post action=/go><input name=a value=1>"
                                   "<button id=b>Go</button></form><script>document.getElementById('b').click()</script>")

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
            return self._send(303, "", "/done")

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Site)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    start, _home = session
    s = start()
    try:
        tid = s.new_tab()
        s.navigate(tid, f"127.0.0.1:{srv.server_address[1]}/form")
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and s.tab(tid).title != "All done here":
            time.sleep(0.1)
        assert s.tab(tid).url.endswith("/done")
        assert s.tab(tid).title == "All done here"
        assert urllib.parse.urlsplit(s.tab(tid).url).netloc not in s.tab(tid).title
    finally:
        srv.shutdown()


# --- review findings: names with a trailing dot, the default ports, an offline Room without bwrap ------------------------------
def test_a_trailing_dot_still_names_this_computer(tmp_path):
    """Chromium resolves `localhost.` and `foo.localhost.` to loopback, so the rule must refuse them too."""
    rule = rb.Rules(home=tmp_path, app_ports={8950})
    for host in ("localhost.", "foo.localhost.", "LOCALHOST.", "localhost..", "127.0.0.1.", "0.0.0.0."):
        assert rule.refused(f"http://{host}:8950/healthz") == rb.APP_ADDRESS, host
    assert rule.refused("http://example.com.:8950/") is None  # a site elsewhere with a dot at the end is just a site


def test_an_app_on_a_default_port_is_matched_without_a_port_in_the_address(tmp_path):
    """Chromium drops :80 and :443 from an address, so a pattern with the port would never see the request."""
    pats = {p["urlPattern"] for p in rb.Rules(home=tmp_path, app_ports={80, 443}).patterns()}
    assert {"http://*", "ws://*", "https://*", "wss://*"} <= pats, pats
    assert rb.Rules(home=tmp_path, app_ports={80}).refused("http://localhost/api/room/status") == rb.APP_ADDRESS
    assert rb.Rules(home=tmp_path, app_ports={443}).refused("https://127.0.0.1/") == rb.APP_ADDRESS


def test_an_offline_room_without_bwrap_still_has_no_network(tmp_path):
    """Without bwrap (macOS, or Linux without it) offline used to be only the Room's proxy variables, which Chrome on
    macOS does not read: the browser itself is pointed at a proxy that answers nothing, loopback included."""
    room_home = tmp_path / "try" / "home"
    room_home.mkdir(parents=True)
    engine = rb.Engine("/opt/chromium/chrome", "system")
    off, _ = rb.launch_argv(engine, room_home, person_home=tmp_path / "me", offline=True, bwrap=None, fds=(7, 8))
    assert any(a.startswith("--proxy-server=") for a in off), off
    assert "--proxy-bypass-list=<-loopback>" in off
    assert "--force-webrtc-ip-handling-policy=disable_non_proxied_udp" in off
    rb.check_flags(off)
    on, _ = rb.launch_argv(engine, room_home, person_home=tmp_path / "me", offline=False, bwrap=None, fds=(7, 8))
    assert not any(a.startswith("--proxy-server=") for a in on)


@needs_chromium
@pytest.mark.skipif(getattr(os, "getuid", lambda: -1)() == 0, reason="Chromium will not start as root without bwrap's ordinary id inside")
def test_real_offline_without_bwrap_loads_nothing(session, served):
    start, _home = session
    s = start(offline=True, bwrap=False)
    assert not s.walled
    tab = s.new_tab()
    s.navigate(tab, f"http://127.0.0.1:{served}/", wait=True, timeout=10)
    assert "the app itself" not in s.page_text(tab)


def test_the_room_loads_where_there_is_no_fcntl():
    """Windows has no fcntl. The Room (and saving a point, which asks the browser module which caches to skip) must
    still load there; on Windows the browser starts through winproc, not fcntl (design 0011)."""
    import subprocess

    code = "import sys; sys.modules['fcntl'] = None; import rooks_try.browser, rooks_try.store; print('ok')"
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=60)
    assert out.stdout.strip() == "ok", out.stderr[-800:]


def test_the_packaged_app_runs_the_pipe_step_with_its_own_program(monkeypatch, tmp_path):
    """The desktop app is one packaged program with no Python to run `-c` with. There the step must be the app's own
    program with the step flag, or the Room's browser never starts (seen on a Mac: "could not start")."""
    monkeypatch.setattr(rb.sys, "frozen", True, raising=False)
    monkeypatch.setattr(rb.sys, "executable", "/Applications/Rooks.app/Contents/MacOS/workbench-server")
    engine = rb.Engine(path="/opt/chrome/chrome", kind="chrome")
    argv, _ = rb.launch_argv(engine, tmp_path / "home", person_home=tmp_path, bwrap=None, fds=(7, 8))
    assert argv[:4] == ["/Applications/Rooks.app/Contents/MacOS/workbench-server", rb.PIPE_STEP_FLAG, "7", "8"], argv
    assert "-c" not in argv[:4]


# --- why it did not start: in plain words, with the detail for Advanced -----------------------------------------------------
POSIX = pytest.mark.skipif(sys.platform == "win32", reason="POSIX scripts stand in for the engine")


def _failing_start(tmp_path, engine_path: str, bwrap=False):
    s = rb.Session(rb.Engine(engine_path, "system"), tmp_path / "home", person_home=tmp_path, bwrap=bwrap)
    with pytest.raises(rb.StartError) as e:
        s.start()
    assert s.alive() is False
    return e.value


@POSIX
def test_no_engine_says_no_browser_was_found(tmp_path):
    """The engine found a moment ago is gone (uninstalled, an update moved it): the words say no browser was found, not
    only "could not start", and Advanced names where it was looked for."""
    err = _failing_start(tmp_path, str(tmp_path / "gone" / "chrome"))
    assert err.reason == "no_engine"
    assert str(err) == rb.START_WORDS["no_engine"] and "no browser" in str(err).lower()
    assert str(tmp_path / "gone" / "chrome") in err.detail


@POSIX
def test_an_engine_that_refuses_to_start_says_so_with_its_last_words_under_advanced(tmp_path):
    engine = _exe(tmp_path / "engine" / "chrome",
                  "#!/bin/sh\necho 'chrome: Missing X server or $DISPLAY' >&2\nexit 7\n")
    err = _failing_start(tmp_path, str(engine))
    assert err.reason == "refused"
    assert str(err) == rb.START_WORDS["refused"] and "refused to start" in str(err)
    assert "Missing X server" in err.detail and "7" in err.detail


@POSIX
def test_a_wall_that_cannot_be_set_up_says_so(tmp_path):
    """bwrap passed its probe but the real start failed (a namespace or a bind refused): the browser stays closed (no
    fallback to running without the wall) and the words say the wall could not be set up."""
    engine = _exe(tmp_path / "engine" / "chrome")
    bwrap = _exe(tmp_path / "bin" / "bwrap",
                 "#!/bin/sh\necho 'bwrap: setting up uid map: Permission denied' >&2\nexit 1\n")
    err = _failing_start(tmp_path, str(engine), bwrap=str(bwrap))
    assert err.reason == "wall"
    assert str(err) == rb.START_WORDS["wall"] and "wall" in str(err)
    assert "setting up uid map" in err.detail


def test_the_start_words_are_plain():
    for reason, words in rb.START_WORDS.items():
        assert words.startswith("The Room's browser could not start"), reason
        assert not re.search(r"https?:|bwrap|stderr|exit code|Traceback|errno|pipe|DevTools", words, re.I), reason
