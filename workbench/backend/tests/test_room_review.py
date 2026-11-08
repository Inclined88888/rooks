"""The Room's review findings (design 0006): each test failed on the code before its fix.

Walls first: the programs that put the Room up come from this computer, never from the Room's own bin folders, and none
of the app's secrets go in. Then the terminals: a terminal closed while it opens leaves no shell; a started command is
one line, so its end is read right; a shell that exits with a job still running ends; what tail gives is plain text;
the logs are private; the chat reads only terminals Rooks started or was handed; a hidden answer is not in the run log;
a command cannot fake its own end; a stalled window does not grow without limit; a bad record is skipped; a terminal
that ends while a window attaches closes that window; a cut character shows once. And status says one count and why
there is no terminal, and Files says why a link cannot be opened.
"""

import asyncio
import json
import os
import re
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from starlette.websockets import WebSocketDisconnect

from test_room_terminal import (_gone, _open, _scrollback, _send, _tail, _ws, local, on, read_until,  # noqa: F401
                                room_home, wait_tail)

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX pseudo terminals only")
BINS = (".local/bin", "bin", ".cargo/bin")
APP_NAMES = ("NATIVE_SIGNIN_KEY", "CODING_BRIDGE_KEY", "WORKBENCH_DESKTOP_TOKEN", "DATABASE_URL", "DATA_DIR")


def _home() -> Path:
    from rooks_try import store

    return store.guest_home()


def _plant(home: Path, marker: Path) -> None:
    """unshare, setsid and sh in every Room bin folder: each notes that it ran (outside the Room), then hands over."""
    for folder in [home / b for b in BINS]:
        folder.mkdir(parents=True, exist_ok=True)
        for name in ("unshare", "setsid", "sh"):
            real = next((f"{d}/{name}" for d in ("/usr/bin", "/bin") if os.path.exists(f"{d}/{name}")), name)
            tool = folder / name
            tool.write_text(f'#!/bin/sh\necho "PLANTED $0" >> "{marker}"\nexec {real} "$@"\n')
            tool.chmod(0o755)


def _rows(since: int, action: str | None = None) -> list[dict]:
    from app import db

    rows = db.all("SELECT args, outcome, detail FROM actions WHERE id > ? AND channel = 'room' AND kind = 'tool_call' "
                  "ORDER BY id", since)
    out = [dict(r, args=json.loads(r["args"])) for r in rows]
    return [r for r in out if action is None or r["args"].get("action") == action]


def _since() -> int:
    from app import db

    return db.one("SELECT COALESCE(MAX(id), 0) AS m FROM actions")["m"]


def _ctx():
    from app import assistant

    return assistant.Ctx(channel="web", conversation_id=assistant.new_conversation("web"))


# --- 1: the wrappers ------------------------------------------------------------------------------------------------------
def test_the_wrappers_never_come_from_the_rooms_own_bins(client, on, tmp_path):
    from rooks_try.drivers import nested, shell

    home = _home()
    marker = tmp_path / "planted.log"
    _plant(home, marker)
    tid = _open(client)["id"]  # setsid -c unshare … sh … the person's login shell
    assert _send(client, tid, "echo up-$((1+1))").status_code == 200
    wait_tail(client, tid, lambda x: "up-2" in x["text"])
    ran = client.post("/api/room/run", json={"command": "echo hi"}).json()
    assert ran["code"] == 0 and ran["stdout"] == "hi\n", ran
    # The private desktop's terminal: xterm -e looks its program up on the desktop's PATH, as this does.
    env = shell.room_env(home)
    env["DISPLAY"] = ":0"
    subprocess.run(nested.NestedDriver().terminal_argv(home), env=env, cwd=str(home), input="exit\n",
                   capture_output=True, text=True, timeout=30)
    assert not marker.exists(), marker.read_text()


