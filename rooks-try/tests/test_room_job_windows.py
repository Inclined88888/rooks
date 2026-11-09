"""What keeps the Room's programs together on Windows, and what is said about it (design 0011, section 3).

Every Room process runs in a job: one Room job, kill on close, with a nested job per terminal, per quick command and for
the browser. The sidecar holds the handles, so when it ends, however it ends, Windows ends everything in the Room; when
the Room stops, everything in it stops. Terminals and quick commands may not read or change the person's clipboard.
None of this is a wall, and the words say so: "Not locked off", and the note says they can read and change your files.

The Windows tests run on the windows-2022 runner (the Try Room job's Windows leg and "Windows: terminals and browser");
the words and the environment are checked on every computer.
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

import pytest

from rooks_try import store, winproc
from rooks_try.drivers import shell as shell_mod

WINDOWS = os.name == "nt"
windows_only = pytest.mark.skipif(not WINDOWS, reason="real Windows jobs (the windows-2022 jobs)")
WINDOWS_NOTE = ("Commands run as you, in a folder of its own. Windows keeps them together, so they all stop when the "
                "Room stops. It is not a locked off computer: they can read and change your files.")


@pytest.fixture()
def room_home(tmp_path, monkeypatch):
    monkeypatch.setenv("ROOKS_TRY_HOME", str(tmp_path / "try"))
    home = store.guest_home()
    store.seed_home(home)
    return home


# --- on any computer: the words and the environment ---------------------------------------------------------------------
def test_status_on_windows_says_the_room_is_kept_together_and_not_locked_off(room_home, monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(shell_mod, "namespaces_available", lambda: False)  # there are none on Windows
    monkeypatch.setattr(shell_mod, "windows_sh", lambda: r"C:\Program Files\Git\bin\bash.exe")
    st = shell_mod.ShellDriver().status()
    assert st["isolation"] == "none"  # a job is not a wall
    assert st["containment"] == "job"
    assert st["note"] == WINDOWS_NOTE
    monkeypatch.setattr(shell_mod, "windows_sh", lambda: None)  # no Git for Windows: Command Prompt, and it says so
    st = shell_mod.ShellDriver().status()
    assert st["note"].startswith(WINDOWS_NOTE) and shell_mod.CMD_NOTE in st["note"]


def test_status_elsewhere_has_no_job_and_keeps_its_words(room_home, monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    st = shell_mod.ShellDriver().status()
    assert st["containment"] == "none"
    assert st["note"] == shell_mod.NOTE


def test_on_windows_the_rooms_programs_keep_their_settings_and_temporary_files_in_the_room(room_home, monkeypatch):
    """USERPROFILE, HOME, APPDATA, LOCALAPPDATA, TEMP and TMP point into the Room's home, and those folders exist.
    Programs that ask Windows for known folders still find the person's own; Advanced says so."""
    monkeypatch.setattr(sys, "platform", "win32")
    env = shell_mod.room_env(room_home, base={"APPDATA": r"C:\Users\p\AppData\Roaming", "TEMP": r"C:\Users\p\Temp",
                                              "PATH": ""})
    for name in ("HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"):
        path = Path(env[name])
        assert path == room_home or room_home in path.parents, (name, env[name])
        assert path.is_dir(), name
    assert Path(env["TEMP"]) == Path(env["TMP"])
    assert Path(env["LOCALAPPDATA"]) in Path(env["TEMP"]).parents


