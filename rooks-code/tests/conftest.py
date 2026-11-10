import os
import subprocess
import sys
from pathlib import Path

import pytest

PKG = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PKG))
sys.path.insert(0, str(Path(__file__).resolve().parent))


@pytest.fixture(autouse=True)
def no_local_servers(monkeypatch, tmp_path):
    """A Workbench on this machine (Docker on :3100) or keys saved by a real `rooks login` must not leak into tests."""
    # Clear all API key and token env vars so tests are isolated from the shell
    for name in tuple(os.environ):
        if name.endswith(("_API_KEY", "_TOKEN")):
            monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("WORKBENCH_PORT", "9")
    monkeypatch.setenv("ROOKS_CONFIG", str(tmp_path / "isolated-rooks.toml"))


def _can_contain() -> bool:
    """Whether this machine can keep project-mode commands inside the folder (tools._command_argv)."""
    import shutil
    if sys.platform == "darwin":
        return bool(shutil.which("sandbox-exec"))
    if sys.platform.startswith("linux"):
        from rooks_code import tools
        b = shutil.which("bwrap")
        return bool(b) and tools._bwrap_problem((b, "--ro-bind", "/", "/", "--dev-bind", "/dev", "/dev")) == ""
    return False


@pytest.fixture
def project(tmp_path, monkeypatch):
    p = tmp_path / "proj"
    p.mkdir()
    (p / "calc.py").write_text("def add(a, b):\n    return a - b\n")
    (p / "test_calc.py").write_text("from calc import add\nassert add(2, 3) == 5, 'add is broken'\nprint('tests pass')\n")
    cfg = tmp_path / "rooks.toml"
    # These tests are about approvals, diffs and receipts, not containment (test_units covers that). On a Linux machine
    # without a working bubblewrap the project default refuses commands, so the fixture turns containment off there.
    cfg.write_text("" if _can_contain() else 'sandbox = "full"\n')
    monkeypatch.setenv("ROOKS_CONFIG", str(cfg))
    monkeypatch.setenv("AI_WORKSPACE_APP_FILE", str(tmp_path / "no-app.json"))  # never pick up a real running app
    monkeypatch.setenv("ROOKS_DESK_MCP", "0")  # an installed Rooks Desk must not add an MCP server to every test
    for k in ("ROOKS_PROVIDER", "ROOKS_MODEL", "ROOKS_BASE_URL", "WORKBENCH_URL", "WORKBENCH_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    return p


def rooks(project, *args, stdin="", env=None):
    e = {**os.environ, "PYTHONPATH": str(PKG), "NO_COLOR": "1", "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1", **(env or {})}
    return subprocess.run([sys.executable, "-m", "rooks_code", "-C", str(project), *args] if args and args[0] not in (
        "undo", "receipts", "doctor", "init", "mcp", "version", "login", "egress", "pack", "redact") else [sys.executable, "-m", "rooks_code", *args],
        input=stdin, capture_output=True, text=True, encoding="utf-8", env=e, timeout=60)