# --- 2: the app's secrets -------------------------------------------------------------------------------------------------
def test_rooks_try_keeps_every_name_the_app_keeps_from_a_shell():
    from rooks_try.drivers import shell

    from app import security, terminal_pty

    assert set(security.APP_SECRET_ENV) <= shell.APP_ONLY_ENV
    assert set(terminal_pty._APP_ONLY) <= shell.APP_ONLY_ENV
    assert shell.SECRET_ENV.pattern == terminal_pty._SECRET.pattern and shell.SECRET_ENV.flags == terminal_pty._SECRET.flags


def test_the_apps_secrets_never_reach_a_room_command_or_terminal(client, on, monkeypatch):
    for name in ("NATIVE_SIGNIN_KEY", "CODING_BRIDGE_KEY", "WORKBENCH_DESKTOP_TOKEN", "DATABASE_URL"):
        monkeypatch.setenv(name, f"{name.lower()}-should-not-leak")
    assert os.environ.get("DATA_DIR")  # set by the tests' app
    names = "|".join(APP_NAMES)
    ran = client.post("/api/room/run", json={"command": f"env | cut -d= -f1 | grep -cxE '{names}'"}).json()
    assert ran["stdout"].strip() == "0", ran
    tid = _open(client)["id"]
    _send(client, tid, f"echo \"count=$(env | cut -d= -f1 | grep -cxE '{names}')\"")
    text = wait_tail(client, tid, lambda x: re.search(r"count=\d", x["text"]))["text"]
    assert "count=0" in text, text[-300:]


# --- 3: closed while it opens ---------------------------------------------------------------------------------------------
def test_stop_while_a_terminal_opens_leaves_no_shell(client, on, monkeypatch):
    from fastapi import HTTPException
    from rooks_try import store

    from app import room, room_terminal

    real_seed, real_spawn, spawned = store.seed_home, room_terminal._spawn, []

    def slow_seed(home=None):
        time.sleep(1.0)
        return real_seed(home)

    def spy(t, *a, **k):
        spawned.append(t)
        return real_spawn(t, *a, **k)

    monkeypatch.setattr(store, "seed_home", slow_seed)
    monkeypatch.setattr(room_terminal, "_spawn", spy)

    async def both():
        opening = asyncio.create_task(room_terminal.open_terminal(owner="person"))
        await asyncio.sleep(0.3)
        down = await room.stop()
        try:
            await opening
        except HTTPException as e:
            return down, e
        return down, None

    down, err = asyncio.run(both())
    assert err is not None and err.status_code == 409 and err.detail == "This terminal has ended.", err
    for t in spawned:
        if t.proc is not None:
            assert _gone(t.proc.pid) or t.proc.poll() is not None, "a live shell was left behind"
        assert t.master is None
    assert not [t for t in room_terminal._registry().values() if t.alive]


# --- 4: one line ----------------------------------------------------------------------------------------------------------
def test_a_command_rooks_starts_is_one_line(client, on):
    from app import assistant, room_terminal

    r = client.post("/api/room/terminals", json={"command": "cd Desktop\nsleep 1; echo fin; false"})
    assert r.status_code == 400 and r.json()["detail"] == room_terminal.ONE_LINE, r.text
    assert client.get("/api/room/status").json()["terminals"] == []
    out = asyncio.run(assistant._use_room(action="start", command="cd Desktop\r\nfalse", ctx=_ctx()))
    assert out["ok"] is False and out["error"] == room_terminal.ONE_LINE


# --- 5: the shell exits with a job still holding the terminal -------------------------------------------------------------
def test_a_shell_that_exits_with_a_job_still_running_ends_the_terminal(client, on):
    tid = _open(client)["id"]
    assert _send(client, tid, "sleep 30 & echo job=$!; exit").status_code == 200
    t = wait_tail(client, tid, lambda x: not x["alive"], timeout=8)
    assert t["ended_reason"] == "exited" and t["busy"] is False, t
    job = re.search(r"job=(\d+)", t["text"])
    assert job and _gone(int(job.group(1))), t["text"][-300:]


