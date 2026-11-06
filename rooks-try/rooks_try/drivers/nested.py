"""A private desktop on this computer: an X display of its own (Xvfb) with a real terminal in it.

The person's pointer, keyboard and clipboard stay alone: input goes in through XTest (or xdotool) on that display and
the picture comes out with mss. A window manager runs when one is installed; otherwise a terminal fills the screen, so
the screen is never an empty black frame. Commands from run() start with DISPLAY set to the room, so a program they
open appears in the room, and they go through the shell driver, so they run as the person with the isolation it reports.
"""

from __future__ import annotations

import atexit
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from .. import store
from .base import Driver, DriverInfo, stop_pid
from .shell import ShellDriver, isolation_level, wrapped

LABEL = "A private desktop on this computer"
NOTE = "A screen of its own on this computer. Commands run as you, in a folder of its own."
WINDOW_MANAGERS = ("openbox", "fluxbox", "icewm", "xfwm4", "metacity", "matchbox-window-manager", "jwm", "fvwm", "twm")
# White on dark, a readable size, filling the screen. xterm falls back to its bitmap font when the face is missing.
TERMINAL_ARGS = ["-title", "Room", "-maximized", "+sb", "-bg", "#141210", "-fg", "#F2EDE3", "-fa", "DejaVu Sans Mono", "-fs", "11"]
SCREEN = "1280x720x24"


