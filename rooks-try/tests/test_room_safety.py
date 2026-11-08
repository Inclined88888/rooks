"""What runs before the Room's walls are up comes from the computer itself, and nothing secret goes in with it.

The Room's own bin folders (~/.local/bin, ~/bin, ~/.cargo/bin in the Room's home) are written by whatever runs in the
Room. The programs that put the walls up (unshare, setsid, sh) must never be looked up there, or a program an
installer dropped in ~/.local/bin would run on this computer before the Room's namespace exists. The Room's bins are
put first on the PATH only inside the Room's shell. And the app's own secrets never reach a Room command, its terminal
or its desktop.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from rooks_try import store
from rooks_try.drivers import shell as shell_mod
from rooks_try.room import TryRoom

POSIX = pytest.mark.skipif(sys.platform == "win32", reason="a POSIX shell")
BINS = (".local/bin", "bin", ".cargo/bin")
WRAPPERS = ("unshare", "setsid", "sh")
APP_SECRETS = {"NATIVE_SIGNIN_KEY": "native-should-not-leak", "CODING_BRIDGE_KEY": "bridge-should-not-leak",
               "WORKBENCH_DESKTOP_TOKEN": "desktop-should-not-leak", "DATABASE_URL": "sqlite:///db-should-not-leak",
               "DATA_DIR": "/data-should-not-leak", "STATIC_DIR": "/static-should-not-leak",
               "BRIDGE_API_KEY": "bridge2-should-not-leak", "SOME_CREDENTIALS": "creds-should-not-leak"}


@pytest.fixture()
def room_home(tmp_path, monkeypatch):
    monkeypatch.setenv("ROOKS_TRY_HOME", str(tmp_path / "try"))
    monkeypatch.setenv("SHELL", "/bin/bash" if os.path.exists("/bin/bash") else "/bin/sh")
    return tmp_path / "try"


def _plant(home: Path, marker: Path) -> None:
    """A program named like each wrapper in every Room bin folder (and in the Room's home itself, which a relative PATH
    entry would find): it notes that it ran, outside the Room, then hands over to the real one."""
    for folder in [home / b for b in BINS] + [home]:
        folder.mkdir(parents=True, exist_ok=True)
        for name in WRAPPERS:
            real = shutil.which(name, path="/usr/bin:/bin") or f"/bin/{name}"
            tool = folder / name
            tool.write_text(f'#!/bin/sh\necho "PLANTED $0" >> "{marker}"\nexec {real} "$@"\n')
            tool.chmod(0o755)


def _clean(marker: Path) -> None:
    assert not marker.exists(), marker.read_text()


def _inside(path: str, room: Path) -> bool:
    real, root = os.path.realpath(path), os.path.realpath(room)
    return real == root or real.startswith(root + os.sep)


@POSIX
@pytest.mark.parametrize("namespaces", [True, False])
def test_the_wrappers_never_come_from_the_rooms_own_bins(room_home, tmp_path, monkeypatch, namespaces):
    if namespaces and not shell_mod.namespaces_available():
        pytest.skip("needs unshare -Urm")
    monkeypatch.setattr(shell_mod, "_NAMESPACES", namespaces)
    marker = tmp_path / "planted.log"
    driver = shell_mod.ShellDriver()
    driver.up()
    home = store.guest_home()
    _plant(home, marker)
    # A PATH with an empty entry (the folder a command starts in, which is the Room's home) is looked up too.
    monkeypatch.setenv("PATH", os.pathsep + os.environ.get("PATH", "/usr/bin:/bin"))

    out = driver.run("echo hi")
    assert out["code"] == 0 and out["stdout"] == "hi\n", out
    _clean(marker)

    for argv in (shell_mod.login_argv(home), shell_mod.run_argv("true", home)):
        assert os.path.isabs(argv[0]) and not _inside(argv[0], room_home), argv
    env = shell_mod.room_env(home)
    assert not [p for p in env["PATH"].split(os.pathsep) if not p or _inside(p, room_home)], env["PATH"]

    # The Room's login shell, as the app's terminal, the private desktop's terminal (xterm -e) and /room shell start it:
    # the program is looked up on the env's PATH. Inside, the Room's bins come first.
    shell = subprocess.run(shell_mod.login_argv(home), env=env, cwd=str(home), input='echo "first=${PATH%%:*}"; exit\n',
                           capture_output=True, text=True, timeout=30)
    _clean(marker)
    assert "first=" in shell.stdout and shell.stdout.split("first=")[1].split()[0].endswith("/.local/bin"), shell


@POSIX
def test_a_quick_command_is_posix_sh_whatever_the_persons_login_shell(room_home, tmp_path, monkeypatch):
    """fish or tcsh as the login shell must not change what a quick command means: run is sh, as the result says."""
    odd = tmp_path / "oddshell"
    odd.write_text("#!/bin/sh\necho wrong-shell\nexit 3\n")
    odd.chmod(0o755)
    monkeypatch.setenv("SHELL", str(odd))
    driver = shell_mod.ShellDriver()
    driver.up()
    out = driver.run('X=1; export X; echo "$((X+1))"')
    assert out["code"] == 0 and out["stdout"] == "2\n" and out["shell"] == "sh", out
    # The terminal keeps the person's own login shell.
    assert any("SHELL" in a and "-l" in a for a in shell_mod.login_argv(store.guest_home()))


def test_a_profile_seeded_before_the_marker_nonce_is_brought_up_to_date(room_home):
    """The exit code marker carries the terminal's own nonce, so a command cannot print one. A Room seeded by an earlier
    version gets the new profile when it is still word for word what was seeded; a profile the person changed is kept."""
    home = store.guest_home()
    old = ('# Rooks put this here so tools you install in the Room are found. Edit it as you like.\n'
           'PATH="$HOME/.local/bin:$HOME/bin:$HOME/.cargo/bin:$PATH"; export PATH\n'
           'if [ -n "$BASH_VERSION" ] && [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi\n'
           'if [ -n "$BASH_VERSION" ]; then PROMPT_COMMAND=\'printf "\\033]7777;%s\\007" "$?"\'"${PROMPT_COMMAND:+;$PROMPT_COMMAND}"; fi\n')
    (home / ".profile").write_text(old)
    (home / ".zprofile").write_text("# mine\n")
    store.seed_home(home)
    assert (home / ".profile").read_text() == store.PROFILE and "ROOKS_MARK" in store.PROFILE
    assert (home / ".zprofile").read_text() == "# mine\n"


@POSIX
def test_the_marker_nonce_is_not_seen_by_what_the_shell_starts(room_home):
    """bash -l with ROOKS_MARK set: the marker carries it, a child process does not see it."""
    if not os.path.exists("/bin/bash"):
        pytest.skip("needs bash")
    home = store.guest_home()
    store.seed_home(home)
    env = {**shell_mod.room_env(home), "ROOKS_MARK": "abc123", "SHELL": "/bin/bash"}
    out = subprocess.run(["/bin/bash", "-lc", 'env | grep -c ROOKS_MARK; eval "$PROMPT_COMMAND"'], env=env,
                         cwd=str(home), capture_output=True, text=True, timeout=30)
    # grep -c found nothing (0, exit code 1): the marker says code 1 and carries the nonce
    assert out.stdout.startswith("0\n") and "\x1b]7777;1;abc123\x07" in out.stdout, repr(out.stdout)


def test_room_env_drops_every_app_secret(room_home):
    home = store.guest_home()
    env = shell_mod.room_env(home, False, base={"PATH": "/usr/bin", "LANG": "C", **APP_SECRETS})
    assert not set(APP_SECRETS) & set(env), sorted(set(APP_SECRETS) & set(env))
    assert env["LANG"] == "C"


@POSIX
def test_a_quick_command_never_sees_the_apps_secrets(room_home, monkeypatch):
    for k, v in APP_SECRETS.items():
        monkeypatch.setenv(k, v)
    driver = shell_mod.ShellDriver()
    driver.up()
    out = driver.run("env")
    assert out["code"] == 0, out
    assert "should-not-leak" not in out["stdout"], [ln for ln in out["stdout"].splitlines() if "leak" in ln]


@pytest.mark.skipif(not shutil.which("Xvfb"), reason="needs Xvfb")
def test_the_private_desktop_never_sees_the_apps_secrets_or_the_rooms_bins_first(room_home, monkeypatch):
    for k, v in APP_SECRETS.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("ROOKS_TRY_DISPLAY", ":29")
    room = TryRoom(prefer="nested")
    try:
        room.up()
        env = room.driver()._env
        assert env and not set(APP_SECRETS) & set(env), sorted(set(APP_SECRETS) & set(env))
        assert not [p for p in env["PATH"].split(os.pathsep) if _inside(p, room_home)], env["PATH"]
        assert "should-not-leak" not in room.run("env")["stdout"]
    finally:
        room.down()