# --- 6: plain text --------------------------------------------------------------------------------------------------------
def test_tail_is_plain_text(client, on):
    from app import assistant

    tid = _open(client)["id"]
    _send(client, tid, r"printf '\033]52;c;aGk=\007\033[31mred\033[0m\033]0;title\007\033(B\033[?1049h done-%s\r\n' $((1+1))")
    t = wait_tail(client, tid, lambda x: "done-2" in x["text"])
    for bad in ("\x1b", "\x07", "\x9b"):
        assert bad not in t["text"], (bad, t["text"][-300:])
    assert "\nred done-2\n" in t["text"], t["text"][-300:]  # the clipboard write and the title are gone, not printed
    client.post(f"/api/room/terminals/{tid}/take", json={"owner": "rooks"})
    seen = asyncio.run(assistant._use_room(action="tail", id=tid, ctx=_ctx()))
    assert "\x1b" not in seen["text"] and "done-2" in seen["text"]


# --- 8: private logs ------------------------------------------------------------------------------------------------------
def test_a_terminals_log_and_record_are_private(client, on):
    folder = on / "work" / "terminals"
    old = os.umask(0o022)
    try:
        if folder.exists():
            folder.chmod(0o755)  # a folder an earlier version made
        tid = _open(client)["id"]
        _send(client, tid, "echo kept-$((3+4))")
        wait_tail(client, tid, lambda x: "kept-7" in x["text"])
    finally:
        os.umask(old)
    assert stat.S_IMODE(folder.stat().st_mode) == 0o700
    for name in (f"{tid}.log", f"{tid}.json"):
        assert stat.S_IMODE((folder / name).stat().st_mode) == 0o600, name


# --- 9: the person's own terminal -----------------------------------------------------------------------------------------
def test_the_chat_does_not_read_a_terminal_the_person_opened(client, on):
    from app import assistant, room_terminal

    tid = _open(client)["id"]
    _send(client, tid, "echo private-$((2+3))")
    wait_tail(client, tid, lambda x: "private-5" in x["text"])
    out = asyncio.run(assistant._use_room(action="tail", id=tid, ctx=_ctx()))
    assert out["ok"] is False and out["error"] == room_terminal.THEIRS and "private-5" not in json.dumps(out), out
    assert client.post(f"/api/room/terminals/{tid}/take", json={"owner": "rooks"}).status_code == 200  # handed over
    out = asyncio.run(assistant._use_room(action="tail", id=tid, ctx=_ctx()))
    assert "private-5" in out["text"], out


# --- 10: the smaller ones -------------------------------------------------------------------------------------------------
def test_a_line_typed_at_a_hidden_prompt_is_not_in_the_run_log(client, on):
    tid = _open(client)["id"]
    since = _since()
    _send(client, tid, "read -s -p \"$(printf 'pw%s' 9): \" PW; echo \"got-${#PW}\"")
    wait_tail(client, tid, lambda x: "pw9:" in x["text"])
    time.sleep(0.3)
    _send(client, tid, "hunter2-hidden")
    wait_tail(client, tid, lambda x: "got-14" in x["text"])
    _send(client, tid, "echo shown-$((1+1))")
    wait_tail(client, tid, lambda x: "shown-2" in x["text"])
    rows = _rows(since, "send")
    assert "hunter2" not in json.dumps(rows), rows
    assert [r["args"]["text"] for r in rows] == ["read -s -p \"$(printf 'pw%s' 9): \" PW; echo \"got-${#PW}\"",
                                                 "(a line was sent, 14 characters)", "echo shown-$((1+1))"], rows