# --- on Windows: real jobs -----------------------------------------------------------------------------------------------
def _gone(pids, timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not any(winproc.alive(p) for p in pids):
            return True
        time.sleep(0.1)
    return False


def _wait_for(path: Path, timeout: float = 30.0) -> str:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.is_file():
            text = path.read_text(encoding="ascii", errors="replace").strip()
            if text:
                return text
        time.sleep(0.1)
    raise AssertionError(f"{path.name} never appeared")


def _starts_a_hidden_ping(pid_file: str) -> str:
    """A command (Git Bash, or Command Prompt without it) that starts a ping of its own through PowerShell's
    Start-Process, writes that ping's id to `pid_file`, then waits on a second ping."""
    ps = (f"(Start-Process -FilePath ping.exe -ArgumentList '-n','999','127.0.0.1' -WindowStyle Hidden -PassThru).Id"
          f" | Set-Content -Encoding ascii {pid_file}")
    return f'powershell.exe -NoProfile -Command "{ps}" && ping -n 999 127.0.0.1 > {"/dev/null" if shell_mod.windows_sh() else "NUL"}'


@windows_only
def test_a_quick_command_runs_hidden_and_gives_its_output(room_home):
    r = shell_mod.ShellDriver().run("echo room-says-hi", timeout=60)
    assert r["ok"] and r["code"] == 0, r
    assert "room-says-hi" in r["stdout"]


@windows_only
def test_a_quick_command_that_runs_out_of_time_ends_with_everything_it_started(room_home):
    pid_file = f"ping-{uuid.uuid4().hex[:6]}.pid"
    out: dict = {}
    worker = threading.Thread(target=lambda: out.update(shell_mod.ShellDriver().run(_starts_a_hidden_ping(pid_file),
                                                                                     timeout=8)), daemon=True)
    worker.start()
    child = int(_wait_for(room_home / pid_file))
    worker.join(60)
    assert not worker.is_alive(), "the command never came back after its time ran out"
    assert out.get("code") == 124, out
    assert _gone([child], 10), "a program the command started outlived it"


@windows_only
def test_stopping_the_room_ends_what_it_started(room_home):
    pid_file = f"ping-{uuid.uuid4().hex[:6]}.pid"
    driver = shell_mod.ShellDriver()
    driver.up()
    out: dict = {}
    worker = threading.Thread(target=lambda: out.update(driver.run(_starts_a_hidden_ping(pid_file), timeout=600)),
                              daemon=True)
    worker.start()
    child = int(_wait_for(room_home / pid_file))
    driver.down()
    worker.join(30)
    assert not worker.is_alive(), "the command kept running after the Room stopped"
    assert out.get("ok") is False, out
    assert _gone([child], 10), "a program the Room started outlived the Room"


@windows_only
def test_when_the_app_is_killed_what_the_room_started_ends(room_home, tmp_path):
    """The sidecar holds the Room's jobs. Killed outright (TerminateProcess: no clean-up of ours runs), Windows closes
    its handles and ends every program the Room started."""
    pid_file = f"ping-{uuid.uuid4().hex[:6]}.pid"
    script = (
        "import sys\n"
        "from rooks_try.drivers.shell import ShellDriver\n"
        f"ShellDriver().run({_starts_a_hidden_ping(pid_file)!r}, timeout=600)\n"
    )
    env = {**os.environ, "ROOKS_TRY_HOME": os.environ["ROOKS_TRY_HOME"]}
    helper = subprocess.Popen([sys.executable, "-c", script], env=env,
                              cwd=str(Path(winproc.__file__).resolve().parents[1]))
    try:
        child = int(_wait_for(room_home / pid_file))
        assert winproc.alive(child)
        helper.kill()
        helper.wait(10)
        assert _gone([child], 10), "a program the Room started outlived the app"
    finally:
        if helper.poll() is None:
            helper.kill()


def _clipboard(value: str | None = None) -> str | None:
    """Set (or read) the person's clipboard from outside every Room job, through Windows PowerShell."""
    ps = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "WindowsPowerShell", "v1.0",
                      "powershell.exe")
    cmd = f"Set-Clipboard -Value '{value}'" if value is not None else "Get-Clipboard"
    try:
        r = subprocess.run([ps, "-NoProfile", "-STA", "-Command", cmd], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout.strip() if r.returncode == 0 else None


@windows_only
def test_a_quick_command_may_not_read_the_persons_clipboard(room_home):
    nonce = f"clip-{uuid.uuid4().hex[:10]}"
    if _clipboard(nonce) is None or _clipboard() != nonce:
        pytest.skip("this runner's session has no clipboard to test with")
    r = shell_mod.ShellDriver().run('powershell.exe -NoProfile -STA -Command "Get-Clipboard"', timeout=60)
    assert nonce not in (r.get("stdout") or "") + (r.get("stderr") or ""), "a Room command read the clipboard"
    assert _clipboard() == nonce  # and outside the Room the clipboard still holds it


@windows_only
@pytest.mark.skipif(WINDOWS and not winproc.conpty_available(), reason="Windows older than 10 1809")
def test_a_room_terminal_is_in_the_room_job_and_may_not_read_the_clipboard(room_home):
    nonce = f"clip-{uuid.uuid4().hex[:10]}"
    have_clipboard = _clipboard(nonce) is not None and _clipboard() == nonce
    argv = shell_mod.windows_terminal_argv(room_home)
    term = winproc.Terminal(argv, {**shell_mod.room_env(room_home), "TERM": "xterm-256color"}, str(room_home), 100, 30)
    text: list[str] = []

    def read():
        while True:
            data = term.read()
            if not data:
                return
            text.append(data.decode("utf-8", "replace"))

    threading.Thread(target=read, daemon=True).start()
    try:
        assert winproc.room_job().holds(term.pid) is True, "a Room terminal outside the Room job"
        assert term.job.holds(term.pid) is True
        if have_clipboard:
            term.write(b"Write-Output ('got:' + (Get-Clipboard)); Write-Output ('done' + '-reading')\r")
            deadline = time.monotonic() + 30
            while "done-reading" not in "".join(text) and time.monotonic() < deadline:  # the echo shows 'done' + ...
                time.sleep(0.1)
            assert "done-reading" in "".join(text), "".join(text)[-1500:]
            assert nonce not in "".join(text), "a Room terminal read the clipboard"
    finally:
        term.end(grace=1)
        term.close()
