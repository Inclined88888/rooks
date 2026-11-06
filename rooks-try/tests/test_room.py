"""The Room: private home, checkpoints, an honest shell driver, and a real nested desktop when Xvfb is present."""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from rooks_try import store
from rooks_try.drivers import pick
from rooks_try.room import TryRoom

XVFB = shutil.which("Xvfb")


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


def test_pick_prefers_nested_when_xvfb_exists(room_home, monkeypatch):
    monkeypatch.delenv("ROOKS_TRY_IMAGE", raising=False)
    driver = pick(prefer="auto")
    disk = store.root() / "guest.qcow2"
    if XVFB and not disk.exists():
        assert driver.name == "nested"
    elif not disk.exists():
        assert driver.name == "shell"  # a folder and a shell, never the drawn terminal


def test_auto_never_picks_the_drawing(room_home, monkeypatch):
    """The drawn terminal is a picture, not a screen. Only an explicit choice reaches it, and a saved one is not kept."""
    monkeypatch.delenv("ROOKS_TRY_IMAGE", raising=False)
    monkeypatch.setattr("rooks_try.drivers.qemu._qemu_bin", lambda: None)
    monkeypatch.setattr("rooks_try.drivers.nested.NestedDriver.available", lambda self: False)
    assert pick(prefer="auto").name == "shell"
    store.save_state({"driver": "display", "running": True})
    assert TryRoom(prefer="auto").driver().name != "display"
    assert pick(prefer="display").name == "display"  # still there for tests, by name only


def test_explicit_missing_driver_is_an_error(room_home, monkeypatch):
    monkeypatch.delenv("ROOKS_TRY_IMAGE", raising=False)
    monkeypatch.setattr("rooks_try.drivers.qemu._qemu_bin", lambda: None)
    with pytest.raises(RuntimeError):
        pick(prefer="qemu")


def test_restore_rejects_paths_outside_checkpoints(room_home):
    room = TryRoom(prefer="shell")
    room.up()
    room.run("echo safe > keep.txt")
    outside = room_home / "outside"
    outside.mkdir()
    (outside / "keep.txt").write_text("stolen")
    with pytest.raises(FileNotFoundError):
        room.reset("../outside")
    assert (store.guest_home() / "keep.txt").read_text().strip() == "safe"


def test_qemu_run_does_not_write_the_practice_folder(room_home):
    from rooks_try.drivers.qemu import QemuDriver

    driver = QemuDriver()
    result = driver.run("echo pwned > should-not-exist.txt")
    assert result["ok"] is False
    assert not (store.guest_home() / "should-not-exist.txt").exists()


def test_server_requires_a_key(monkeypatch):
    import rooks_try.server as server

    monkeypatch.setattr(server, "API_KEY", "")
    assert server.authorized("") is False
    monkeypatch.setattr(server, "API_KEY", "secret")
    assert server.authorized("Bearer secret") is True
    assert server.authorized("Bearer no") is False
    assert server.authorized("Bearer secret-but-longer") is False


def test_nested_typing_uses_the_character():
    text = Path(__file__).resolve().parents[1].joinpath("rooks_try/drivers/nested.py").read_text()
    body = text[text.index("def _xtest_char"):]
    assert "keysym_to_keycode" in body
    assert "else 24" not in body


@pytest.mark.skipif(not XVFB, reason="needs Xvfb")
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


@pytest.mark.skipif(not XVFB, reason="needs Xvfb")
def test_nested_screenshot_is_a_real_picture(room_home, monkeypatch):
    """A flat black frame is not a screen. A real desktop (a terminal, or a window manager) draws many colours."""
    from PIL import Image

    monkeypatch.setenv("ROOKS_TRY_DISPLAY", ":22")
    room = TryRoom(prefer="nested")
    try:
        st = room.up()
        assert st["running"] is True and st["screen"] is True and st["pointer"] is True
        colours = 0
        for _ in range(40):  # the terminal needs a moment to map its window
            path = room.screenshot()
            with Image.open(path) as img:
                found = img.convert("RGB").getcolors(maxcolors=1 << 20)
            colours = len(found or [])
            if colours > 1:
                break
            time.sleep(0.25)
        assert colours > 1, "the room's screen is one flat colour: nothing real is drawn on it"
    finally:
        room.down()


@pytest.mark.skipif(not XVFB, reason="needs Xvfb")
def test_nested_run_sees_the_room_display(room_home, monkeypatch):
    """A program started with run() appears in the room, not on the person's own screen."""
    monkeypatch.setenv("ROOKS_TRY_DISPLAY", ":23")
    monkeypatch.delenv("DISPLAY", raising=False)
    room = TryRoom(prefer="nested")
    try:
        room.up()
        result = room.run("echo display=$DISPLAY")
        assert result["ok"] is True
        assert "display=:23" in result["stdout"]
    finally:
        room.down()


