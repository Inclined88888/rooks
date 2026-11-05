"""Try Room facade used by the CLI, MCP server and HTTP API."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from . import store
from .drivers import describe_all, pick
from .drivers.base import Driver
from .drivers.nested import NestedDriver
from .drivers.qemu import QemuDriver
from .drivers.shell import ShellDriver

_DRIVERS = {"qemu": QemuDriver, "nested": NestedDriver, "shell": ShellDriver}


class TryRoom:
    def __init__(self, prefer: str = "auto", offline: bool = False) -> None:
        self.prefer = prefer
        self.offline = offline
        self._driver: Driver | None = None

    def driver(self) -> Driver:
        if self._driver is None:
            state = store.load_state()
            prefer = self.prefer
            if prefer == "auto" and state.get("driver") in {"qemu", "nested", "shell"}:
                prefer = state["driver"]
            self._driver = pick(prefer=prefer, offline=self.offline)
        return self._driver

    def drivers(self) -> list[dict]:
        return [d.to_dict() for d in describe_all()]

    def up(self) -> dict:
        return self.driver().up()

    def down(self) -> dict:
        name = store.load_state().get("driver")
        if name in _DRIVERS:
            self._driver = _DRIVERS[name](offline=self.offline)
        if self._driver:
            return self._driver.down()
        return {"running": False}

    def status(self) -> dict:
        try:
            st = self.driver().status()
        except Exception as exc:  # noqa: BLE001
            st = {"running": False, "error": str(exc)}
        st["drivers"] = self.drivers()
        st["checkpoints"] = store.list_checkpoints()[:10]
        return st

    def checkpoint(self, label: str = "") -> dict:
        meta = store.checkpoint(label)
        meta["disk"] = _disk_snapshot(meta["name"], apply=False)
        return meta

    def reset(self, name: str | None = None) -> dict:
        was = self.status().get("running")
        if was:
            self.down()
        meta = store.restore(name)
        meta["disk"] = _disk_snapshot(meta["name"], apply=True)
        if was:
            meta["status"] = self.up()
        return meta

    def screenshot(self, path: str | Path | None = None) -> Path:
        dest = Path(path) if path else store.work_dir() / "screen.png"
        return self.driver().screenshot(dest)

    def click(self, x: int, y: int, button: str = "left", count: int = 1) -> dict:
        return self.driver().click(int(x), int(y), button=button, count=count)

    def drag(self, x1: int, y1: int, x2: int, y2: int) -> dict:
        return self.driver().drag(int(x1), int(y1), int(x2), int(y2))

    def scroll(self, x: int, y: int, dy: int = -3) -> dict:
        return self.driver().scroll(int(x), int(y), dy=int(dy))

    def type_text(self, text: str) -> dict:
        return self.driver().type_text(text)

    def key(self, keys: str) -> dict:
        return self.driver().key(keys)

    def run(self, command: str, timeout: float = 120) -> dict:
        return self.driver().run(command, timeout=timeout)

    def handoff(self, src: str, dest: str, approve: bool = False) -> dict:
        """Copy a file from the Try Room home to a host path. Needs approve=True."""
        if not approve:
            return {
                "ok": False,
                "needs_approval": True,
                "summary": f"Copy {src} from the Try Room to {dest} on this computer?",
            }
        home = store.guest_home().resolve()
        source = (home / src).resolve() if not Path(src).is_absolute() else Path(src).resolve()
        if home not in source.parents and source != home:
            return {"ok": False, "error": "That file is not inside the Try Room."}
        if not source.exists():
            return {"ok": False, "error": "No such file in the Try Room."}
        target = Path(dest).expanduser().resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir():
            shutil.copytree(source, target, dirs_exist_ok=True)
        else:
            shutil.copy2(source, target)
        return {"ok": True, "from": str(source), "to": str(target)}


def _disk_snapshot(name: str, apply: bool) -> bool:
    """Save or restore a QEMU disk point. The folder checkpoint is separate."""
    disk = store.root() / "guest.qcow2"
    qemu_img = shutil.which("qemu-img")
    if not name or not disk.exists() or not qemu_img:
        return False
    flag = "-a" if apply else "-c"
    proc = subprocess.run([qemu_img, "snapshot", flag, name, str(disk)], capture_output=True)
    return proc.returncode == 0
