"""Private-home shell room. Always available. No host desktop control."""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

from .. import store
from .base import Driver, DriverInfo


class ShellDriver(Driver):
    name = "shell"

    def available(self) -> bool:
        return True

    def info(self) -> DriverInfo:
        return DriverInfo(
            "shell",
            "Private shell",
            True,
            "A clean home folder on this computer. Commands run here; the real desktop is untouched.",
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
            "home": str(store.guest_home()),
            "offline": self.offline,
            "label": "A private folder. Commands run as you.",
            "last_checkpoint": state.get("last_checkpoint"),
        }

    def screenshot(self, path: Path) -> Path:
        from PIL import Image, ImageDraw

        img = Image.new("RGB", (960, 540), (28, 32, 40))
        draw = ImageDraw.Draw(img)
        draw.text((40, 40), "Virtual computer", fill=(220, 220, 220))
        draw.text((40, 80), "A private folder on this computer.", fill=(160, 170, 180))
        draw.text((40, 120), "There is no separate screen.", fill=(160, 170, 180))
        draw.text((40, 160), "Type a command on the Virtual computer page.", fill=(160, 170, 180))
        path.parent.mkdir(parents=True, exist_ok=True)
        img.save(path)
        return path

    def click(self, x: int, y: int, button: str = "left", count: int = 1) -> dict:
        return {"ok": False, "error": "This practice computer has no screen to click."}

    def drag(self, x1: int, y1: int, x2: int, y2: int) -> dict:
        return self.click(x1, y1)

    def scroll(self, x: int, y: int, dy: int = -3) -> dict:
        return self.click(x, y)

    def type_text(self, text: str) -> dict:
        return {"ok": False, "error": "This practice computer has no screen."}

    def key(self, keys: str) -> dict:
        return {"ok": False, "error": "This practice computer has no screen."}

    def run(self, command: str, timeout: float = 120) -> dict:
        home = store.guest_home()
        env = os.environ.copy()
        env["HOME"] = str(home)
        env["ROOKS_TRY"] = "1"
        # Drop host secrets the agent must not leak into experiments.
        for key in list(env):
            upper = key.upper()
            if upper.endswith(("_API_KEY", "_TOKEN", "_SECRET", "_PASSWORD")) or upper in {
                "APP_SECRET", "TOOLS_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NVIDIA_API_KEY",
            }:
                env.pop(key, None)
        if self.offline:
            env["http_proxy"] = "http://127.0.0.1:9"
            env["https_proxy"] = "http://127.0.0.1:9"
            env["HTTP_PROXY"] = env["http_proxy"]
            env["HTTPS_PROXY"] = env["https_proxy"]
            env["ALL_PROXY"] = env["http_proxy"]
        try:
            proc = subprocess.run(
                command,
                shell=True,
                cwd=str(home),
                env=env,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": f"Timed out after {timeout}s", "stdout": "", "stderr": "", "code": 124}
        return {
            "ok": proc.returncode == 0,
            "code": proc.returncode,
            "stdout": (proc.stdout or "")[-8000:],
            "stderr": (proc.stderr or "")[-4000:],
            "note": "This ran as you, in the private folder.",
        }

    def supports_screen(self) -> bool:
        return False