def test_files_never_lists_a_folder_swapped_for_a_link_after_the_check(client, on, tmp_path, monkeypatch):
    from fastapi import HTTPException

    from app import room_files

    home = _home()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("x")
    (home / "Desktop").mkdir(exist_ok=True)
    real_inside, swapped = room_files._inside, []

    def racing(path, root):
        ok = real_inside(path, root)
        if not swapped and Path(path).name == "Desktop":  # checked; now a Room program swaps it for a link
            swapped.append(True)
            (home / "Desktop").rename(home / "Desktop.old")
            (home / "Desktop").symlink_to(outside)
        return ok

    monkeypatch.setattr(room_files, "_inside", racing)
    with pytest.raises(HTTPException) as e:
        listed = room_files.listing("Desktop")
        pytest.fail(f"listed a folder outside the Room: {listed}")
    assert swapped and e.value.status_code == 400 and e.value.detail == room_files.OUTSIDE


def test_a_command_cannot_fake_its_own_end(client, on):
    since = _since()
    t = _open(client, command=r"printf '\033]7777;0\007\033]7777;0;0123456789abcdef0123456789abcdef\007'; sleep 1; false")
    done = wait_tail(client, t["id"], lambda x: not x["busy"] and x["exit_code"] is not None, timeout=20)
    time.sleep(0.3)
    done = _tail(client, t["id"])
    assert done["exit_code"] == 1, done
    rows = _rows(since, "done")
    assert [r["args"]["exit_code"] for r in rows] == [1], rows


def test_a_stalled_window_never_queues_without_limit(client, on, local, monkeypatch):
    from starlette.websockets import WebSocket

    from app import room_terminal

    tid = _open(client)["id"]
    t = room_terminal.get(tid)
    gate, sent = threading.Event(), []
    real = WebSocket.send_text

    async def stalled(self, data):
        if sent:  # the first frame goes; then the window stops reading (a backgrounded tab)
            while not gate.is_set():
                await asyncio.sleep(0.02)
        sent.append(True)
        await real(self, data)

    monkeypatch.setattr(WebSocket, "send_text", stalled)
    with _ws(client, tid) as ws:
        _scrollback(ws)
        deadline = time.monotonic() + 5
        while t.attached is None and time.monotonic() < deadline:
            time.sleep(0.02)
        for _ in range(64):  # 4 MiB of output
            room_terminal._emit(t, b"y" * 65536)
        room_terminal._emit(t, b"LAST")
        time.sleep(0.5)
        queued = sum(len(x) if isinstance(x, str) else len(str(x)) for x in list(t.attached[1]._queue))
        gate.set()
        assert queued <= 3 * room_terminal.RING_MAX, queued
        fresh = None
        for _ in range(50):  # what was on its way, then one fresh scrollback frame with the latest text
            frame = ws.receive_text()
            if frame.startswith('{"type": "scrollback"'):
                fresh = json.loads(frame)
                break
        assert fresh and fresh["data"].endswith("LAST") and len(fresh["data"]) <= room_terminal.RING_MAX, fresh and len(fresh["data"])


def test_a_bad_record_in_the_terminals_folder_is_skipped(client, on):
    from app import assistant, room_terminal

    tid = _open(client)["id"]
    folder = on / "work" / "terminals"
    (folder / "aaaaaaaa.json").write_text("[1, 2]")
    (folder / "bbbbbbbb.json").write_text(json.dumps({"id": "bbbbbbbb", "cols": "wide", "started_ts": "soon"}))
    (folder / "cccccccc.json").write_text("not json")
    room_terminal.reset_for_tests(restart=False)
    listed = client.get("/api/room/terminals")
    assert listed.status_code == 200, listed.text
    ids = [t["id"] for t in listed.json()["terminals"]]
    assert ids == [tid], ids
    assert asyncio.run(assistant._use_room(action="tail", id=tid, ctx=_ctx()))["ok"] is False  # the person's, refused


