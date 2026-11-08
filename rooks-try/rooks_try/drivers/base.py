"""What every Room driver must do."""

from __future__ import annotations

import os
import signal
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


def stop_pid(pid: int | None) -> None:
    """Stop a guest process on this computer, including its children."""
    if not pid:
        return
    pid = int(pid)
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], check=False)
        return
    try:
        os.killpg(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            os.kill(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            pass


@dataclass
class DriverInfo:
    name: str
    label: str
    available: bool
    detail: str

    def to_dict(self) -> dict:
        return asdict(self)


class Driver:
    name = "base"

    def __init__(self, offline: bool = False) -> None:
        self.offline = offline

    def available(self) -> bool:
        return False

    def info(self) -> DriverInfo:
        return DriverInfo(self.name, self.name, self.available(), "")

    def up(self) -> dict:
        raise NotImplementedError

    def down(self) -> dict:
        raise NotImplementedError

    def status(self) -> dict:
        raise NotImplementedError

    def screenshot(self, path: Path) -> Path:
        raise NotImplementedError

    def click(self, x: int, y: int, button: str = "left", count: int = 1) -> dict:
        raise NotImplementedError

    def drag(self, x1: int, y1: int, x2: int, y2: int) -> dict:
        raise NotImplementedError

    def scroll(self, x: int, y: int, dy: int = -3) -> dict:
        raise NotImplementedError

    def type_text(self, text: str) -> dict:
        raise NotImplementedError

    def key(self, keys: str) -> dict:
        raise NotImplementedError

    def run(self, command: str, timeout: float = 120) -> dict:
        raise NotImplementedError

    def terminal_argv(self, home: Path) -> list[str] | None:
        """The login shell a terminal opens inside the Room, on this computer. None when the Room has no shell here
        (a separate computer, a drawing)."""
        return None

    def supports_screen(self) -> bool:
        """Whether this driver ever has a real picture to show. Status carries the live value as `screen`."""
        return True

    def supports_pointer(self) -> bool:
        """Whether clicks and drags reach something real. A drawing has a screen and no pointer."""
        return True
