"""Private X11 desktop on this computer (Xvfb). Host pointer and clipboard stay alone."""

from __future__ import annotations

import atexit
import os
import shutil
import subprocess
import time
from pathlib import Path

from .. import store
from .base import Driver, DriverInfo, stop_pid
from .shell import ShellDriver


class NestedDriver(Driver):
    name = "nested"

    def __init__(self, offline: bool = False) -> None:
        super().__init__(offline=offline)
        self._display = os.environ.get("ROOKS_TRY_DISPLAY", ":17")
        self._procs: list[subprocess.Popen] = []
        self._shell = ShellDriver(offline=offline)
        self._stop_registered = False

    def available(self) -> bool:
        return os.name == "posix" and shutil.which("Xvfb") is not None

    def info(self) -> DriverInfo:
        ok = self.available()
        detail = (
            "A private X11 desktop on this computer. Fast. Needs Xvfb."
            if ok
            else "Needs Xvfb (Linux). On Mac/Windows the qemu driver is used instead."
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
            ["Xvfb", self._display, "-screen", "0", "1280x720x24", "-nolisten", "tcp"],
            stdout=log.open("ab"),
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        self._procs.append(xvfb)
        time.sleep(0.4)
        if xvfb.poll() is not None:
            raise RuntimeError("Xvfb failed to start. See nested.log in the Try Room folder.")
        env = os.environ.copy()
        env["DISPLAY"] = self._display
        env["HOME"] = str(home)
        # Wallpaper / welcome window so screenshots are not empty black.
        self._spawn_canvas(env)
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
            atexit.register(self.down)
            self._stop_registered = True
        return self.status()

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
            "display": state.get("display") or self._display,
            "home": str(store.guest_home()),
            "offline": self.offline,
            "label": "Private desktop on this computer",
            "last_checkpoint": state.get("last_checkpoint"),
        }

    def screenshot(self, path: Path) -> Path:
        self._ensure_up()
        import mss
        from PIL import Image

        display = store.load_state().get("display") or self._display
        path.parent.mkdir(parents=True, exist_ok=True)
        previous = os.environ.get("DISPLAY")
        os.environ["DISPLAY"] = display
        try:
            with mss.MSS() as sct:
                shot = sct.grab(sct.monitors[1])
                Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX").save(path)
        finally:
            if previous is None:
                os.environ.pop("DISPLAY", None)
            else:
                os.environ["DISPLAY"] = previous
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
            env = {"DISPLAY": store.load_state().get("display") or self._display}
            subprocess.run(["xdotool", "type", "--clearmodifiers", "--", text], env={**os.environ, **env}, check=False)
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
            env = {"DISPLAY": store.load_state().get("display") or self._display}
            subprocess.run(["xdotool", "key", keys], env={**os.environ, **env}, check=False)
            return {"ok": True, "keys": keys}
        self._xtest_char(keys)
        return {"ok": True, "keys": keys}

    def run(self, command: str, timeout: float = 120) -> dict:
        self._ensure_up()
        return self._shell.run(command, timeout=timeout)

    def _ensure_up(self) -> None:
        if not self.status().get("running"):
            self.up()

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

    def _spawn_canvas(self, env: dict) -> None:
        """Open a simple labelled window so the room is visibly 'alive' without a full DE."""
        script = store.root() / "canvas.py"
        script.write_text(
            "import os\n"
            "os.environ['DISPLAY'] = os.environ.get('DISPLAY', ':17')\n"
            "try:\n"
            "    from Xlib import X, display\n"
            "    d = display.Display()\n"
            "    s = d.screen()\n"
            "    w = s.root.create_window(40, 40, 900, 500, 1, s.root_depth, X.InputOutput, X.CopyFromParent,\n"
            "                             background_pixel=s.black_pixel, event_mask=X.ExposureMask)\n"
            "    w.set_wm_name('Practice computer')\n"
            "    w.map()\n"
            "    d.flush()\n"
            "    while True:\n"
            "        d.next_event()\n"
            "except Exception:\n"
            "    import time\n"
            "    while True:\n"
            "        time.sleep(3600)\n"
        )
        proc = subprocess.Popen(
            ["python3", str(script)],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        self._procs.append(proc)

    def _display_conn(self):
        from Xlib import display

        previous = os.environ.get("DISPLAY")
        os.environ["DISPLAY"] = store.load_state().get("display") or self._display
        try:
            return display.Display()
        finally:
            if previous is None:
                os.environ.pop("DISPLAY", None)
            else:
                os.environ["DISPLAY"] = previous

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
