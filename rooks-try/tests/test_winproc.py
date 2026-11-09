"""Room terminals on Windows (design 0011, sections 1 and 5.1): jobs, ConPTY and the Room's PowerShell and Git Bash.

The Windows tests run on the windows-2022 runner (the Try Room job's Windows leg): a real pseudo console, a real
PowerShell and, when Git for Windows is there (it is on the runner), a real Git Bash. Elsewhere they skip; the few
tests at the top check what can be checked on any computer (the profile's text, the argv, the marker's count).

What ConPTY does with the in-band exit code marker differs between Windows builds (it may drop an escape sequence it
does not know). The tests accept the code from either channel and say which one carried it in a warning, so the CI log
records it.
"""

from __future__ import annotations

import os
import queue
import subprocess
import sys
import threading
import time
import uuid
import warnings
from pathlib import Path

import pytest

from rooks_try import store, winproc
from rooks_try.drivers import shell as shell_mod

WINDOWS = os.name == "nt"
windows_only = pytest.mark.skipif(not WINDOWS, reason="a real Windows pseudo console (the windows-2022 job)")


@pytest.fixture()
def room_home(tmp_path, monkeypatch):
    monkeypatch.setenv("ROOKS_TRY_HOME", str(tmp_path / "try"))
    home = store.guest_home()
    store.seed_home(home)
    return home


# --- on any computer ---------------------------------------------------------------------------------------------------
def test_winproc_imports_everywhere_and_says_no_pseudo_console_off_windows():
    if not WINDOWS:
        assert winproc.conpty_available() is False
        with pytest.raises(OSError):
            winproc.Job()
    assert winproc.HUNG_UP == 129
    assert winproc.TOO_OLD == "This version of Windows is too old for terminals in the Room."


def test_the_powershell_profile_is_one_plain_argument_and_never_bypasses_policy(room_home, monkeypatch):
    """A command is not subject to execution policy, so there is no -ExecutionPolicy Bypass; no -EncodedCommand, which
    security software flags. Single quotes only, so the text is one argument on a Windows command line as it is."""
    monkeypatch.setattr(shell_mod, "windows_powershell", lambda: r"C:\Program Files\PowerShell\7\pwsh.exe")
    monkeypatch.setattr(shell_mod, "windows_sh", lambda: r"C:\Program Files\Git\bin\bash.exe")
    argv = shell_mod.windows_terminal_argv(room_home)
    assert argv[:5] == [r"C:\Program Files\PowerShell\7\pwsh.exe", "-NoLogo", "-NoProfile", "-NoExit", "-Command"]
    text = argv[5]
    assert '"' not in text and "\n" not in text
    assert not any(a.lower().startswith(("-executionpolicy", "-encodedcommand", "-ep", "-e ")) for a in argv)
    for piece in ("Remove-Item Env:ROOKS_MARK", "Remove-Item Env:ROOKS_MARK_PIPE", "function global:prompt",
                  "NamedPipeClientStream", "]7777;", "LASTEXITCODE", ".local\\bin", "Documents\\PowerShell\\profile.ps1"):
        assert piece in text, piece
    assert shell_mod.windows_terminal_argv(room_home, "bash") == [r"C:\Program Files\Git\bin\bash.exe", "--login", "-i"]
    monkeypatch.setattr(shell_mod, "windows_sh", lambda: None)
    assert shell_mod.windows_terminal_argv(room_home, "bash") is None
    assert shell_mod.windows_terminal_shells() == ["powershell"]


