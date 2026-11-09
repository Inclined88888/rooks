"""The Room's browser on Windows (design 0011, sections 2 and 5.3).

On Windows Chromium reads `--remote-debugging-pipe` from C runtime descriptors 3 and 4, which the C runtime rebuilds at
startup from `STARTUPINFO.lpReserved2`. The Room packs that block itself (winproc.crt_block), starts the engine in a job
of its own with exactly those handles, and never opens a port. The engine is found in the Room's own folder, then
Playwright's, then Google Chrome, then Microsoft Edge; IT policy that switches remote debugging off is respected, not
worked around; a `file://` address with a host (a UNC share, which would send the person's Windows sign-in to that
server) is refused.

The tests at the top run on any computer (they check the search order, the block's bytes, the argv and the rules with
Windows paths). The real ones run on the windows-2022 runner with Edge and with Chrome: the engine starts over its pipe,
a local page gives its text and one frame, a click lands, every engine process is in the browser's job, none of them
listens on a TCP port, the profile lies in the Room's home, a UNC address is refused, and close leaves the job empty.
"""

from __future__ import annotations

import http.server
import json
import os
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from rooks_try import browser as rb
from rooks_try import winproc

WINDOWS = os.name == "nt"
windows_only = pytest.mark.skipif(not WINDOWS, reason="a real Edge or Chrome on Windows (the windows-2022 job)")


def _exe(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"MZ")
    path.chmod(0o755)
    return path


# --- on any computer ---------------------------------------------------------------------------------------------------
def test_search_order_on_windows_own_then_playwright_then_chrome_then_edge(tmp_path):
    root = tmp_path / "try"
    local = tmp_path / "Local"
    pf, pf86 = tmp_path / "Program Files", tmp_path / "Program Files (x86)"
    env = {"LOCALAPPDATA": str(local), "ProgramFiles": str(pf), "ProgramFiles(x86)": str(pf86)}
    kw = dict(root=root, home=tmp_path / "me", env=env, which=lambda name: None, platform="win32")
    assert rb.find_engine(**kw) is None

    own = _exe(root / "tools" / "browser" / "chrome-win64" / "chrome.exe")
    (root / "tools" / "browser" / "engine.json").write_text(json.dumps({"sha256": "x", "path": "chrome-win64/chrome.exe"}))
    _exe(local / "ms-playwright" / "chromium-1100" / "chrome-win" / "chrome.exe")
    pw = _exe(local / "ms-playwright" / "chromium-1200" / "chrome-win" / "chrome.exe")
    _exe(local / "ms-playwright" / "chromium_headless_shell-1200" / "chrome-win" / "headless_shell.exe")
    chrome = _exe(pf / "Google" / "Chrome" / "Application" / "chrome.exe")
    chrome_user = _exe(local / "Google" / "Chrome" / "Application" / "chrome.exe")
    edge = _exe(pf86 / "Microsoft" / "Edge" / "Application" / "msedge.exe")

    assert rb.find_engine(**kw) == rb.Engine(str(own), "own")
    (root / "tools" / "browser" / "engine.json").unlink()  # never checked: not the Room's own
    assert rb.find_engine(**kw) == rb.Engine(str(pw), "playwright")  # the newest build, never the headless shell
    pw.unlink()
    (local / "ms-playwright" / "chromium-1100" / "chrome-win" / "chrome.exe").unlink()
    assert rb.find_engine(**kw) == rb.Engine(str(chrome), "chrome")
    chrome.unlink()
    assert rb.find_engine(**kw) == rb.Engine(str(chrome_user), "chrome")  # Chrome installed for this person only
    chrome_user.unlink()
    assert rb.find_engine(**kw) == rb.Engine(str(edge), "edge")  # every Windows 10 and 11 has Edge


