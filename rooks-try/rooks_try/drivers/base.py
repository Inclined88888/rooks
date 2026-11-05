"""What every Try Room driver must do."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


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

    def supports_screen(self) -> bool:
        return True