def test_shell_status_is_honest(room_home):
    """No screen, no pointer, and the isolation it really has: a private mount namespace when unshare works, else none."""
    from rooks_try.drivers import shell as shell_mod

    room = TryRoom(prefer="shell")
    st = room.up()
    assert st["screen"] is False and st["pointer"] is False
    assert st["isolation"] in ("none", "namespace")
    assert st["isolation"] == ("namespace" if shell_mod.namespaces_available() else "none")
    assert st["label"] == "A private folder and shell"
    assert "Commands run as you" in st["note"]
    for bad in ("Xvfb", "unshare", "namespace", "driver"):
        assert bad not in st["label"] and bad not in st["note"], bad
    if st["isolation"] == "namespace":
        (store.guest_home() / "only-in-the-room.txt").write_text("here")
        real_home = Path.home()
        result = room.run(f"readlink /proc/self/ns/mnt; ls {real_home}")
        assert result["ok"] is True, result
        assert os.readlink("/proc/self/ns/mnt") not in result["stdout"]  # a mount namespace of its own
        if real_home.is_dir() and real_home != store.guest_home():
            assert "only-in-the-room.txt" in result["stdout"]  # the room's home sits over the person's home path
        assert result["isolation"] == "namespace"


def test_display_is_a_drawing_without_a_pointer(room_home):
    room = TryRoom(prefer="display")
    st = room.up()
    assert st["screen"] is True and st["pointer"] is False
    assert st["label"] == "A drawing of a terminal"
    assert room.click(80, 120).get("ok") is False
    assert room.drag(1, 1, 5, 5).get("ok") is False
    assert room.scroll(1, 1).get("ok") is False


def test_display_is_a_screen_you_can_type_on(room_home):
    room = TryRoom(prefer="display")
    st = room.up()
    assert st["running"] is True
    assert st["screen"] is True
    assert st["driver"] == "display"
    room.type_text("echo hi > seen.txt")
    room.key("Return")
    assert (store.guest_home() / "seen.txt").read_text().strip() == "hi"
    path = room.screenshot()
    assert path.exists() and path.stat().st_size > 500


def _call(base: str, method: str, path: str, body: dict | None = None, key: str = "secret-key"):
    data = json.dumps(body or {}).encode() if method == "POST" else None
    req = Request(base + path, data=data, method=method,
                  headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        with urlopen(req, timeout=10) as r:
            raw, code = r.read(), r.status
    except HTTPError as e:
        raw, code = e.read(), e.code
    try:
        return code, json.loads(raw)
    except ValueError:
        return code, raw


def test_server_has_drag_scroll_and_a_safe_key_check(room_home, monkeypatch):
    import rooks_try.server as server

    monkeypatch.setattr(server, "API_KEY", "secret-key")
    server.Handler.room = TryRoom(prefer="shell")
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    try:
        assert _call(base, "POST", "/api/up")[0] == 200
        code, body = _call(base, "POST", "/api/drag", {"x1": 1, "y1": 1, "x2": 9, "y2": 9})
        assert code == 200 and body["ok"] is False  # the route exists; a folder has no pointer
        code, body = _call(base, "POST", "/api/scroll", {"x": 1, "y": 1, "dy": -3})
        assert code == 200 and body["ok"] is False
        assert _call(base, "GET", "/api/screenshot")[0] == 404  # no screen, no picture
        assert _call(base, "GET", "/api/status", key="wrong")[0] == 401
    finally:
        httpd.shutdown()
    text = Path(server.__file__).read_text()
    assert "hmac.compare_digest" in text
    assert 'header == f"Bearer' not in text


def test_checkpoint_names_never_collide(room_home, monkeypatch):
    room = TryRoom(prefer="shell")
    room.up()
    monkeypatch.setattr(store.time, "strftime", lambda fmt, *a: "20261106T120000")
    room.run("echo one > mark.txt")
    first = room.checkpoint("twice")
    room.run("echo two > mark.txt")
    second = room.checkpoint("twice")
    assert first["name"] != second["name"]
    assert Path(first["path"]).is_dir() and Path(second["path"]).is_dir()
    assert (Path(first["path"]) / "mark.txt").read_text().strip() == "one"
    assert (Path(second["path"]) / "mark.txt").read_text().strip() == "two"
    names = [c["name"] for c in store.list_checkpoints()]
    assert names[0] == second["name"] and first["name"] in names


def test_checkpoints_are_capped(room_home, monkeypatch):
    room = TryRoom(prefer="shell")
    room.up()
    stamps = iter(f"20261106T1200{n:02d}" for n in range(60))
    monkeypatch.setattr(store.time, "strftime", lambda fmt, *a: next(stamps))
    metas = [room.checkpoint(f"p{n}") for n in range(store.MAX_CHECKPOINTS + 2)]
    made = [m["name"] for m in metas]
    kept = [c["name"] for c in store.list_checkpoints()]
    assert len(kept) == store.MAX_CHECKPOINTS
    assert set(kept) == set(made[2:])  # the two oldest went
    assert not (store.checkpoints_dir() / made[0]).exists()
    assert metas[-1]["removed"] == [made[1]]
    st = room.status()
    assert st["checkpoint_limit"] == store.MAX_CHECKPOINTS
    assert set(st["pruned"]["removed"]) >= {made[0], made[1]}


def test_shell_has_no_picture_and_says_so_plainly():
    text = Path(__file__).resolve().parents[1].joinpath("rooks_try/drivers/shell.py").read_text()
    start = text.index("def screenshot")
    body = text[start:text.index("\n    def click")]
    for bad in ("Try Room", "Xvfb", "QEMU", "shell mode", "Image.new"):
        assert bad not in body, bad


def test_drivers_are_described(room_home):
    info = TryRoom().drivers()
    names = {d["name"] for d in info}
    assert names == {"qemu", "nested", "display", "shell"}


def test_namespace_room_runs_when_its_home_sits_under_the_persons_home(tmp_path, monkeypatch):
    """The shipped layout: the Room's home is ~/.ai-workspace/try-room/home, under the person's home. Laying it over
    the person's home path must not hide the folder the command starts in."""
    from rooks_try.drivers import shell as shell_mod

    if not shell_mod.namespaces_available():
        pytest.skip("needs unshare -Urm")
    person = tmp_path / "person"
    person.mkdir()
    monkeypatch.setenv("HOME", str(person))
    monkeypatch.delenv("ROOKS_TRY_HOME", raising=False)
    room = TryRoom(prefer="shell")
    room.up()
    assert person in store.guest_home().parents
    result = room.run('echo RAN > made.txt; cd "$HOME" && ls made.txt')
    assert result["ok"] is True, result
    assert result["isolation"] == "namespace"
    assert (store.guest_home() / "made.txt").read_text().strip() == "RAN"
    assert not (person / "made.txt").exists()


def test_handoff_of_a_folder_never_copies_through_a_link_to_outside(room_home, tmp_path):
    room = TryRoom(prefer="shell")
    room.up()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "id_rsa").write_text("SECRET")
    out = store.guest_home() / "out"
    out.mkdir()
    (out / "notes.txt").symlink_to(outside / "id_rsa")
    dest = tmp_path / "dest"
    result = room.handoff("out", str(dest), approve=True)
    assert result["ok"] is False
    assert "outside the Room" in result["error"]
    copied = dest / "notes.txt"
    assert not copied.exists() or copied.is_symlink()
    assert "SECRET" not in (copied.read_text() if copied.exists() and not copied.is_symlink() else "")


