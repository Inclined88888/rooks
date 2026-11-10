"""A private folder and shell on this computer. Always available. No screen, no pointer.

Commands run as the person, in a home folder of their own. On Linux, when `unshare -Urm` works, each command runs in a
private mount namespace with that folder sitting over the person's home path, and with no network at all when the room
is offline; status reports that as isolation "namespace". Everywhere else it is "none": the command can still read what
the person can read. The label and note say so in plain words. Nothing here claims a locked off computer.

The programs that put the Room up (unshare, setsid, sh) run on this computer before any wall exists, so they are always
absolute paths found on the computer's own PATH, never in the Room's folders: a program in the Room can write its own
bin folders. Those folders come first on the PATH only inside the Room's shell.
"""

from __future__ import annotations

import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

from .. import store
from .base import Driver, DriverInfo

LABEL = "A private folder and shell"
NOTE = "Commands run as you, in a folder of its own. It is not a locked off computer."
RAN_NOTE = "This ran as you, in the private folder."
NO_SCREEN = "This room has no screen. It is a private folder and shell."
_SECRET_NAMES = {"APP_SECRET", "TOOLS_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NVIDIA_API_KEY"}
# The app's own secrets and settings, which nothing in the Room may see: the app's security.APP_SECRET_ENV and
# terminal_pty._APP_ONLY. rooks-try cannot import the app, so the names are kept here too; a test in the app checks
# that this list covers both and that SECRET_ENV is terminal_pty's own pattern.
APP_ONLY_ENV = frozenset({
    "APP_SECRET", "TOOLS_API_KEY", "BROWSER_API_KEY", "DESK_API_KEY", "CODING_BRIDGE_KEY", "NATIVE_SIGNIN_KEY",
    "WORKBENCH_DESKTOP_TOKEN", "TRY_API_KEY", "ROOKS_TRY_API_KEY", "ROOKS_BROWSER_TOKEN", "ROOKS_DESK_TOKEN",
    "WORKBENCH_API_KEY", "BRIDGE_API_KEY", "DATA_DIR", "STATIC_DIR", "DATABASE_URL",
})
SECRET_ENV = re.compile(r"(SECRET|PASSWORD|PASSWD|_KEY$|_TOKEN$|^TOKEN|API_KEY|CREDENTIAL)", re.I)
ROOM_BINS = (".local/bin", "bin", ".cargo/bin")
_SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
# Inside the Room's shell, and only there, the Room's own bin folders come first on the PATH (the seeded profile does
# the same for a login shell; this covers a profile the person replaced).
_BINS = 'PATH="$HOME/.local/bin:$HOME/bin:$HOME/.cargo/bin${PATH:+:$PATH}"; export PATH; '
# $1 the room's home, $2 the person's home path, $3 the command. Inside the namespace the room's home sits over the
# person's home path, so a program that ignores HOME still lands in the room. The shell steps into the room's home
# before the bind: when that home lies under the person's home (the usual ~/.ai-workspace/try-room/home) its path is
# hidden once the bind is in place, so HOME then moves to the person's home path, which now shows the room's home.
_ENTER = ('cd "$1" || exit 1; if [ -d "$2" ] && [ "$1" != "$2" ] && mount --bind "$1" "$2" 2>/dev/null; then '
          '[ -d "$1" ] || export HOME="$2"; fi; ')
_NAMESPACES: bool | None = None


def _room_roots(home: Path | None) -> list[str]:
    """The Room's folders, as real paths: its home, and the Room's own folder (where a home and checkpoints live)."""
    roots = [Path(home)] if home is not None else []
    override = os.environ.get("ROOKS_TRY_HOME", "").strip()
    roots.append(Path(override).expanduser() if override else Path.home() / ".ai-workspace" / "try-room")
    return [os.path.realpath(r) for r in roots]


def host_path(path: str | None = None, home: Path | None = None) -> str:
    """The computer's own PATH (os.environ's, or `path`): absolute folders only, none inside the Room. An empty or
    relative entry means the folder a command starts in, which is the Room's home."""
    rooms = _room_roots(home)
    keep: list[str] = []
    for entry in (os.environ.get("PATH", "") if path is None else path).split(os.pathsep):
        if not entry or not os.path.isabs(entry):
            continue
        real = os.path.realpath(entry)
        if any(real == r or real.startswith(r.rstrip(os.sep) + os.sep) for r in rooms):
            continue
        if entry not in keep:
            keep.append(entry)
    return os.pathsep.join(keep)


def host_which(name: str, home: Path | None = None) -> str | None:
    """A program on this computer, never one from the Room's folders: what the wrappers are run by, as a full path."""
    found = shutil.which(name, path=host_path(None, home) or os.defpath)
    if not found and os.name == "posix":
        found = shutil.which(name, path=host_path(_SYSTEM_PATH, home))
    return found


def _sh() -> str:
    return host_which("sh") or "/bin/sh"


def _login_shell() -> str:
    """The person's own login shell, by its full path (a bare name would be looked up in the Room's bins)."""
    return f'case "$SHELL" in /*) ;; *) SHELL={shlex.quote(_sh())}; export SHELL;; esac; exec "$SHELL" -l'


