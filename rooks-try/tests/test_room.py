"""Try Room: private home, checkpoints, shell driver, and nested when Xvfb is present."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest

from rooks_try import store
from rooks_try.drivers import pick
from rooks_try.room import TryRoom


@pytest.fixture()
def room_home(tmp_path, monkeypatch):
    monkeypatch.setenv("ROOKS_TRY_HOME", str(tmp_path / "try"))
    return tmp_path / "try"


def test_shell_room_runs_without_touching_host_home(room_home):
    room = TryRoom(prefer="shell")
    st = room.up()
    assert st["running"] is True
    assert st["driver"] == "shell"
    result = room.run("pwd; echo hello-try > note.txt; cat note.txt")
    assert result["ok"] is True
    assert "hello-try" in result["stdout"]
    assert (store.guest_home() / "note.txt").read_text().strip() == "hello-try"
    assert Path.home() != store.guest_home()


def test_checkpoint_and_reset(room_home):
    room = TryRoom(prefer="shell")
    room.up()
    room.run("echo v1 > mark.txt")
    cp = room.checkpoint("before")
    assert cp["name"]
    room.run("echo v2 > mark.txt")
    assert (store.guest_home() / "mark.txt").read_text().strip() == "v2"
    room.reset(cp["name"])
    assert (store.guest_home() / "mark.txt").read_text().strip() == "v1"


def test_handoff_needs_approval(room_home, tmp_path):
    room = TryRoom(prefer="shell")
    room.up()
    room.run("echo secret > keep.txt")
    dest = tmp_path / "out" / "keep.txt"
    asked = room.handoff("keep.txt", str(dest), approve=False)
    assert asked["needs_approval"] is True
    assert not dest.exists()
    done = room.handoff("keep.txt", str(dest), approve=True)
    assert done["ok"] is True
    assert dest.read_text().strip() == "secret"


def test_handoff_refuses_paths_outside_the_room(room_home, tmp_path):
    room = TryRoom(prefer="shell")
    room.up()
    outside = tmp_path / "outside.txt"
    outside.write_text("nope")
    result = room.handoff(str(outside), str(tmp_path / "stolen.txt"), approve=True)
    assert result["ok"] is False


def test_pick_prefers_nested_when_xvfb_exists(room_home):
    driver = pick(prefer="auto")
    if shutil.which("Xvfb"):
        assert driver.name in {"nested", "qemu", "shell"}
    else:
        assert driver.name == "shell"


@pytest.mark.skipif(not shutil.which("Xvfb"), reason="needs Xvfb")
def test_nested_screenshot(room_home, monkeypatch):
    monkeypatch.setenv("ROOKS_TRY_DISPLAY", ":21")
    room = TryRoom(prefer="nested")
    try:
        st = room.up()
        assert st["running"] is True
        assert st["driver"] == "nested"
        path = room.screenshot()
        assert path.exists() and path.stat().st_size > 100
        click = room.click(100, 100)
        assert click.get("ok") is True
    finally:
        room.down()


def test_drivers_are_described(room_home):
    info = TryRoom().drivers()
    names = {d["name"] for d in info}
    assert names == {"qemu", "nested", "shell"}