def test_the_shell_driver_offers_powershell_and_git_bash_on_windows(room_home, monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(shell_mod, "windows_powershell", lambda: r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")
    monkeypatch.setattr(shell_mod, "windows_sh", lambda: r"C:\Program Files\Git\bin\bash.exe")
    driver = shell_mod.ShellDriver()
    assert driver.terminal_argv(room_home)[0].endswith("powershell.exe")  # PowerShell by default
    assert driver.terminal_argv(room_home, "bash")[0].endswith("bash.exe")
    assert driver.terminal_shells() == ["powershell", "bash"]


@pytest.mark.skipif(WINDOWS or not os.path.exists("/bin/bash"), reason="bash reading the Room's .profile")
def test_with_a_side_channel_the_in_band_marker_carries_a_count(room_home):
    """When the app gives a side channel (Windows), each prompt's marker carries a count, so the same prompt arriving
    by both ways counts once. Without one the marker is as before."""
    env = {**shell_mod.room_env(room_home), "ROOKS_MARK": "abc123", "ROOKS_MARK_PIPE": "rooks-mark-test",
           "SHELL": "/bin/bash"}
    out = subprocess.run(["/bin/bash", "-lc", 'false; eval "$PROMPT_COMMAND"; true; eval "$PROMPT_COMMAND"'],
                         env=env, cwd=str(room_home), capture_output=True, text=True, timeout=30)
    assert "\x1b]7777;1;abc123;1\x07" in out.stdout and "\x1b]7777;0;abc123;2\x07" in out.stdout, repr(out.stdout)
    assert "pipe" not in out.stderr  # a side channel that is not there is quiet
    env.pop("ROOKS_MARK_PIPE")
    out = subprocess.run(["/bin/bash", "-lc", 'false; eval "$PROMPT_COMMAND"'], env=env, cwd=str(room_home),
                         capture_output=True, text=True, timeout=30)
    assert "\x1b]7777;1;abc123\x07" in out.stdout, repr(out.stdout)


# --- on Windows: jobs ------------------------------------------------------------------------------------------------------
def _gone(pids, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not any(winproc.alive(p) for p in pids):
            return True
        time.sleep(0.1)
    return False


def _ping(n: int = 999) -> list[str]:
    return [os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "PING.EXE"), "-n", str(n), "127.0.0.1"]


@windows_only
def test_a_job_holds_what_it_starts_from_its_first_instruction_and_ends_it_all():
    job = winproc.Job()
    try:
        flags = job.limit_flags()
        assert flags & winproc.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        assert not flags & (winproc.JOB_OBJECT_LIMIT_BREAKAWAY_OK | winproc.JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)
        cmd = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "cmd.exe")
        proc = winproc.spawn([cmd, "/c", subprocess.list2cmdline(_ping())], dict(os.environ), None, jobs=[job],
                             flags=winproc.CREATE_NO_WINDOW)
        assert job.contains(proc.handle)  # in the job from the start: no window in which it could start a child outside
        deadline = time.monotonic() + 10
        while len(job.pids()) < 2 and time.monotonic() < deadline:  # cmd and the ping it started
            time.sleep(0.05)
        pids = job.pids()
        assert proc.pid in pids and len(pids) >= 2, pids
        job.terminate(129)
        assert _gone(pids), "a process outlived its job"
        assert proc.wait(5) == 129
        proc.close()
    finally:
        job.close()


@windows_only
def test_when_the_holder_of_a_job_dies_its_grandchildren_die_too(tmp_path):
    """Kill on close: the sidecar holds the Room's jobs, so if it crashes Windows ends everything in the Room."""
    script = (
        "import os, subprocess, sys, time\n"
        "from rooks_try import winproc\n"
        "job = winproc.Job()\n"
        "cmd = os.path.join(os.environ.get('SystemRoot', r'C:\\Windows'), 'System32', 'cmd.exe')\n"
        f"winproc.spawn([cmd, '/c', {subprocess.list2cmdline(_ping())!r}], dict(os.environ), None, jobs=[job],"
        " flags=winproc.CREATE_NO_WINDOW)\n"
        "deadline = time.monotonic() + 10\n"
        "while len(job.pids()) < 2 and time.monotonic() < deadline: time.sleep(0.05)\n"
        "print(' '.join(map(str, job.pids())), flush=True)\n"
        "time.sleep(600)\n"
    )
    helper = subprocess.Popen([sys.executable, "-c", script], stdout=subprocess.PIPE, text=True,
                              cwd=str(Path(winproc.__file__).resolve().parents[1]))
    try:
        pids = [int(p) for p in helper.stdout.readline().split()]
        assert len(pids) >= 2 and all(winproc.alive(p) for p in pids), pids
        helper.kill()  # TerminateProcess: no clean-up runs, only Windows closing the job handle
        helper.wait(10)
        assert _gone(pids), "a grandchild outlived the process holding its job"
    finally:
        if helper.poll() is None:
            helper.kill()


# --- on Windows: a real pseudo console -------------------------------------------------------------------------------------
class Screen:
    """What a pseudo console draws, read by a thread, and the side channel's lines."""

    def __init__(self, term: winproc.Terminal) -> None:
        self.term, self.text, self.lines = term, "", queue.Queue()
        self._lock = threading.Lock()
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()

    def _read(self) -> None:
        while True:
            data = self.term.read()
            if not data:
                return
            with self._lock:
                self.text += data.decode("utf-8", "replace")

    def until(self, needle: str, timeout: float = 30.0) -> str:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                if needle in self.text:
                    return self.text
            time.sleep(0.05)
        raise AssertionError(f"never saw {needle!r} in {self.text[-1500:]!r}")

    def type(self, line: str) -> None:
        self.term.write((line + "\r").encode())


def _start(argv, home: Path, extra: dict | None = None, cols: int = 80, rows: int = 24):
    env = {**shell_mod.room_env(home), "TERM": "xterm-256color", **(extra or {})}
    term = winproc.Terminal(argv, env, str(home), cols, rows)
    return term, Screen(term)


def _marker(screen: Screen, pipe_lines: queue.Queue, nonce: str, code: int, timeout: float = 30.0) -> str:
    """The exit code `code` with this nonce, from whichever channel carried it first; returns which."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            line = pipe_lines.get(timeout=0.1)
            parts = line.split(";")
            if parts[0] == str(code) and parts[1] == nonce:
                return "pipe"
        except queue.Empty:
            pass
        if f"\x1b]7777;{code};{nonce};" in screen.text:
            return "in-band"
    raise AssertionError(f"no marker {code} for {nonce}: {screen.text[-1500:]!r}")


@windows_only
@pytest.mark.skipif(WINDOWS and not winproc.conpty_available(), reason="Windows older than 10 1809")
def test_powershell_on_a_pseudo_console_runs_resizes_reports_codes_and_exits(room_home):
    nonce = uuid.uuid4().hex
    got: queue.Queue = queue.Queue()
    pipe = winproc.MarkPipe(got.put)
    argv = shell_mod.windows_terminal_argv(room_home)
    term, screen = _start(argv, room_home, {"ROOKS_MARK": nonce, "ROOKS_MARK_PIPE": pipe.name})
    try:
        assert term.job.contains(term.proc.handle)
        first = _marker(screen, got, nonce, 0)  # the first prompt
        screen.type("Write-Output ('hi-' + (20+22))")
        screen.until("hi-42")
        screen.type("cmd /c exit 5")
        channel = _marker(screen, got, nonce, 5)
        warnings.warn(f"ConPTY exit code marker on this Windows: first prompt by {first}, code 5 by {channel}")
        term.resize(100, 30)
        time.sleep(0.3)
        screen.type("Write-Output ('size-' + $Host.UI.RawUI.WindowSize.Width + 'x' + $Host.UI.RawUI.WindowSize.Height)")
        screen.until("size-100x30")
        screen.type("Write-Output ('env-[' + $env:ROOKS_MARK + '][' + $env:ROOKS_MARK_PIPE + ']')")
        screen.until("env-[][]")  # what the shell starts never sees the nonce or the pipe's name
        screen.type("Write-Output ('home-' + (Resolve-Path ~).Path)")
        screen.until("home-" + str(room_home)[:30])
        screen.type("exit 3")
        assert term.proc.wait(30) == 3
    finally:
        term.end(grace=1)
        term.close(reader=screen.thread)
        pipe.close()


@windows_only
@pytest.mark.skipif(WINDOWS and not winproc.conpty_available(), reason="Windows older than 10 1809")
def test_hanging_up_ends_the_shell_and_what_it_started(room_home):
    term, screen = _start(shell_mod.windows_terminal_argv(room_home), room_home)
    try:
        screen.until("PS ")
        screen.type(subprocess.list2cmdline(_ping()))
        deadline = time.monotonic() + 15
        while len(term.pids()) < 2 and time.monotonic() < deadline:
            time.sleep(0.1)
        pids = term.pids()
        assert len(pids) >= 2, pids  # the shell and ping, both in the terminal's job
        started = time.monotonic()
        code = term.end(grace=3)
        assert _gone(pids), "a program outlived its terminal"
        assert time.monotonic() - started < 15
        assert code is not None and term.job.pids() == []
    finally:
        term.close(reader=screen.thread)
    assert not screen.thread.is_alive()  # the reader saw the console close


@windows_only
@pytest.mark.skipif(WINDOWS and not winproc.conpty_available(), reason="Windows older than 10 1809")
def test_a_pseudo_console_does_not_write_to_a_redirected_parent(room_home, tmp_path):
    """The standard handles are set to nothing for a terminal: a parent whose own output is a pipe (a sidecar, pytest)
    must not have the shell write there instead of to the console."""
    script = (
        "import os, sys, time\n"
        "from rooks_try import winproc\n"
        "from rooks_try.drivers import shell\n"
        "from pathlib import Path\n"
        "home = Path(sys.argv[1])\n"
        "t = winproc.Terminal(shell.windows_terminal_argv(home), shell.room_env(home), str(home))\n"
        "seen = b''\n"
        "t.write(b\"Write-Output ('to-' + 'console')\\r\")\n"
        "deadline = time.monotonic() + 30\n"
        "import threading\n"
        "def rd():\n"
        "    global seen\n"
        "    while True:\n"
        "        d = t.read()\n"
        "        if not d: return\n"
        "        seen += d\n"
        "threading.Thread(target=rd, daemon=True).start()\n"
        "while b'to-console' not in seen and time.monotonic() < deadline: time.sleep(0.1)\n"
        "sys.stderr.write('console:' + str(b'to-console' in seen) + '\\n')\n"
        "t.end(grace=1)\n"
    )
    out = subprocess.run([sys.executable, "-c", script, str(room_home)], capture_output=True, text=True, timeout=90,
                         cwd=str(Path(winproc.__file__).resolve().parents[1]))
    assert "console:True" in out.stderr, out.stderr[-2000:]
    assert "to-console" not in out.stdout, out.stdout[-2000:]


@windows_only
@pytest.mark.skipif(WINDOWS and not (winproc.conpty_available() and shell_mod.windows_sh()), reason="needs Git for Windows")
def test_git_bash_reads_the_rooms_profile_and_reports_its_codes(room_home):
    nonce = uuid.uuid4().hex
    got: queue.Queue = queue.Queue()
    pipe = winproc.MarkPipe(got.put)
    argv = shell_mod.windows_terminal_argv(room_home, "bash")
    term, screen = _start(argv, room_home, {"ROOKS_MARK": nonce, "ROOKS_MARK_PIPE": pipe.name})
    try:
        first = _marker(screen, got, nonce, 0, timeout=60)
        screen.type("echo bash-$((40+2)) home-$HOME")
        screen.until("bash-42")
        screen.type("false")
        channel = _marker(screen, got, nonce, 1)
        warnings.warn(f"Git Bash exit code marker: first prompt by {first}, code 1 by {channel}")
        screen.type('echo "mark-[${ROOKS_MARK:-}][${ROOKS_MARK_PIPE:-}]"')
        screen.until("mark-[][]")
    finally:
        term.end(grace=1)
        term.close(reader=screen.thread)
        pipe.close()


@windows_only
def test_the_side_channel_is_the_persons_alone_and_takes_lines():
    got: queue.Queue = queue.Queue()
    pipe = winproc.MarkPipe(got.put)
    try:
        sddl = winproc.person_only_sddl()
        assert sddl.startswith("D:P(A;;GA;;;S-1-5-") and sddl.count("(A;") == 1  # one allow entry: this account
        winproc.write_mark(pipe.name, "7;abc;1")
        winproc.write_mark(pipe.name, "0;abc;2")
        assert [got.get(timeout=5), got.get(timeout=5)] == ["7;abc;1", "0;abc;2"]
    finally:
        pipe.close()