def namespaces_available() -> bool:
    """Whether `unshare -Urm` works here (Linux with user namespaces allowed). Checked once per process;
    ROOKS_TRY_NAMESPACES=0 turns it off."""
    global _NAMESPACES
    if _NAMESPACES is None:
        _NAMESPACES = False
        wanted = os.environ.get("ROOKS_TRY_NAMESPACES", "1").strip().lower() not in {"0", "false", "no", "off"}
        unshare = host_which("unshare") if sys.platform.startswith("linux") else None
        if wanted and unshare:
            try:
                probe = subprocess.run([unshare, "-Urm", "--", _sh(), "-c", "echo ok"],
                                       capture_output=True, text=True, timeout=10)
                _NAMESPACES = probe.returncode == 0 and probe.stdout.strip() == "ok"
            except (OSError, subprocess.SubprocessError):
                _NAMESPACES = False
    return _NAMESPACES


def isolation_level() -> str:
    """What status reports: "namespace" when commands get a private mount namespace, else "none"."""
    return "namespace" if namespaces_available() else "none"


def _unshare(home: Path, offline: bool, final: str, command: str) -> list[str] | None:
    """unshare, then sh steps into the Room (_ENTER), puts the Room's bins first and ends in `final`."""
    unshare = host_which("unshare", home)
    if not unshare:
        return None
    return [unshare, "-Urm" + ("n" if offline else ""), "--", _sh(), "-c", _ENTER + _BINS + final, "room", str(home),
            os.path.expanduser("~"), command]


def wrapped(command: str, home: Path, offline: bool = False) -> list[str] | None:
    """The argv that runs `command` in a private mount namespace (and with no network when offline), or None when
    namespaces are not available here. Every program in it is a full path on this computer."""
    if not namespaces_available():
        return None
    return _unshare(home, offline, f'exec {shlex.quote(_sh())} -c "$3"', command)


def login_argv(home: Path, offline: bool = False) -> list[str]:
    """A login shell inside the Room: in its private mount namespace when there is one (the Room's home over the
    person's home path, no network when offline), else started in the Room's home. It is the person's own $SHELL, with
    the Room's bins first on its PATH. The app's Room terminals, the terminal on a private desktop and the rooks
    terminal's /room shell all use this one."""
    argv = wrapped(_login_shell(), home, offline)
    if argv:
        return argv
    return [_sh(), "-c", 'cd "$1" || exit 1; ' + _BINS + _login_shell(), "room", str(home)]


def run_argv(command: str, home: Path, offline: bool = False) -> list[str] | None:
    """How a quick command runs in the Room: POSIX sh as a login shell (`sh -lc`), so it reads the Room's profile and
    PATH and means the same whatever the person's own login shell is (fish and tcsh read POSIX commands differently).
    None means Windows Command Prompt (run with shell=True), which has no profile."""
    sh = shlex.quote(_sh())
    if namespaces_available():
        argv = _unshare(home, offline, f'exec {sh} -lc "$3"', command)
        if argv:
            return argv
    if sys.platform == "win32":
        bash = windows_sh()
        return [bash, "-lc", command] if bash else None
    return [_sh(), "-c", 'cd "$1" || exit 1; ' + _BINS + f'exec {sh} -lc "$2"', "room", str(home), command]


def secret_env(name: str) -> bool:
    """A name nothing in the Room may see: a key, token, password or credential, or one of the app's own."""
    upper = name.upper()
    return (upper in APP_ONLY_ENV or upper in _SECRET_NAMES or bool(SECRET_ENV.search(name))
            or upper.endswith(("_API_KEY", "_TOKEN", "_SECRET", "_PASSWORD")))


def room_env(home: Path, offline: bool = False, base: dict | None = None) -> dict:
    """The environment of everything that runs in the Room: HOME is the Room's home, the host's secrets and the app's
    own names are left out, and when offline every proxy points nowhere. The PATH is the computer's own without the
    Room's folders: the Room's bins come first only inside the Room's shell (login_argv, run_argv and the seeded
    profile), never on the PATH a wrapper is looked up with."""
    env = {k: v for k, v in (os.environ if base is None else base).items() if not secret_env(k)}
    env["HOME"] = str(home)
    env["ROOKS_TRY"] = "1"
    if offline:  # belt and braces next to the empty network namespace: proxy-aware programs stop at once
        for key in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
            env[key] = "http://127.0.0.1:9"
    env["PATH"] = host_path(env.get("PATH", ""), home) or (_SYSTEM_PATH if os.name == "posix" else "")
    return env


def room_bins(home: Path) -> str:
    """The Room's own bin folders, for a PATH (Command Prompt only: it reads no profile)."""
    return os.pathsep.join(str(home / p) for p in ROOM_BINS)


def windows_sh() -> str | None:
    """Git for Windows' bash, so a room command means the same thing on every computer. Never WSL's bash.exe, which
    would run the command in a different Linux system with a different home."""
    git = shutil.which("git")
    candidates = [Path(git).resolve().parents[1] / "bin" / "bash.exe"] if git else []
    candidates += [Path(os.environ.get(v, "")) / "Git" / "bin" / "bash.exe" for v in ("ProgramFiles", "ProgramW6432")
                   if os.environ.get(v)]
    return next((str(c) for c in candidates if c.is_file()), None)