class NestedDriver(Driver):
    name = "nested"

    def __init__(self, offline: bool = False) -> None:
        super().__init__(offline=offline)
        self._display = os.environ.get("ROOKS_TRY_DISPLAY", ":17")
        self._procs: list[subprocess.Popen] = []
        self._xvfb_pid: int | None = None
        self._terminal: subprocess.Popen | None = None
        self._env: dict | None = None
        self._shell = ShellDriver(offline=offline)
        self._stop_registered = False

    def available(self) -> bool:
        return os.name == "posix" and shutil.which("Xvfb") is not None

    def info(self) -> DriverInfo:
        ok = self.available()
        detail = (
            "A private desktop on this computer with a real terminal in it. Fast. Needs Xvfb."
            if ok
            else "Needs Xvfb (Linux). On Mac and Windows the qemu driver is used instead."
        )
        return DriverInfo("nested", "Private desktop", ok, detail)

    def up(self) -> dict:
        if self.status().get("running") and self._alive():
            return self.status()
        self.down()
        home = store.guest_home()
        (home / "Desktop").mkdir(exist_ok=True)
        log = store.root() / "nested.log"
        xvfb = subprocess.Popen(
            ["Xvfb", self._display, "-screen", "0", SCREEN, "-nolisten", "tcp"],
            stdout=log.open("ab"),
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        self._procs.append(xvfb)
        self._xvfb_pid = xvfb.pid
        if not self._wait_for_display(xvfb):
            raise RuntimeError("The room's display did not start. See nested.log in the Room folder.")
        env = os.environ.copy()
        env["DISPLAY"] = self._display
        env["HOME"] = str(home)
        self._env = env
        self._start_desktop(env, home)
        state = store.load_state()
        state.update({
            "driver": self.name,
            "running": True,
            "display": self._display,
            "pid": xvfb.pid,
            "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })
        store.save_state(state)
        if not self._stop_registered:
            atexit.register(self._stop_at_exit)
            self._stop_registered = True
        return self.status()

    def _stop_at_exit(self) -> None:
        """At interpreter exit: stop what this process started, without touching the store (its folder may be gone)."""
        for proc in self._procs:
            try:
                proc.terminate()
            except Exception:  # noqa: BLE001
                pass
        stop_pid(self._xvfb_pid)

    def down(self) -> dict:
        state = store.load_state()
        pid = state.get("pid")
        if pid and state.get("driver") == self.name:
            stop_pid(pid)
        for proc in self._procs:
            try:
                proc.terminate()
            except Exception:  # noqa: BLE001
                pass
        self._procs.clear()
        self._terminal = None
        state["running"] = False
        store.save_state(state)
        return self.status()

    def status(self) -> dict:
        state = store.load_state()
        running = bool(state.get("running")) and self._alive()
        return {
            "driver": self.name,
            "running": running,
            "screen": True,
            "pointer": True,
            "isolation": isolation_level(),
            "display": state.get("display") or self._display,
            "home": str(store.guest_home()),
            "offline": self.offline,
            "label": LABEL,
            "note": NOTE,
            "last_checkpoint": state.get("last_checkpoint"),
        }

    def screenshot(self, path: Path) -> Path:
        self._ensure_up()
        self._ensure_desktop()
        import mss
        from PIL import Image

        display = self._display_name()
        path.parent.mkdir(parents=True, exist_ok=True)
        factory = getattr(mss, "MSS", None) or mss.mss
        try:
            grabber = factory(display=display)
        except TypeError:  # an mss without a display argument: point it at the room for the grab
            previous = os.environ.get("DISPLAY")
            os.environ["DISPLAY"] = display
            try:
                grabber = factory()
            finally:
                if previous is None:
                    os.environ.pop("DISPLAY", None)
                else:
                    os.environ["DISPLAY"] = previous
        with grabber as sct:
            shot = sct.grab(sct.monitors[1])
            Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX").save(path)
        return path

    def click(self, x: int, y: int, button: str = "left", count: int = 1) -> dict:
        self._ensure_up()
        self._xtest_move(x, y)
        mapping = {"left": 1, "middle": 2, "right": 3}
        btn = mapping.get(button, 1)
        for _ in range(max(1, count)):
            self._xtest_button(btn, True)
            self._xtest_button(btn, False)
        return {"ok": True, "x": x, "y": y, "button": button}

    def drag(self, x1: int, y1: int, x2: int, y2: int) -> dict:
        self._ensure_up()
        self._xtest_move(x1, y1)
        self._xtest_button(1, True)
        self._xtest_move(x2, y2)
        self._xtest_button(1, False)
        return {"ok": True, "from": [x1, y1], "to": [x2, y2]}

    def scroll(self, x: int, y: int, dy: int = -3) -> dict:
        self._ensure_up()
        self._xtest_move(x, y)
        btn = 4 if dy > 0 else 5
        for _ in range(abs(int(dy)) or 1):
            self._xtest_button(btn, True)
            self._xtest_button(btn, False)
        return {"ok": True, "x": x, "y": y, "dy": dy}

    def type_text(self, text: str) -> dict:
        self._ensure_up()
        # Prefer xdotool when present; else XTest key events for ASCII.
        if shutil.which("xdotool"):
            env = {**os.environ, "DISPLAY": self._display_name()}
            subprocess.run(["xdotool", "type", "--clearmodifiers", "--", text], env=env, check=False)
            return {"ok": True, "chars": len(text)}
        for ch in text:
            if ch == "\n":
                self.key("Return")
            else:
                self._xtest_char(ch)
        return {"ok": True, "chars": len(text)}

    def key(self, keys: str) -> dict:
        self._ensure_up()
        if shutil.which("xdotool"):
            env = {**os.environ, "DISPLAY": self._display_name()}
            subprocess.run(["xdotool", "key", keys], env=env, check=False)
            return {"ok": True, "keys": keys}
        self._xtest_char(keys)
        return {"ok": True, "keys": keys}

    def run(self, command: str, timeout: float = 120) -> dict:
        """A command in the room's home, with the room's display, so a program it opens shows up in the room."""
        self._ensure_up()
        return self._shell.run(command, timeout=timeout, env_extra={"DISPLAY": self._display_name()})

    def _ensure_up(self) -> None:
        if not self.status().get("running"):
            self.up()

    def _ensure_desktop(self) -> None:
        """The terminal is the desktop here: when it was closed, open it again so the screen is never left empty."""
        if self._terminal is not None and self._terminal.poll() is not None and self._env:
            self._procs = [p for p in self._procs if p is not self._terminal]
            self._terminal = None
            self._start_desktop(self._env, store.guest_home(), terminal_only=True)
            time.sleep(0.3)

    def _display_name(self) -> str:
        return store.load_state().get("display") or self._display

    def _alive(self) -> bool:
        state = store.load_state()
        pid = state.get("pid")
        if not pid:
            return False
        try:
            os.kill(int(pid), 0)
            return True
        except (ProcessLookupError, PermissionError, OSError):
            return False

    def _wait_for_display(self, xvfb: subprocess.Popen, timeout: float = 5.0) -> bool:
        """True once the display answers (or, without python-xlib to ask, once Xvfb has stayed up for a moment)."""
        deadline = time.monotonic() + timeout
        try:
            from Xlib import display as xdisplay
        except ImportError:
            time.sleep(0.5)
            return xvfb.poll() is None
        while time.monotonic() < deadline:
            if xvfb.poll() is not None:
                return False
            try:
                conn = xdisplay.Display(self._display)
                conn.close()
                return True
            except Exception:  # noqa: BLE001 - not listening yet
                time.sleep(0.1)
        return False

    def _spawn(self, argv: list[str], env: dict, cwd: Path | None = None) -> subprocess.Popen:
        log = store.root() / "nested.log"
        return subprocess.Popen(
            argv,
            env=env,
            cwd=str(cwd) if cwd else None,
            stdout=subprocess.DEVNULL,
            stderr=log.open("ab"),
            start_new_session=True,
        )

    def _start_desktop(self, env: dict, home: Path, terminal_only: bool = False) -> None:
        """A window manager when one is installed, and a terminal that fills the screen. Without a terminal on this
        computer, a plain labelled window keeps the screen from being an empty frame."""
        if not terminal_only:
            manager = next((shutil.which(n) for n in WINDOW_MANAGERS if shutil.which(n)), None)
            if manager:
                self._procs.append(self._spawn([manager], env))
        xterm = shutil.which("xterm")
        if xterm:
            self._terminal = self._spawn([xterm, *TERMINAL_ARGS, "-e", *self._login_shell(home)], env, cwd=home)
            self._procs.append(self._terminal)
        elif not terminal_only:
            self._procs.append(self._spawn_canvas(env))

    def _login_shell(self, home: Path) -> list[str]:
        """The shell inside the terminal, with the same isolation the shell driver gives a command."""
        inner = 'exec "${SHELL:-/bin/sh}"'
        argv = wrapped(inner, home, self.offline)
        if argv:
            return argv
        return ["sh", "-c", 'cd "$1" && exec "${SHELL:-/bin/sh}"', "room", str(home)]

    def _spawn_canvas(self, env: dict) -> subprocess.Popen:
        """A plain labelled window on the room's display (a real window, not a picture), with this interpreter."""
        script = store.root() / "canvas.py"
        script.write_text(
            "import os\n"
            "from Xlib import X, display\n"
            "d = display.Display(os.environ.get('DISPLAY', ':17'))\n"
            "s = d.screen()\n"
            "w = s.root.create_window(0, 0, s.width_in_pixels, s.height_in_pixels, 0, s.root_depth, X.InputOutput,\n"
            "                         X.CopyFromParent, background_pixel=s.white_pixel, event_mask=X.ExposureMask)\n"
            "w.set_wm_name('Room')\n"
            "gc = w.create_gc(foreground=s.black_pixel, background=s.white_pixel)\n"
            "w.map()\n"
            "d.flush()\n"
            "while True:\n"
            "    e = d.next_event()\n"
            "    if e.type == X.Expose:\n"
            "        w.draw_text(gc, 24, 40, 'The Room. No terminal program is installed on this computer, so this screen stays empty.')\n"
            "        d.flush()\n"
        )
        return self._spawn([sys.executable, str(script)], env)

    def _display_conn(self):
        from Xlib import display

        return display.Display(self._display_name())

    def _xtest_move(self, x: int, y: int) -> None:
        from Xlib.ext import xtest
        from Xlib import X

        d = self._display_conn()
        xtest.fake_input(d, X.MotionNotify, x=int(x), y=int(y))
        d.sync()
        d.close()

    def _xtest_button(self, button: int, pressed: bool) -> None:
        from Xlib.ext import xtest
        from Xlib import X

        d = self._display_conn()
        xtest.fake_input(d, X.ButtonPress if pressed else X.ButtonRelease, button)
        d.sync()
        d.close()

    def _xtest_char(self, ch: str) -> None:
        from Xlib import X, XK
        from Xlib.ext import xtest

        d = self._display_conn()
        keysym = XK.string_to_keysym("Return" if ch in ("Return", "\n") else ch)
        keycode = d.keysym_to_keycode(keysym) if keysym else 0
        if not keycode:
            d.close()
            return
        xtest.fake_input(d, X.KeyPress, keycode)
        xtest.fake_input(d, X.KeyRelease, keycode)
        d.sync()
        d.close()
