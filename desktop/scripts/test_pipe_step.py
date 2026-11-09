"""The packaged app starts the Room's browser through its own program (it has no Python to run `-c` with): the
sidecar's entry point must hand --rooks-pipe-step to rooks_try.browser.pipe_step before anything else, and the browser
must then find its pipe at fds 3 and 4."""

import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.skipif(not Path("/proc/self/fd").exists(), reason="reads /proc")
def test_the_sidecar_entry_puts_the_browsers_pipe_at_fds_3_and_4():
    r, _w = os.pipe()
    _r2, w2 = os.pipe()
    env = {**os.environ, "PYTHONPATH": str(ROOT / "rooks-try")}
    out = subprocess.run([sys.executable, str(ROOT / "desktop" / "sidecar" / "workbench_server.py"), "--rooks-pipe-step",
                          str(r), str(w2), "/bin/sh", "-c", "test -e /proc/self/fd/3 && test -e /proc/self/fd/4 && echo ok"],
                         pass_fds=(r, w2), capture_output=True, text=True, timeout=60, env=env)
    assert out.stdout.strip() == "ok", out.stderr[-800:]