CMD_NOTE = "Commands run in Windows Command Prompt, not a Unix shell. Install Git for Windows to get one."


def shell_kind(windows: bool | None = None, sh: str | None = None) -> str:
    """What runs a room command: "sh" (a POSIX shell) or "cmd" (Windows Command Prompt, when Git for Windows is
    missing). Command Prompt reads `a; b` as one command and still exits 0, so status and every result say which."""
    windows = sys.platform == "win32" if windows is None else windows
    if not windows:
        return "sh"
    return "sh" if (windows_sh() if sh is None else sh) else "cmd"


def _kill_tree(proc: subprocess.Popen) -> None:
    try:
        if os.name == "posix":
            os.killpg(proc.pid, signal.SIGKILL)
        else:
            proc.kill()
    except (ProcessLookupError, PermissionError, OSError):
        pass


class ShellDriver(Driver):
    name = "shell"

    def available(self) -> bool:
        return True

    def info(self) -> DriverInfo:
        return DriverInfo(
            "shell",
            "Private folder and shell",
            True,
            "A home folder of its own on this computer. Commands run as you; the real desktop is untouched.",
        )

    def up(self) -> dict:
        home = store.guest_home()
        (home / "Desktop").mkdir(exist_ok=True)
        (home / "Downloads").mkdir(exist_ok=True)
        store.seed_home(home)
        state = store.load_state()
        state.update({"driver": self.name, "running": True, "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        store.save_state(state)
        return self.status()

    def down(self) -> dict:
        state = store.load_state()
        state["running"] = False
        store.save_state(state)
        return self.status()

    def status(self) -> dict:
        state = store.load_state()
        return {
            "driver": self.name,
            "running": bool(state.get("running")),
            "screen": False,
            "pointer": False,
            "isolation": isolation_level(),
            "home": str(store.guest_home()),
            "offline": self.offline,
            "shell": shell_kind(),
            "label": LABEL,
            "note": NOTE if shell_kind() == "sh" else f"{NOTE} {CMD_NOTE}",
            "last_checkpoint": state.get("last_checkpoint"),
        }

    def screenshot(self, path: Path) -> Path:
        raise RuntimeError(NO_SCREEN)

    def click(self, x: int, y: int, button: str = "left", count: int = 1) -> dict:
        return {"ok": False, "error": "This room has no screen to click."}

    def drag(self, x1: int, y1: int, x2: int, y2: int) -> dict:
        return self.click(x1, y1)

    def scroll(self, x: int, y: int, dy: int = -3) -> dict:
        return self.click(x, y)

    def type_text(self, text: str) -> dict:
        return {"ok": False, "error": "This room has no screen to type on."}

    def key(self, keys: str) -> dict:
        return {"ok": False, "error": "This room has no screen to type on."}

    def run(self, command: str, timeout: float = 120, env_extra: dict | None = None) -> dict:
        """Run a shell command in the room's home, as the person, through a login shell (the Room's profile and PATH).
        `env_extra` is for the display of a nested room."""
        home = store.guest_home()
        env = self._env(home, env_extra)
        argv = run_argv(command, home, self.offline)
        kind = "cmd" if argv is None else "sh"
        if argv is None:  # Command Prompt reads no profile: the Room's bins go on its PATH here
            env["PATH"] = room_bins(home) + (os.pathsep + env["PATH"] if env.get("PATH") else "")
        try:
            proc = subprocess.Popen(
                argv if argv else command,
                shell=argv is None,
                cwd=str(home),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                start_new_session=True,
            )
        except OSError as exc:
            return {"ok": False, "code": 127, "stdout": "", "stderr": "", "error": str(exc), "isolation": isolation_level(),
                    "shell": kind}
        try:
            out, err = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            _kill_tree(proc)
            out, err = proc.communicate()
            return {"ok": False, "error": f"Timed out after {timeout}s", "stdout": (out or "")[-8000:],
                    "stderr": (err or "")[-4000:], "code": 124, "isolation": isolation_level(), "shell": kind}
        return {
            "ok": proc.returncode == 0,
            "code": proc.returncode,
            "stdout": (out or "")[-8000:],
            "stderr": (err or "")[-4000:],
            "note": RAN_NOTE if kind == "sh" else f"{RAN_NOTE} {CMD_NOTE}",
            "isolation": isolation_level(),
            "shell": kind,
        }

    def _env(self, home: Path, extra: dict | None) -> dict:
        env = room_env(home, self.offline)
        for key, value in (extra or {}).items():
            env[str(key)] = str(value)
        return env

    def terminal_argv(self, home: Path) -> list[str] | None:
        """The Room's terminal: a login shell inside it. None on Windows, where the app has no pseudo terminal."""
        return None if sys.platform == "win32" else login_argv(home, self.offline)

    def supports_screen(self) -> bool:
        return False

    def supports_pointer(self) -> bool:
        return False
