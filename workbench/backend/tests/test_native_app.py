"""Rooks as its own program (docs/design/0007-room-browser-and-native-app.md, part 2).

The installer installs the native app by default and picks only a real app release at or above this install's version;
the launcher opens the native app when it is there, finds it under the old and the new name, and never opens a Chrome
window that nobody chose: with no app and no answer it asks (in the terminal, or on the page when there is no terminal).
The data folder stays where it was: the identifier does not change with the name.
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
VERSION = (ROOT / "VERSION").read_text().strip()


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(path.parent))
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.path.remove(str(path.parent))
    return mod


launcher = _load("rooks_launcher_native", ROOT / "desktop" / "launcher" / "ai_workspace.py")
helper = _load("rooks_install_helper_native", ROOT / "desktop" / "launcher" / "install_helper.py")
TAURI = json.loads((ROOT / "desktop" / "src-tauri" / "tauri.conf.json").read_text())

QUESTION = "There is no Rooks app for this computer yet. Open Rooks in a Chrome or Edge window, or in your usual browser?"


# ---- the installer -------------------------------------------------------------------------------------------------

def test_installer_installs_the_native_app_by_default(monkeypatch):
    monkeypatch.delenv("AI_WORKSPACE_NATIVE", raising=False)
    a = helper.build_parser().parse_args(["--src", "."])
    assert a.native == "auto"


def test_install_scripts_say_auto_is_the_default():
    sh = (ROOT / "install.sh").read_text()
    ps = (ROOT / "install.ps1").read_text()
    assert "--native auto|yes|no" in sh and "default auto" in sh and "default no" not in sh
    assert "default auto" in ps and "default no" not in ps
    assert "else { 'auto' }" in ps


def _rel(tag, *names, draft=False):
    return {"tag_name": tag, "draft": draft,
            "assets": [{"name": n, "browser_download_url": f"https://example.invalid/{tag}/{n}"} for n in names]}


def test_native_asset_skips_the_palette_and_older_releases():
    releases = [
        _rel("rooks-native-v0.3.0", "Rooks_0.3.0_aarch64.dmg"),  # the Ask palette, not the app
        _rel("v1.0.5", "AI Workspace_1.0.5_aarch64.dmg"),         # older than this install
        _rel("v9.9.9", "Rooks_9.9.9_aarch64.dmg", draft=True),     # not published
    ]
    assert helper.pick_native_asset(releases, "1.0.6", "darwin", "arm64") is None
    releases.insert(0, _rel("v1.0.7", "Rooks_1.0.7_aarch64.dmg", "Rooks_1.0.7_x64.dmg", "Rooks_1.0.7_x64-setup.exe",
                            "Rooks_1.0.7_amd64.AppImage", "Rooks_1.0.7_amd64.deb"))
    assert helper.pick_native_asset(releases, "1.0.6", "darwin", "arm64")[0] == "Rooks_1.0.7_aarch64.dmg"
    assert helper.pick_native_asset(releases, "1.0.6", "darwin", "x86_64")[0] == "Rooks_1.0.7_x64.dmg"
    assert helper.pick_native_asset(releases, "1.0.6", "win32", "amd64")[0] == "Rooks_1.0.7_x64-setup.exe"
    assert helper.pick_native_asset(releases, "1.0.6", "linux", "x86_64")[0] == "Rooks_1.0.7_amd64.AppImage"
    assert helper.pick_native_asset(releases, "1.0.6", "linux", "aarch64") is None  # no Arm Linux build


def test_native_asset_takes_desktop_tags_and_the_same_version():
    releases = [_rel("desktop-v1.0.6", "Rooks_1.0.6_aarch64.dmg")]
    assert helper.pick_native_asset(releases, "1.0.6", "darwin", "arm64")[0] == "Rooks_1.0.6_aarch64.dmg"
    assert helper.pick_native_asset([_rel("nightly", "Rooks_1.0.9_aarch64.dmg")], "1.0.6", "darwin", "arm64") is None


def test_installer_asks_once_and_never_picks_a_window_on_its_own():
    asked = []

    def answer(text):
        asked.append(text)
        return ""

    assert helper.ask_shell(have_window=True, interactive=False, ask=answer) is None  # no terminal: no silent choice
    assert asked == []
    assert helper.ask_shell(have_window=True, interactive=True, ask=answer) == "window"  # Enter takes the first
    assert QUESTION in asked[0]
    assert helper.ask_shell(have_window=True, interactive=True, ask=lambda t: "2") == "browser"
    assert helper.ask_shell(have_window=False, interactive=True, ask=answer) == "browser"  # nothing to choose
    assert len(asked) == 1


def test_installer_names_and_finds_both_old_and_new_apps(tmp_path, monkeypatch):
    assert helper.NAME == "Rooks"
    assert "AI Workspace" in helper.OLD_NAMES
    monkeypatch.setattr(helper, "MAC", False)
    monkeypatch.setattr(helper, "WIN", False)
    monkeypatch.setattr(helper.Path, "home", lambda: tmp_path)
    paths = [str(p) for p in helper.desktop_app_paths()]
    assert any(p.endswith("Rooks.AppImage") for p in paths) and any(p.endswith("AI-Workspace.AppImage") for p in paths)


# ---- the launcher --------------------------------------------------------------------------------------------------

def test_launcher_is_named_rooks_and_keeps_the_data_folder(monkeypatch, tmp_path):
    assert launcher.NAME == "Rooks"
    assert launcher.IDENT == "com.inclined88888.aiworkspace" == TAURI["identifier"]
    monkeypatch.delenv("AI_WORKSPACE_DATA_DIR", raising=False)
    monkeypatch.setattr(launcher.sys, "platform", "linux")
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    # Tauri 2's app_data_dir() is the system data folder joined with the identifier, not the product name
    assert launcher.data_dir() == tmp_path / TAURI["identifier"]


@pytest.mark.parametrize("name", ["Rooks", "AI Workspace"])
def test_launcher_finds_the_mac_app_under_either_name(tmp_path, monkeypatch, name):
    monkeypatch.setattr(launcher.sys, "platform", "darwin")
    monkeypatch.setattr(launcher.Path, "home", lambda: tmp_path)
    if any((Path("/Applications") / f"{n}.app").exists() for n in ("Rooks", "AI Workspace")):
        pytest.skip("this Mac has a real app installed")
    macos = tmp_path / "Applications" / f"{name}.app" / "Contents" / "MacOS"
    macos.mkdir(parents=True)
    (macos / "ai-workspace-desktop").write_text("")
    assert launcher.native_app() == ["open", "-a", str(tmp_path / "Applications" / f"{name}.app")]


@pytest.mark.parametrize("file", ["Rooks.AppImage", "AI-Workspace.AppImage"])
def test_launcher_finds_the_linux_app_under_either_name(tmp_path, monkeypatch, file):
    monkeypatch.setattr(launcher.sys, "platform", "linux")
    monkeypatch.setattr(launcher.Path, "home", lambda: tmp_path)
    monkeypatch.delenv("AI_WORKSPACE_NO_NATIVE", raising=False)
    p = tmp_path / ".ai-workspace" / "bin" / file
    p.parent.mkdir(parents=True)
    p.write_text("#!/bin/sh\n")
    p.chmod(0o755)
    found = launcher.native_app()
    assert found == [str(p)] or (found and found[0] == "/usr/bin/ai-workspace-desktop")


def test_launcher_opens_the_native_app_when_it_is_there():
    plan = launcher.open_plan(native=["open", "-a", "/Applications/Rooks.app"], choice=None, interactive=False,
                              have_window=True, web=False)
    assert plan["how"] == "native"


def test_no_app_and_no_answer_asks_and_never_opens_a_chrome_window():
    plan = launcher.open_plan(native=None, choice=None, interactive=True, have_window=True, web=False)
    assert plan["how"] == "ask" and plan["say"] == QUESTION
    # From the Dock or the Start menu there is no terminal: the usual browser opens and the page asks
    plan = launcher.open_plan(native=None, choice=None, interactive=False, have_window=True, web=False)
    assert plan["how"] == "browser" and plan["shell"] == "ask"


def test_a_chosen_window_says_so_every_time():
    plan = launcher.open_plan(native=None, choice="window", interactive=False, have_window=True, web=False)
    assert plan["how"] == "window" and plan["shell"] == "window"
    assert "There is no Rooks app for this computer yet" in plan["say"] and "Chrome or Edge window" in plan["say"]
    plan = launcher.open_plan(native=None, choice="browser", interactive=False, have_window=True, web=False)
    assert plan["how"] == "browser" and plan.get("shell") is None
    # chose a window, but Chrome and Edge are gone: the usual browser, and it says why
    plan = launcher.open_plan(native=None, choice="window", interactive=False, have_window=False, web=False)
    assert plan["how"] == "browser" and "no Chrome or Edge" in plan["say"]
    # --web is the person's own choice for this launch
    assert launcher.open_plan(native=["x"], choice=None, interactive=False, have_window=True, web=True)["how"] == "window"


def test_the_terminal_answer_is_kept_in_install_json(tmp_path, monkeypatch):
    monkeypatch.setenv("AI_WORKSPACE_HOME", str(tmp_path))
    (tmp_path / "install.json").write_text(json.dumps({"channel": "edge", "app": "/x"}))
    launcher.save_shell_choice("browser")
    rec = json.loads((tmp_path / "install.json").read_text())
    assert rec == {"channel": "edge", "app": "/x", "shell": "browser"}
    assert launcher.shell_choice() == "browser"
    with pytest.raises(ValueError):
        launcher.save_shell_choice("chrome")


def test_handoff_link_carries_the_shell_word(monkeypatch):
    class R:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b'{"code": "C1"}'

    monkeypatch.setattr(launcher.urllib.request, "urlopen", lambda *a, **k: R())
    assert launcher.handoff_url("http://127.0.0.1:9", "T", shell="window").endswith("?code=C1&shell=window")
    assert launcher.handoff_url("http://127.0.0.1:9", "T").endswith("?code=C1")


def test_status_says_how_rooks_opens(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("AI_WORKSPACE_HOME", str(tmp_path))
    monkeypatch.setenv("AI_WORKSPACE_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(launcher, "installed_native", lambda: None)
    monkeypatch.setattr(launcher.updates, "check", lambda current: {"available": False})
    launcher.main(["--status"])
    out = capsys.readouterr().out
    assert "opens in: not chosen yet" in out
    launcher.save_shell_choice("window")
    launcher.main(["--status"])
    assert "opens in: a Chrome or Edge window" in capsys.readouterr().out


def test_the_mac_shortcut_does_not_force_a_window():
    src = (ROOT / "desktop" / "launcher" / "install_helper.py").read_text()
    assert '--web\\n' not in src  # the Applications shortcut used to pass --web: a Chrome window nobody chose