def test_handoff_of_a_folder_keeps_links_inside_the_room_as_links(room_home, tmp_path):
    room = TryRoom(prefer="shell")
    room.up()
    out = store.guest_home() / "out"
    out.mkdir()
    (out / "a.txt").write_text("a")
    (out / "b.txt").symlink_to("a.txt")
    dest = tmp_path / "dest"
    assert room.handoff("out", str(dest), approve=True)["ok"] is True
    assert (dest / "a.txt").read_text() == "a" and (dest / "b.txt").is_symlink()


def test_down_never_adopts_a_saved_drawing_for_auto(room_home, monkeypatch):
    """A drawing left in state.json by an earlier explicit run is not what the next auto Start brings up."""
    monkeypatch.delenv("ROOKS_TRY_IMAGE", raising=False)
    monkeypatch.setattr("rooks_try.drivers.qemu._qemu_bin", lambda: None)
    monkeypatch.setattr("rooks_try.drivers.nested.NestedDriver.available", lambda self: False)
    store.save_state({"driver": "display", "running": False})
    room = TryRoom(prefer="auto")
    assert room.driver().name == "shell"
    room.down()
    assert room.driver().name == "shell"
    st = room.up()
    assert st["driver"] == "shell" and st["screen"] is False
    room.down()


def test_a_screenshot_never_starts_the_room(room_home):
    """Only up starts the Room: a picture asked of a Room that is off is refused, and the Room stays off."""
    from rooks_try.drivers.display import DisplayDriver
    from rooks_try.drivers.nested import NestedDriver

    for cls in (DisplayDriver, NestedDriver):
        driver = cls()
        started = []
        driver.up = lambda: started.append(1) or {}  # type: ignore[method-assign]
        with pytest.raises(RuntimeError, match="off"):
            driver.screenshot(room_home / "shot.png")
        assert started == [], cls.__name__
        assert driver.status()["running"] is False


def test_server_status_answers_while_a_command_runs(room_home, monkeypatch):
    """A long command holds the action lock; the status the app polls still answers at once."""
    import rooks_try.server as server

    monkeypatch.setattr(server, "API_KEY", "secret-key")
    server.Handler.room = TryRoom(prefer="shell")
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    try:
        assert _call(base, "POST", "/api/up")[0] == 200
        assert server.Handler.lock.acquire(timeout=5)  # what /api/run holds for the whole command
        try:
            started = time.monotonic()
            code, body = _call(base, "GET", "/api/status")
            assert code == 200 and body["running"] is True
            assert time.monotonic() - started < 5
        finally:
            server.Handler.lock.release()
    finally:
        httpd.shutdown()