def test_a_terminal_that_ends_while_a_window_attaches_closes_that_window(client, on, local, monkeypatch):
    from starlette.websockets import WebSocket

    from app import room_terminal

    tid = _open(client)["id"]
    t = room_terminal.get(tid)
    real_accept = WebSocket.accept

    async def accept_then_end(self, *a, **k):
        await real_accept(self, *a, **k)
        if "/api/room/terminals/" in self.url.path:
            room_terminal._end_now(t, "closed")

    monkeypatch.setattr(WebSocket, "accept", accept_then_end)
    got: dict = {}
    with _ws(client, tid) as ws:
        assert _scrollback(ws)["alive"] is False

        def rx():
            try:
                ws.receive_text()
                got["frame"] = True
            except WebSocketDisconnect as e:
                got["code"] = e.code

        th = threading.Thread(target=rx, daemon=True)
        th.start()
        th.join(5)
        assert got.get("code") == 4409, got


def test_load_ended_says_how_many_the_restart_ended(client, on):
    from app import room_terminal

    _open(client)
    room_terminal.reset_for_tests()
    assert room_terminal.load_ended() == 1
    assert room_terminal.ended_at_restart() == 1


def test_a_character_cut_by_a_read_shows_once_on_reattach(client, on, local):
    from app import room_terminal

    tid = _open(client)["id"]
    t = room_terminal.get(tid)
    deadline = time.monotonic() + 5
    while t.prompts == 0 and time.monotonic() < deadline:
        time.sleep(0.05)
    time.sleep(0.3)
    cut = "xé".encode()
    room_terminal._emit(t, cut[:-1])
    with _ws(client, tid) as ws:
        data = _scrollback(ws)["data"]
        assert "�" not in data and data.endswith("x"), repr(data[-20:])
        room_terminal._emit(t, cut[-1:] + b"END")
        assert "éEND" in read_until(ws, "END")
    assert "�" not in _tail(client, tid)["text"]


def test_a_link_says_whether_it_leads_outside_or_nowhere(client, on):
    home = _home()
    (home / "Desktop").mkdir(exist_ok=True)
    (home / "out").symlink_to("/etc")
    (home / "gone").symlink_to(home / "nothing-here")
    (home / "in").symlink_to(home / "Desktop")
    entries = {e["name"]: e for e in client.get("/api/room/files").json()["entries"]}
    assert entries["out"]["kind"] == "link" and entries["out"]["why"] == "outside", entries["out"]
    assert entries["gone"]["kind"] == "link" and entries["gone"]["why"] == "broken", entries["gone"]
    assert entries["in"]["kind"] == "folder" and entries["in"].get("why") is None


def test_one_terminal_count_for_the_cap_and_the_words(client, on):
    from app import room_terminal

    first = _open(client)["id"]
    _send(client, first, "exit")
    wait_tail(client, first, lambda x: not x["alive"])
    for _ in range(3):
        _open(client)
    st = client.get("/api/room/status").json()
    assert st["terminal_count"] == 4 == len(st["terminals"]) and st["terminal_max"] == 4
    full = client.post("/api/room/terminals", json={})
    assert full.status_code == 429 and full.json()["detail"] == room_terminal.FULL
    assert "ended ones" in room_terminal.FULL


def test_status_says_why_there_is_no_terminal(client, on, monkeypatch):
    from rooks_try.room import TryRoom

    from app import db, room_files

    can = client.get("/api/room/status").json()["can"]
    assert can["terminal"] is True and can["terminal_off_reason"] is None
    try:
        assert client.put("/api/settings", json={"app_terminal": False}).status_code == 200
        can = client.get("/api/room/status").json()["can"]
        assert can["terminal"] is False and can["terminal_off_reason"] == "switched_off"
    finally:
        db.set_setting("app_terminal", "1")
    assert room_files.can(None, True)["terminal_off_reason"] == "helper"
    monkeypatch.setattr(sys, "platform", "win32")
    assert room_files.can(TryRoom(prefer="shell").driver(), False)["terminal_off_reason"] == "windows"
