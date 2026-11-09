"""The uninstaller's "Also remove my chats, keys and the Room" (design 0011, section 4): before the data folders go,
the hook runs `workbench-server.exe --forget-secrets`, which deletes the app's entries in Windows Credential Manager.

keyring writes them as generic credentials whose target is the service ("ai-workspace") or "<name>@ai-workspace".
Only those are removed: never another program's, even one whose name merely contains ours. The real Credential
Manager is used in desktop.yml's Windows install check (an entry made with cmdkey is gone after /CLEANDATA)."""

import importlib.util
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _server():
    spec = importlib.util.spec_from_file_location("workbench_server_forget", ROOT / "desktop" / "sidecar" / "workbench_server.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_only_the_apps_own_entries_are_forgotten():
    ws = _server()
    stored = [("ai-workspace", 1), ("APP_SECRET@ai-workspace", 1), ("TOOLS_API_KEY@ai-workspace", 1),
              ("ai-workspace-other", 1), ("not-ai-workspace", 1), ("x@ai-workspace.example", 1),
              ("MicrosoftAccount:user=someone", 1), ("git:https://github.com", 1)]
    deleted = []
    n = ws.forget_secrets(listing=lambda: list(stored), delete=lambda target, kind: deleted.append(target) or True)
    assert sorted(deleted) == ["APP_SECRET@ai-workspace", "TOOLS_API_KEY@ai-workspace", "ai-workspace"]
    assert n == 3


def test_the_switch_runs_before_anything_else_and_needs_no_data_folder(tmp_path):
    """The uninstaller gives no --data-dir; the program must not start the app or make a folder."""
    out = subprocess.run([sys.executable, str(ROOT / "desktop" / "sidecar" / "workbench_server.py"), "--forget-secrets"],
                         capture_output=True, text=True, timeout=120, cwd=tmp_path)
    assert out.returncode == 0, out.stderr[-800:]
    assert "removed" in out.stdout
    assert list(tmp_path.iterdir()) == []