def test_on_windows_the_reason_is_no_engine_or_policy_never_just_windows():
    edge = rb.Engine(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", "edge")
    allowed = lambda hive, key, name: None  # noqa: E731 - no policy set
    assert rb.off_reason(edge, platform="win32", policy_read=allowed) is None
    assert rb.off_reason(None, platform="win32", policy_read=allowed) == "no_engine"
    assert rb.OFF_WORDS["windows"] == "The Room's browser is not on Windows yet."  # kept for an older helper's status


def test_it_policy_that_switches_remote_debugging_off_is_respected():
    """RemoteDebuggingAllowed = 0, for the engine found, under the machine's or the person's policies: the browser is off
    with reason "policy" and plain words that send the person to their IT team. Nothing works around it."""
    edge = rb.Engine(r"C:\Edge\msedge.exe", "edge")
    chrome = rb.Engine(r"C:\Chrome\chrome.exe", "chrome")
    seen = []

    def read(values):
        def reader(hive, key, name):
            seen.append((hive, key, name))
            return values.get((hive, key))
        return reader

    off_edge = read({("HKCU", r"Software\Policies\Microsoft\Edge"): 0})
    assert rb.policy_off(edge, read=off_edge) is True
    assert ("HKCU", r"Software\Policies\Microsoft\Edge", "RemoteDebuggingAllowed") in seen
    assert rb.off_reason(edge, platform="win32", policy_read=off_edge) == "policy"
    assert rb.policy_off(chrome, read=off_edge) is False  # Edge's policy is Edge's: Chrome reads its own
    assert rb.policy_off(chrome, read=read({("HKLM", r"Software\Policies\Google\Chrome"): 0})) is True
    assert rb.policy_off(edge, read=read({("HKLM", r"Software\Policies\Microsoft\Edge"): 1})) is False
    assert rb.policy_off(edge, read=read({})) is False
    assert rb.policy_off(rb.Engine(r"C:\pw\chrome.exe", "playwright"),
                         read=read({("HKLM", r"Software\Policies\Chromium"): 0})) is True
    words = rb.policy_words(edge)
    assert words == "Your organisation has switched this off in Edge. Ask your IT team."
    assert rb.policy_words(chrome) == "Your organisation has switched this off in Chrome. Ask your IT team."
    assert rb.START_WORDS["policy"].startswith("The Room's browser could not start")
    assert "IT team" in rb.START_WORDS["policy"]


def test_the_c_runtime_block_is_a_count_then_one_flag_byte_then_one_handle_per_descriptor_unpadded():
    entries = [(winproc.FOPEN | winproc.FDEV, 0x10), (winproc.FOPEN | winproc.FDEV, 0x10),
               (winproc.FOPEN | winproc.FPIPE, 0x24), (winproc.FOPEN | winproc.FPIPE, 0x28),
               (winproc.FOPEN | winproc.FPIPE, 0x2C)]
    block = winproc.crt_block(entries, pointer=8)
    assert len(block) == 4 + 5 + 5 * 8  # no padding between the flags and the handles
    assert struct.unpack_from("<i", block, 0) == (5,)
    assert list(block[4:9]) == [0x41, 0x41, 0x09, 0x09, 0x09]
    assert [struct.unpack_from("<Q", block, 9 + 8 * i)[0] for i in range(5)] == [0x10, 0x10, 0x24, 0x28, 0x2C]
    assert len(winproc.crt_block(entries, pointer=4)) == 4 + 5 + 5 * 4


def test_on_windows_the_engine_starts_directly_with_its_pipe_and_never_a_port(tmp_path):
    edge = rb.Engine(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", "edge")
    home = Path(r"C:\Users\me\.ai-workspace\try-room\home")
    argv, inside = rb.launch_argv(edge, home, person_home=Path(r"C:\Users\me"), platform="win32")
    assert argv[0] == edge.path  # no pipe step: the Room starts the engine itself, in its job, in one call
    assert rb.PIPE_STEP_FLAG not in argv and "-c" not in argv
    assert "--remote-debugging-pipe" in argv and "--headless=new" in argv
    assert not [a for a in argv if a.startswith("--password-store")]  # Windows always protects passwords itself
    assert f"--user-data-dir={rb.profile_dir(home)}" in argv
    assert inside == home
    off, _ = rb.launch_argv(edge, home, person_home=Path(r"C:\Users\me"), platform="win32", offline=True)
    assert all(f in off for f in rb.OFFLINE_FLAGS)
    for bad in rb.FORBIDDEN_FLAGS:
        with pytest.raises(ValueError):
            rb.check_flags(argv + [bad + "=1"])


def test_on_windows_the_engine_keeps_the_persons_userprofile_but_never_their_secrets(tmp_path):
    """Chromium on Windows finds its folders through USERPROFILE; with the Room's home there it cannot tell the Room's
    profile from its default one and refuses the pipe (seen on windows-2022). The profile is the Room's all the same."""
    base = {"USERPROFILE": r"C:\Users\me", "PATH": r"C:\Windows\System32", "OPENAI_API_KEY": "sk-not-for-the-room",
            "SystemRoot": r"C:\Windows"}
    env = rb.browser_env(tmp_path / "home", base=base, platform="win32")
    assert env["USERPROFILE"] == r"C:\Users\me"
    assert "OPENAI_API_KEY" not in env and env["HOME"] == str(tmp_path / "home")


def test_the_packaged_app_says_the_pipe_step_is_not_used_on_windows(monkeypatch):
    monkeypatch.setattr(rb.sys, "platform", "win32")
    with pytest.raises(SystemExit) as e:
        rb.pipe_step(["3", "4", r"C:\x\chrome.exe"])
    assert "Not used on Windows" in str(e.value)


def test_windows_file_addresses_inside_the_room_open_and_shares_and_the_rest_are_refused():
    rules = rb.Rules(home=Path(r"C:\Users\me\try\home"), windows=True)
    assert rules.refused("file:///C:/Users/me/try/home/Desktop/page.html") is None
    assert rules.refused("file:///c:/users/ME/try/HOME/Desktop/page.html") is None  # drive letters and case
    assert rules.refused("file:///C:/Users/me/try/home") is None
    assert rules.refused("file:///C:/Users/me/Documents/secret.txt") == rb.FILE_OUTSIDE
    assert rules.refused("file:///C:/Users/me/try/home/../../Documents/x") == rb.FILE_OUTSIDE
    assert rules.refused("file:///C:/Users/me/try/homework/x") == rb.FILE_OUTSIDE
    assert rules.refused("file:///D:/Users/me/try/home/x") == rb.FILE_OUTSIDE
    # a share would send the person's Windows sign-in to that server: never, wherever it points
    assert rules.refused("file://server/share/x.html") == rb.FILE_OUTSIDE
    assert rules.refused("file:////server/share/x.html") == rb.FILE_OUTSIDE
    assert rules.refused("file:///%5C%5Cserver%5Cshare%5Cx.html") == rb.FILE_OUTSIDE
    assert rules.refused("file://127.0.0.1/C$/Users/me/try/home/x") == rb.FILE_OUTSIDE


# --- a real Edge and Chrome on the windows-2022 runner ---------------------------------------------------------------
def _engines() -> list:
    out = []
    pf86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    pf = os.environ.get("ProgramFiles", r"C:\Program Files")
    for kind, path in (("edge", Path(pf86) / "Microsoft" / "Edge" / "Application" / "msedge.exe"),
                       ("chrome", Path(pf) / "Google" / "Chrome" / "Application" / "chrome.exe")):
        out.append(pytest.param(rb.Engine(str(path), kind), id=kind))
    return out


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):  # noqa: D401
        pass


@pytest.fixture()
def site(tmp_path):
    folder = tmp_path / "site"
    folder.mkdir()
    (folder / "index.html").write_text(
        "<title>local</title><style>body{margin:0}button{position:absolute;left:0;top:0;width:300px;height:200px}"
        "</style><button id=b onclick=\"document.getElementById('o').textContent='clicked here'\">press</button>"
        "<p id=o style='margin-top:260px'>a page on this computer</p>")
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), lambda *a, **k: _Quiet(*a, directory=str(folder), **k))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv.server_address[1]
    srv.shutdown()


