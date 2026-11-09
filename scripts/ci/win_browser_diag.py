"""Temporary diagnosis for the Room's browser on the windows-2022 runner: start Edge and Chrome over the pipe with and
without the job's limits, and print what each did (exit code, how long until the pipe ended, what it printed)."""

import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "rooks-try"))
from rooks_try import browser as rb  # noqa: E402
from rooks_try import winproc  # noqa: E402


def attempt(path: str, label: str, job_kw: dict, extra: list[str]) -> None:
    home = Path(tempfile.mkdtemp()) / "home"
    home.mkdir()
    argv = [path, *rb.chrome_flags(home, "win32"), *extra]
    job = winproc.Job(**job_kw)
    t0 = time.monotonic()
    try:
        p = winproc.PipedProcess(argv, dict(os.environ), str(home), job)
    except OSError as e:
        print(f"[{label}] spawn failed: {e}")
        return
    out = bytearray()
    threading.Thread(target=lambda: out.extend(_drain(p.err)), daemon=True).start()
    os.write(p.wfd, json.dumps({"id": 1, "method": "Browser.getVersion"}).encode() + b"\0")
    got = b""
    done = threading.Event()

    def read():
        nonlocal got
        try:
            got = os.read(p.rfd, 65536)
        except OSError as e:
            got = repr(e).encode()
        done.set()

    threading.Thread(target=read, daemon=True).start()
    done.wait(30)
    print(f"[{label}] after {time.monotonic() - t0:.1f}s answer={got[:200]!r} exit={p.proc.poll()} "
          f"pids={job.pids()}")
    job.terminate(1)
    time.sleep(1)
    if b"result" not in got:
        print(f"[{label}] printed: {bytes(out[-800:]).decode('utf-8', 'replace')}")
    job.close()


def _drain(fd):
    buf = b""
    while True:
        try:
            c = os.read(fd, 4096)
        except OSError:
            break
        if not c:
            break
        buf += c
    return buf


engines = [r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
           r"C:\Program Files\Google\Chrome\Application\chrome.exe"]
log = ["--enable-logging=stderr", "--v=0"]
names = {0x01: "HANDLES", 0x02: "READCLIPBOARD", 0x04: "WRITECLIPBOARD", 0x08: "SYSTEMPARAMETERS",
         0x10: "DISPLAYSETTINGS", 0x20: "GLOBALATOMS", 0x40: "DESKTOP", 0x80: "EXITWINDOWS"}
chrome = engines[1]
for bit, name in names.items():
    attempt(chrome, f"chrome only {name}", dict(ui_limits=bit), [])
for bit, name in names.items():
    attempt(chrome, f"chrome all but {name}", dict(ui_limits=0xFF & ~bit), [])
