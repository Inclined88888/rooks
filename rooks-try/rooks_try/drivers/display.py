"""A private screen drawn on this computer. No extra program, and not the person's own desktop."""

from __future__ import annotations

import time
from pathlib import Path

from .. import store
from .base import Driver, DriverInfo
from .shell import ShellDriver

_W, _H = 1280, 720


def _font(size: int):
    from PIL import ImageFont

    for path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        "/System/Library/Fonts/Menlo.ttc",
        "/Library/Fonts/Menlo.ttc",
    ):
        if Path(path).is_file():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


class DisplayDriver(Driver):
    """A screen of our own: a desktop and a window, updated when you click or type."""

    name = "display"

    def __init__(self, offline: bool = False) -> None:
        super().__init__(offline=offline)
        self._shell = ShellDriver(offline=offline)
        self._lines: list[str] = []
        self._input = ""
        self._image = None

    def available(self) -> bool:
        try:
            from PIL import Image  # noqa: F401
        except ImportError:
            return False
        return True

    def info(self) -> DriverInfo:
        ok = self.available()
        detail = (
            "A separate screen on this computer. Your own desktop stays alone."
            if ok
            else "A separate screen needs the picture library."
        )
        return DriverInfo("display", "Separate screen", ok, detail)

    def up(self) -> dict:
        home = store.guest_home()
        (home / "Desktop").mkdir(exist_ok=True)
        self._lines = [
            "Virtual computer",
            "This screen is not your Mac. Click it, then type.",
            "",
        ]
        self._input = ""
        self._paint()
        state = store.load_state()
        state.update({
            "driver": self.name,
            "running": True,
            "screen": True,
            "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })
        store.save_state(state)
        return self.status()

    def down(self) -> dict:
        state = store.load_state()
        state["running"] = False
        store.save_state(state)
        return self.status()

    def status(self) -> dict:
        state = store.load_state()
        running = bool(state.get("running")) and state.get("driver") == self.name and self._image is not None
        return {
            "driver": self.name,
            "running": running,
            "screen": True,
            "width": _W,
            "height": _H,
            "home": str(store.guest_home()),
            "offline": self.offline,
            "label": "A separate screen on this computer",
            "last_checkpoint": state.get("last_checkpoint"),
        }

    def screenshot(self, path: Path) -> Path:
        self._ensure_up()
        path.parent.mkdir(parents=True, exist_ok=True)
        self._image.save(path)
        return path

    def click(self, x: int, y: int, button: str = "left", count: int = 1) -> dict:
        self._ensure_up()
        return {"ok": True, "x": int(x), "y": int(y), "button": button}

    def drag(self, x1: int, y1: int, x2: int, y2: int) -> dict:
        self._ensure_up()
        return {"ok": True, "from": [int(x1), int(y1)], "to": [int(x2), int(y2)]}

    def scroll(self, x: int, y: int, dy: int = -3) -> dict:
        self._ensure_up()
        return {"ok": True, "x": int(x), "y": int(y), "dy": int(dy)}

    def type_text(self, text: str) -> dict:
        self._ensure_up()
        for ch in text:
            if ch == "\n":
                self._enter()
            elif ch == "\b":
                self._input = self._input[:-1]
            else:
                if len(self._input) < 400:
                    self._input += ch
        self._paint()
        return {"ok": True, "chars": len(text)}

    def key(self, keys: str) -> dict:
        self._ensure_up()
        name = (keys or "").strip()
        if name in {"Return", "Enter", "\n"}:
            self._enter()
        elif name in {"BackSpace", "Backspace"}:
            self._input = self._input[:-1]
            self._paint()
        elif len(name) == 1:
            self.type_text(name)
            return {"ok": True, "keys": keys}
        return {"ok": True, "keys": keys}

    def run(self, command: str, timeout: float = 120) -> dict:
        self._ensure_up()
        return self._shell.run(command, timeout=timeout)

    def _ensure_up(self) -> None:
        if self._image is None or not self.status().get("running"):
            self.up()

    def _enter(self) -> None:
        command = self._input
        self._lines.append("virtual@computer:~$ " + command)
        self._input = ""
        if command.strip():
            result = self._shell.run(command, timeout=20)
            text = "\n".join(part for part in (result.get("stdout") or "", result.get("stderr") or "", result.get("error") or "") if part)
            for line in text.splitlines() or []:
                self._lines.append(line[:160])
        self._lines = self._lines[-40:]
        self._paint()

    def _paint(self) -> None:
        from PIL import Image, ImageDraw

        img = Image.new("RGB", (_W, _H), (28, 31, 38))
        draw = ImageDraw.Draw(img)
        draw.rounded_rectangle((36, 32, _W - 36, _H - 32), radius=16, fill=(16, 17, 20))
        draw.rectangle((36, 32, _W - 36, 78), fill=(42, 45, 54))
        title = _font(18)
        body = _font(16)
        draw.text((56, 46), "Virtual computer", fill=(236, 237, 240), font=title)
        y = 96
        for line in self._lines[-22:]:
            draw.text((56, y), line, fill=(214, 218, 224), font=body)
            y += 24
        draw.text((56, y), "virtual@computer:~$ " + self._input + "▌", fill=(244, 244, 246), font=body)
        self._image = img