def _ps(command: str) -> str:
    return subprocess.run(["powershell.exe", "-NoLogo", "-NoProfile", "-Command", command], capture_output=True,
                          text=True, timeout=120).stdout


def _engine_pids(profile: Path) -> set[int]:
    """Every process on this computer started with the Room's profile on its command line (the engine's own tree)."""
    out = _ps("Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('"
              + str(profile).replace("'", "''") + "') } | ForEach-Object { $_.ProcessId }")
    return {int(x) for x in out.split() if x.strip().isdigit()}


def _command_lines(pids: set[int]) -> dict:
    out = {}
    for pid in pids:
        out[pid] = _ps(f"(Get-CimInstance Win32_Process -Filter 'ProcessId={int(pid)}').CommandLine").strip()[:300]
    return out


def _listening_pids() -> set[int]:
    out = _ps("Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess }")
    return {int(x) for x in out.split() if x.strip().isdigit()}


@windows_only
@pytest.mark.parametrize("engine", _engines())
def test_real_engine_over_its_pipe_page_frame_click_job_no_port_and_close(engine, tmp_path, site):
    if not Path(engine.path).is_file():
        pytest.skip(f"{engine.kind} is not installed here")
    found = rb.find_engine(root=tmp_path / "try", env=dict(os.environ))
    assert found is not None, "find_engine found nothing on a Windows runner that has Chrome and Edge"
    assert rb.off_reason(found) is None
    person = Path(os.environ["LOCALAPPDATA"]) / ("Microsoft/Edge/User Data/Default" if engine.kind == "edge"
                                                 else "Google/Chrome/User Data/Default")
    person_before = person.exists()
    home = tmp_path / "try" / "home"
    (home / "Desktop").mkdir(parents=True)
    frames: list = []
    s = rb.Session(engine, home, app_ports={1}, bwrap=None, on_frame=lambda data, meta: frames.append(data))
    try:
        s.start()
    except rb.StartError as e:
        pytest.fail(f"{e}\n{e.detail}")
    try:
        assert s.alive() and s.job is not None
        version = s.pipe.call("Browser.getVersion")
        assert version.get("product"), version
        tab = s.new_tab()
        s.navigate(tab, f"http://127.0.0.1:{site}/", wait=True)
        assert "a page on this computer" in s.page_text(tab)
        s.watch(True)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and not frames:
            time.sleep(0.1)
        assert frames and frames[0][:2] == b"\xff\xd8", "no JPEG frame came from the screencast"
        s.click(100, 100)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and "clicked here" not in s.page_text(tab):
            time.sleep(0.1)
        assert "clicked here" in s.page_text(tab), "the click did not land on the page"

        # the browser made its sandboxed GPU and page processes (no job limit stops them)
        assert len(s.job.pids()) >= 3, s.job.pids()
        # every engine process is in the browser's job, and none listens on a port
        in_job = set(s.job.pids())
        mine = _engine_pids(rb.profile_dir(home))
        assert s.proc.pid in in_job and len(in_job) >= 2, in_job
        # a process started after the job's list was read is asked about itself
        outside = {p for p in mine - in_job if s.job.holds(p) is False}
        assert mine and not outside, f"engine processes outside the job: {_command_lines(outside)}"
        assert not (in_job & _listening_pids()), "an engine process listens on a TCP port"
        assert not (winproc.listening_ports(in_job)), "an engine process listens on a TCP port (our own reading)"

        # the profile is the Room's, and the person's own was not made
        assert (rb.profile_dir(home) / "Default").is_dir()
        assert person.exists() == person_before

        # a share is refused before anything is asked of the network
        out = s.navigate(tab, "file://server/share/page.html", wait=True)
        assert out["blocked"] == rb.FILE_OUTSIDE
        page = home / "Desktop" / "page.html"
        page.write_text("<p>a page in the Room</p>")
        s.navigate(tab, page.as_uri(), wait=True)
        assert "a page in the Room" in s.page_text(tab)
        out = s.navigate(tab, Path(os.environ["SystemRoot"], "win.ini").as_uri(), wait=True)
        assert out["blocked"] == rb.FILE_OUTSIDE
        assert s.memory() > 0
    finally:
        pids = set(s.job.pids()) if s.job is not None else set()
        s.close()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and any(winproc.alive(p) for p in pids):
        time.sleep(0.1)
    assert not [p for p in pids if winproc.alive(p)], "the browser's processes outlived close"


