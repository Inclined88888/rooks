"""A private folder and shell on this computer. Always available. No screen, no pointer.

Commands run as the person, in a home folder of their own. On Linux, when `unshare -Urm` works, each command runs in a
private mount namespace with that folder sitting over the person's home path, and with no network at all when the room
is offline; status reports that as isolation "namespace". Everywhere else it is "none": the command can still read what
the person can read. The label and note say so in plain words. Nothing here claims a locked off computer.
"""

from __future__ import annotations

import os
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
# $1 the room's home, $2 the person's home path, $3 the command. Inside the namespace the room's home sits over the
# person's home path, so a program that ignores HOME still lands in the room. The shell steps into the room's home
# before the bind: when that home lies under the person's home (the usual ~/.ai-workspace/try-room/home) its path is
# hidden once the bind is in place, so HOME then moves to the person's home path, which now shows the room's home.
_WRAP = ('cd "$1" || exit 1; if [ -d "$2" ] && [ "$1" != "$2" ] && mount --bind "$1" "$2" 2>/dev/null; then '
         '[ -d "$1" ] || export HOME="$2"; fi; exec sh -c "$3"')
_NAMESPACES: bool | None = None


def namespaces_available() -> bool:
    """Whether `unshare -Urm` works here (Linux with user namespaces allowed). Checked once per process;
    ROOKS_TRY_NAMESPACES=0 turns it off."""
    global _NAMESPACES
    if _NAMESPACES is None:
        _NAMESPACES = False
        wanted = os.environ.get("ROOKS_TRY_NAMESPACES", "1").strip().lower() not in {"0", "false", "no", "off"}
        if wanted and sys.platform.startswith("linux") and shutil.which("unshare"):
            try:
                probe = subprocess.run(["unshare", "-Urm", "--", "sh", "-c", "echo ok"],
                                       capture_output=True, text=True, timeout=10)
                _NAMESPACES = probe.returncode == 0 and probe.stdout.strip() == "ok"
            except (OSError, subprocess.SubprocessError):
                _NAMESPACES = False
    return _NAMESPACES


def isolation_level() -> str:
    """What status reports: "namespace" when commands get a private mount namespace, else "none"."""
    return "namespace" if namespaces_available() else "none"


def wrapped(command: str, home: Path, offline: bool = False) -> list[str] | None:
    """The argv that runs `command` in a private mount namespace (and with no network when offline), or None when
    namespaces are not available here."""
    if not namespaces_available():
        return None
    flags = "-Urm" + ("n" if offline else "")
    return ["unshare", flags, "--", "sh", "-c", _WRAP, "room", str(home), os.path.expanduser("~"), command]


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
            "label": LABEL,
            "note": NOTE,
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
        """Run a shell command in the room's home, as the person. `env_extra` is for the display of a nested room."""
        home = store.guest_home()
        env = self._env(home, env_extra)
        argv = wrapped(command, home, self.offline)
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
            return {"ok": False, "code": 127, "stdout": "", "stderr": "", "error": str(exc), "isolation": isolation_level()}
        try:
            out, err = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            _kill_tree(proc)
            out, err = proc.communicate()
            return {"ok": False, "error": f"Timed out after {timeout}s", "stdout": (out or "")[-8000:],
                    "stderr": (err or "")[-4000:], "code": 124, "isolation": isolation_level()}
        return {
            "ok": proc.returncode == 0,
            "code": proc.returncode,
            "stdout": (out or "")[-8000:],
            "stderr": (err or "")[-4000:],
            "note": RAN_NOTE,
            "isolation": isolation_level(),
        }

    def _env(self, home: Path, extra: dict | None) -> dict:
        env = os.environ.copy()
        env["HOME"] = str(home)
        env["ROOKS_TRY"] = "1"
        # Drop host secrets the agent must not leak into experiments.
        for key in list(env):
            upper = key.upper()
            if upper.endswith(("_API_KEY", "_TOKEN", "_SECRET", "_PASSWORD")) or upper in _SECRET_NAMES:
                env.pop(key, None)
        if self.offline:  # belt and braces next to the empty network namespace: proxy-aware programs stop at once
            for key in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
                env[key] = "http://127.0.0.1:9"
        for key, value in (extra or {}).items():
            env[str(key)] = str(value)
        return env

    def supports_screen(self) -> bool:
        return False

    def supports_pointer(self) -> bool:
        return False
