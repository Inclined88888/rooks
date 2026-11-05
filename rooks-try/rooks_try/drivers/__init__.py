"""Guest drivers: qemu (VM), nested (private display), shell (private home only)."""

from __future__ import annotations

from .base import Driver, DriverInfo
from .nested import NestedDriver
from .qemu import QemuDriver
from .shell import ShellDriver


def pick(prefer: str = "auto", offline: bool = False) -> Driver:
    """Choose the strongest driver this computer can run."""
    order = {
        "auto": ("qemu", "nested", "shell"),
        "qemu": ("qemu",),
        "nested": ("nested", "shell"),
        "shell": ("shell",),
    }.get(prefer, ("qemu", "nested", "shell"))
    last: Exception | None = None
    for name in order:
        cls = {"qemu": QemuDriver, "nested": NestedDriver, "shell": ShellDriver}[name]
        try:
            driver = cls(offline=offline)
            if driver.available():
                return driver
        except Exception as exc:  # noqa: BLE001
            last = exc
    if last:
        raise last
    return ShellDriver(offline=offline)


def describe_all() -> list[DriverInfo]:
    return [cls().info() for cls in (QemuDriver, NestedDriver, ShellDriver)]
