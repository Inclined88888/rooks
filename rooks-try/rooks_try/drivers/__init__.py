"""Guest drivers: qemu (a virtual machine), nested (a private desktop), shell (a private folder and shell).

The display driver (a drawing of a terminal) is listed but never chosen on its own: it is a picture, not a screen, and
only an explicit name reaches it.
"""

from __future__ import annotations

from .base import Driver, DriverInfo
from .display import DisplayDriver
from .nested import NestedDriver
from .qemu import QemuDriver
from .shell import ShellDriver

AUTO_ORDER = ("qemu", "nested", "shell")


def pick(prefer: str = "auto", offline: bool = False) -> Driver:
    """Choose the strongest real driver this computer can run.

    auto may fall through to the private folder. An explicit driver does not.
    """
    order = {
        "auto": AUTO_ORDER,
        "qemu": ("qemu",),
        "nested": ("nested",),
        "display": ("display",),
        "shell": ("shell",),
    }.get(prefer)
    if order is None:
        raise ValueError(f"Unknown driver {prefer}")
    classes = {"qemu": QemuDriver, "nested": NestedDriver, "display": DisplayDriver, "shell": ShellDriver}
    last: Exception | None = None
    for name in order:
        try:
            driver = classes[name](offline=offline)
            if driver.available():
                return driver
        except Exception as exc:  # noqa: BLE001
            last = exc
    if prefer == "auto" and last is None:
        return ShellDriver(offline=offline)
    if last:
        raise last
    raise RuntimeError(f"{prefer} is not available on this computer.")


def describe_all() -> list[DriverInfo]:
    return [cls().info() for cls in (QemuDriver, NestedDriver, DisplayDriver, ShellDriver)]
