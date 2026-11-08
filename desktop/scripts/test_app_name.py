"""The desktop app is called Rooks (docs/design/0007, 2.3), and nothing else moves with the name.

* productName and the window title are "Rooks"; the splash says Rooks.
* The identifier stays com.inclined88888.aiworkspace: Tauri 2's app_data_dir() and app_log_dir() and the webview's
  storage are keyed by it, so chats, keys and settings stay where they are.
* mainBinaryName stays ai-workspace-desktop: the launcher and the installer find the real app by it.
* The aiworkspace:// link scheme stays, so links made before keep working.
"""

import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TAURI = REPO / "desktop" / "src-tauri"
CONF = json.loads((TAURI / "tauri.conf.json").read_text())


def test_the_app_is_called_rooks():
    assert CONF["productName"] == "Rooks"
    main = next(w for w in CONF["app"]["windows"] if w["label"] == "main")
    assert main["title"] == "Rooks"
    splash = (REPO / "desktop" / "ui" / "index.html").read_text()
    assert "<title>Rooks</title>" in splash and "<h1>Rooks</h1>" in splash


def test_the_data_folder_and_binary_do_not_move():
    assert CONF["identifier"] == "com.inclined88888.aiworkspace"
    assert CONF["mainBinaryName"] == "ai-workspace-desktop"
    assert CONF["plugins"]["deep-link"]["desktop"]["schemes"] == ["aiworkspace"]
    launcher = (REPO / "desktop" / "launcher" / "ai_workspace.py").read_text()
    assert f'IDENT = "{CONF["identifier"]}"' in launcher
    sidecars = (TAURI / "src" / "sidecars.rs").read_text()
    assert "app_data_dir()" in sidecars  # keyed by the identifier, never by productName


def test_the_shell_says_rooks_to_people():
    strings = "\n".join((TAURI / "src" / f).read_text() for f in ("lib.rs", "updater.rs"))
    strings += (TAURI / "Info.plist").read_text()
    assert "AI Workspace" not in strings
    assert re.search(r"Rooks \{version\} is available", strings)


def test_the_palette_cannot_collide_with_the_app():
    pack = (REPO / "desktop" / "rooks-native" / "pack" / "macos-dmg.sh").read_text()
    assert "Rooks Ask.app" in pack
