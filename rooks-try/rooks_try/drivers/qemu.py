"""Real Linux guest via QEMU. Works on Mac, Windows and Linux hosts when QEMU is installed.

The guest is always Linux so skills transfer. Apple Virtualization / Hyper-V can replace the
backend later; the Room API stays the same.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path

from .. import store
from .base import Driver, DriverInfo, stop_pid

LABEL = "A Linux computer of its own (a virtual machine)"
NOTE = "A separate computer running inside this one, with files of its own. Its screen needs a viewer program."


def _qemu_bin() -> str | None:
    for name in (
        "qemu-system-aarch64",
        "qemu-system-x86_64",
        "qemu-system-x86_64.exe",
        "qemu-system-aarch64.exe",
    ):
        path = shutil.which(name)
        if path:
            return path
    return None


class QemuDriver(Driver):
    name = "qemu"

    def __init__(self, offline: bool = False) -> None:
        super().__init__(offline=offline)
        self._vnc = "127.0.0.1:17"  # display :17 → port 5917

    def available(self) -> bool:
        if not _qemu_bin():
            return False
        # An image must exist or be fetchable; we only claim available when an image path is set
        # or a previously prepared disk is present, so `auto` does not hang on a huge download.
        return self._disk().exists() or bool(os.environ.get("ROOKS_TRY_IMAGE", "").strip())

    def info(self) -> DriverInfo:
        bin_ = _qemu_bin()
        if not bin_:
            return DriverInfo(
                "qemu",
                "Linux guest (QEMU)",
                False,
                "Install QEMU to run a real Linux guest on this Mac, Windows or Linux computer.",
            )
        if self.available():
            return DriverInfo("qemu", "Linux guest (QEMU)", True, f"Using {Path(bin_).name}. Best isolation.")
        return DriverInfo(
            "qemu",
            "Linux guest (QEMU)",
            False,
            "QEMU is installed. Set ROOKS_TRY_IMAGE to a Linux qcow2 path. rooks-try prepare explains the steps.",
        )

    def up(self) -> dict:
        if self.status().get("running") and self._alive():
            return self.status()
        self.down()
        disk = self._ensure_disk()
        bin_ = _qemu_bin()
        if not bin_:
            raise RuntimeError("QEMU is not installed on this computer.")
        log = store.root() / "qemu.log"
        cmd = [
            bin_,
            "-name", "rooks-try",
            "-m", os.environ.get("ROOKS_TRY_RAM", "2048"),
            "-smp", os.environ.get("ROOKS_TRY_CPUS", "2"),
            "-drive", f"file={disk},if=virtio,format=qcow2",
            "-vnc", self._vnc,
            "-display", "none",
        ]
        if "aarch64" in Path(bin_).name:
            cmd += ["-machine", "virt", "-cpu", "host"]
            # Firmware is machine-specific; users with HVF/KVM add their own accel via env.
        accel = os.environ.get("ROOKS_TRY_ACCEL", "").strip()
        if accel:
            cmd += ["-accel", accel]
        elif os.name == "posix" and Path("/dev/kvm").exists():
            cmd += ["-accel", "kvm"]
        if self.offline:
            cmd += ["-nic", "none"]
        else:
            cmd += ["-nic", "user,model=virtio"]
        proc = subprocess.Popen(cmd, stdout=log.open("ab"), stderr=subprocess.STDOUT, start_new_session=True)
        state = store.load_state()
        state.update({
            "driver": self.name,
            "running": True,
            "pid": proc.pid,
            "vnc": self._vnc,
            "disk": str(disk),
            "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })
        store.save_state(state)
        time.sleep(0.5)
        if proc.poll() is not None:
            raise RuntimeError("QEMU exited early. See qemu.log in the Room folder.")
        return self.status()

    def down(self) -> dict:
        state = store.load_state()
        pid = state.get("pid")
        if pid and state.get("driver") == self.name:
            stop_pid(pid)
        state["running"] = False
        store.save_state(state)
        return self.status()

    def status(self) -> dict:
        state = store.load_state()
        running = bool(state.get("running")) and state.get("driver") == self.name and self._alive()
        screen = bool(running and shutil.which("vncdotool"))
        return {
            "driver": self.name,
            "running": running,
            "screen": screen,
            "pointer": screen,
            "isolation": "vm",
            "vnc": state.get("vnc") or self._vnc,
            "home": str(store.guest_home()),
            "disk": state.get("disk") or str(self._disk()),
            "offline": self.offline,
            "label": LABEL,
            "note": NOTE,
            "last_checkpoint": state.get("last_checkpoint"),
        }

    def screenshot(self, path: Path) -> Path:
        if not shutil.which("vncdotool"):
            raise RuntimeError("The guest screen cannot be captured on this computer yet.")
        path.parent.mkdir(parents=True, exist_ok=True)
        host, disp = (store.load_state().get("vnc") or self._vnc).split(":")
        port = 5900 + int(disp)
        subprocess.run(["vncdotool", "-s", f"{host}::{port}", "capture", str(path)], check=False)
        if path.exists() and path.stat().st_size > 0:
            return path
        raise RuntimeError("The guest screen could not be captured.")

    def click(self, x: int, y: int, button: str = "left", count: int = 1) -> dict:
        which = {"left": "1", "middle": "2", "right": "3"}.get(button, "1")
        args = ["move", str(x), str(y)]
        for _ in range(max(1, min(int(count), 3))):
            args += ["click", which]
        return self._vnc_cmd(args)

    def drag(self, x1: int, y1: int, x2: int, y2: int) -> dict:
        return self._vnc_cmd(["move", str(x1), str(y1), "mousedown", "1", "move", str(x2), str(y2), "mouseup", "1"])

    def scroll(self, x: int, y: int, dy: int = -3) -> dict:
        which = "4" if int(dy) > 0 else "5"
        args = ["move", str(x), str(y)]
        for _ in range(max(1, min(abs(int(dy)), 20))):
            args += ["click", which]
        return self._vnc_cmd(args)

    def type_text(self, text: str) -> dict:
        return self._vnc_cmd(["type", text])

    def key(self, keys: str) -> dict:
        return self._vnc_cmd(["key", keys])

    def run(self, command: str, timeout: float = 120) -> dict:
        # The guest has no shell connection yet. Do not run the command on the host.
        return {
            "ok": False,
            "code": 127,
            "stdout": "",
            "stderr": "",
            "error": "This Linux guest has no command connection yet.",
        }

    def terminal_argv(self, home: Path) -> None:
        """A separate computer: its shell is inside it, not on this one (a serial or ssh console is a follow-up)."""
        return None

    def _vnc_cmd(self, args: list[str]) -> dict:
        if not shutil.which("vncdotool"):
            return {"ok": False, "error": "Install vncdotool to drive the QEMU screen, or use the nested driver on Linux."}
        host, disp = (store.load_state().get("vnc") or self._vnc).split(":")
        port = 5900 + int(disp)
        try:
            subprocess.run(["vncdotool", "-s", f"{host}::{port}", *args], check=True, timeout=30)
            return {"ok": True}
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            return {"ok": False, "error": str(exc)}

    def _disk(self) -> Path:
        return store.root() / "guest.qcow2"

    def _ensure_disk(self) -> Path:
        disk = self._disk()
        if disk.exists():
            return disk
        image = os.environ.get("ROOKS_TRY_IMAGE", "").strip()
        if not image:
            raise RuntimeError(
                "No guest disk yet. Set ROOKS_TRY_IMAGE to a qcow2 path. rooks-try prepare explains the steps."
            )
        src = Path(image).expanduser()
        if not src.exists():
            raise FileNotFoundError(f"ROOKS_TRY_IMAGE not found: {src}")
        qemu_img = shutil.which("qemu-img")
        if src.suffix.lower() in {".qcow2", ".img"} and qemu_img:
            subprocess.run([qemu_img, "create", "-f", "qcow2", "-F", "qcow2", "-b", str(src), str(disk)], check=True)
        elif qemu_img:
            subprocess.run([qemu_img, "convert", "-O", "qcow2", str(src), str(disk)], check=True)
        else:
            shutil.copy2(src, disk)
        return disk

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