@windows_only
def test_real_policy_under_the_persons_registry_switches_the_browser_off(tmp_path):
    import winreg

    edge = rb.Engine(str(Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"))
                         / "Microsoft" / "Edge" / "Application" / "msedge.exe"), "edge")
    key = r"Software\Policies\Microsoft\Edge"
    existed = True
    try:
        winreg.CloseKey(winreg.OpenKey(winreg.HKEY_CURRENT_USER, key))
    except OSError:
        existed = False
    k = winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, key, 0, winreg.KEY_SET_VALUE | winreg.KEY_QUERY_VALUE)
    try:
        winreg.SetValueEx(k, "RemoteDebuggingAllowed", 0, winreg.REG_DWORD, 0)
        assert rb.policy_off(edge) is True
        assert rb.off_reason(edge) == "policy"
        s = rb.Session(edge, tmp_path / "home", bwrap=None)
        with pytest.raises(rb.StartError) as e:
            s.start()
        assert e.value.reason == "policy" and s.proc is None  # nothing was started to get around it
    finally:
        try:
            winreg.DeleteValue(k, "RemoteDebuggingAllowed")
        except OSError:
            pass
        winreg.CloseKey(k)
        if not existed:
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key)
            except OSError:
                pass
    assert rb.policy_off(edge) is False


@windows_only
def test_real_a_download_handed_out_of_the_room_keeps_its_mark_of_the_web(tmp_path, monkeypatch):
    """A file the Room's browser downloaded carries Windows' Mark of the Web (its Zone.Identifier stream). When the person
    says yes to letting it leave the Room, the copy keeps that mark, so SmartScreen and Office still check it."""
    from rooks_try import store
    from rooks_try.room import TryRoom

    monkeypatch.setenv("ROOKS_TRY_HOME", str(tmp_path / "try"))
    room = TryRoom(prefer="shell")
    room.up()
    src = store.guest_home() / "Downloads" / "report.docx"
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_bytes(b"PK\x03\x04 a document")
    mark = "[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://example.com/report.docx\r\n"
    with open(str(src) + ":Zone.Identifier", "w", encoding="ascii") as f:
        f.write(mark)
    dest = tmp_path / "out" / "report.docx"
    done = room.handoff("Downloads/report.docx", str(dest), approve=True)
    assert done["ok"] is True and dest.read_bytes() == b"PK\x03\x04 a document"
    with open(str(dest) + ":Zone.Identifier", encoding="ascii") as f:
        assert "ZoneId=3" in f.read()
