"""The Room's terminals on Windows (design 0011, sections 1 and 5.2): the same keepers as on POSIX.

PowerShell (and Git Bash when Git for Windows is there) on a real pseudo console, through the app's real routes and
WebSocket: typing, detaching and attaching again with the scrollback, the exit code in the row, the cap, closing with
129, a program the shell started ending with it, the restart record, and the run log keeping only the length of each
line sent (the console's echo mode cannot be read from outside). The app's own terminal is PowerShell too.

These run on the windows-2022 runner ("Windows: Room terminals" in ci.yml); elsewhere they skip, and the POSIX
behaviour is tests/test_room_terminal.py's. TestClient's peer is not loopback, so the socket tests allow it the way
the POSIX tests do.
"""

import json
import os
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3] / "rooks-try"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

pytestmark = pytest.mark.skipif(os.name != "nt", reason="a real Windows pseudo console (the windows-2022 job)")
ORIGIN = {"origin": "http://testserver"}


@pytest.fixture()
def room_home(client, tmp_path, monkeypatch):
    from app import config, room, room_terminal

    monkeypatch.setenv("ROOKS_TRY_HOME", str(tmp_path / "try"))
    monkeypatch.setenv("ROOKS_TRY_DRIVER", "shell")
    monkeypatch.delenv("ROOKS_TRY_OFFLINE", raising=False)
    monkeypatch.setattr(config, "TRY_URL", "")
    monkeypatch.setattr(config, "TRY_API_KEY", "")
    room.reset()
    room_terminal.reset_for_tests(restart=False)
    yield tmp_path / "try"
    room_terminal.reset_for_tests(restart=False)
    client.post("/api/room/down")
    room.reset()


@pytest.fixture()
def local(monkeypatch):
    from app import terminal_pty

    monkeypatch.setattr(terminal_pty, "_is_local", lambda ws: True)
    return terminal_pty


@pytest.fixture()
def on(client, room_home):
    assert client.post("/api/room/up").json()["running"] is True
    return room_home


def _open(client, **body) -> dict:
    r = client.post("/api/room/terminals", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _ws(client, tid: str):
    return client.websocket_connect(f"/api/room/terminals/{tid}/ws", headers=ORIGIN)


def _type(ws, text: str) -> None:
    ws.send_text(json.dumps({"type": "input", "data": text}))


def read_until(ws, needle: str, limit: int = 2000) -> str:
    seen = ""
    for _ in range(limit):
        seen += ws.receive_text()
        if needle in seen:
            return seen
    raise AssertionError(f"never saw {needle!r} in {seen[-800:]!r}")


def _tail(client, tid: str) -> dict:
    r = client.get(f"/api/room/terminals/{tid}/tail", params={"lines": 400})
    assert r.status_code == 200, r.text
    return r.json()


def wait_tail(client, tid: str, until, timeout: float = 45.0) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        t = _tail(client, tid)
        if until(t):
            return t
        if time.monotonic() > deadline:
            raise AssertionError(f"the tail never got there: {t}")
        time.sleep(0.2)


def _send(client, tid: str, text: str):
    r = client.post(f"/api/room/terminals/{tid}/send", json={"text": text, "enter": True})
    assert r.status_code == 200, r.text


def _rows(since: int, action: str | None = None) -> list[dict]:
    from app import db

    rows = db.all("SELECT args, outcome, detail FROM actions WHERE id > ? AND channel = 'room' AND kind = 'tool_call' "
                  "ORDER BY id", since)
    out = [dict(r, args=json.loads(r["args"])) for r in rows]
    return [r for r in out if action is None or r["args"].get("action") == action]


def _since() -> int:
    from app import db

    return db.one("SELECT COALESCE(MAX(id), 0) AS m FROM actions")["m"]


def _gone(pids, timeout: float = 10.0) -> bool:
    from rooks_try import winproc

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not any(winproc.alive(p) for p in pids):
            return True
        time.sleep(0.1)
    return False


def test_status_offers_terminals_on_windows_powershell_first(client, on):
    can = client.get("/api/room/status").json()["can"]
    assert can["terminal"] is True and can["terminal_off_reason"] is None, can
    assert can["terminal_shells"][0] == "powershell", can
    st = client.get("/api/terminal/status").json()
    assert st["enabled"] is True and st["platform"] == "win32"


def test_a_powershell_terminal_outlives_its_socket_and_replays_its_text(client, on, local):
    from app import room_terminal

    t = _open(client)
    assert t["name"] == "Terminal 1" and t["shell_kind"] == "powershell"
    with _ws(client, t["id"]) as ws:
        first = json.loads(ws.receive_text())
        assert first["type"] == "scrollback" and first["alive"] is True
        _type(ws, "Set-Location Desktop; $env:K = '1'; Write-Output ('marker-' + (20+22))\r")
        read_until(ws, "marker-42")
    row = {x["id"]: x for x in client.get("/api/room/status").json()["terminals"]}[t["id"]]
    assert row["alive"] is True and row["shell_kind"] == "powershell"  # the socket closed; the shell did not
    with _ws(client, t["id"]) as ws:
        again = json.loads(ws.receive_text())
        assert again["type"] == "scrollback" and "marker-42" in again["data"] and "7777" not in again["data"]
        _type(ws, "Write-Output ('at-' + (Split-Path -Leaf (Get-Location)) + '-k' + $env:K)\r")
        read_until(ws, "at-Desktop-k1")  # the same shell: its folder and variables kept
    term = room_terminal.get(t["id"])
    assert term.win is not None and term.win.job.contains(term.proc.handle)
    assert term.channel in ("in-band", "pipe")


def test_the_exit_code_shows_in_the_row_and_close_gives_129(client, on):
    tid = _open(client)["id"]
    _send(client, tid, "cmd /c exit 5")
    done = wait_tail(client, tid, lambda x: x["exit_code"] == 5 and not x["busy"])
    assert done["alive"] is True
    _send(client, tid, "Write-Output ('fine-' + 1)")
    wait_tail(client, tid, lambda x: "fine-1" in x["text"] and x["exit_code"] == 0)
    r = client.delete(f"/api/room/terminals/{tid}")
    assert r.status_code == 200 and r.json()["exit_code"] == 129 and r.json()["closed"] is True


def test_busy_while_a_program_runs_and_it_ends_with_the_terminal(client, on):
    from app import room_terminal

    tid = _open(client)["id"]
    wait_tail(client, tid, lambda x: "PS " in x["text"])
    _send(client, tid, os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "PING.EXE") +
          " -n 999 127.0.0.1")
    wait_tail(client, tid, lambda x: x["busy"] is True)
    term = room_terminal.get(tid)
    pids = [p for p in term.win.pids() if p != term.proc.pid]
    assert pids, "ping is in the terminal's job"
    assert client.delete(f"/api/room/terminals/{tid}").json()["exit_code"] == 129
    assert _gone(pids), "a program outlived its terminal"


def test_a_command_rooks_starts_ends_with_its_code(client, on):
    out = _open(client, command="Start-Sleep -Seconds 2; Write-Output ('slow-' + 1)", shell="powershell")
    assert out["owner"] == "rooks" and out["shell_kind"] == "powershell"
    done = wait_tail(client, out["id"], lambda x: "slow-1" in x["text"] and not x["busy"] and x["exit_code"] is not None)
    assert done["exit_code"] == 0 and done["elapsed_s"] >= 2
    fail = _open(client, command="cmd /c exit 7", shell="powershell")
    assert fail["id"] == out["id"]  # Rooks's idle terminal is reused
    done = wait_tail(client, out["id"], lambda x: not x["busy"] and x["exit_code"] == 7)


def test_the_run_log_keeps_only_the_length_of_a_line_sent(client, on):
    tid = _open(client)["id"]
    since = _since()
    secret_ish = "Write-Output ('typed-' + 'here')"
    _send(client, tid, secret_ish)
    wait_tail(client, tid, lambda x: "typed-here" in x["text"])
    rows = _rows(since, "send")
    assert [r["args"]["text"] for r in rows] == [f"(a line was sent, {len(secret_ish)} characters)"], rows
    assert "typed-" not in json.dumps(rows)


def test_the_cap_and_the_restart_record_are_the_same_as_on_posix(client, on):
    from app import room_terminal

    ids = [_open(client)["id"] for _ in range(4)]
    r = client.post("/api/room/terminals", json={})
    assert r.status_code == 429 and r.json()["detail"] == room_terminal.FULL
    live = [room_terminal.get(i) for i in ids]
    pids = [t.proc.pid for t in live]
    room_terminal.reset_for_tests(restart=True)  # what the app's exit does: hang up, record "restart"
    assert _gone(pids)
    assert room_terminal.load_ended() == 4
    terms = {t["id"]: t for t in client.get("/api/room/status").json()["terminals"]}
    assert set(ids) <= set(terms) and all(terms[i]["ended_reason"] == "restart" for i in ids)


def test_stop_closes_every_terminal(client, on):
    from app import room_terminal

    tid = _open(client)["id"]
    pid = room_terminal.get(tid).proc.pid
    out = client.post("/api/room/down").json()
    assert out["terminals_closed"] == 1
    assert _gone([pid])
    row = {t["id"]: t for t in client.get("/api/room/status").json()["terminals"]}[tid]
    assert row["alive"] is False and row["ended_reason"] == "stop" and row["exit_code"] == 129


def test_a_git_bash_terminal_when_git_for_windows_is_there(client, on):
    from rooks_try.drivers.shell import windows_sh

    if not windows_sh():
        r = client.post("/api/room/terminals", json={"shell": "bash"})
        assert r.status_code == 409 and "Git for Windows" in r.json()["detail"]
        pytest.skip("no Git for Windows here")
    assert "bash" in client.get("/api/room/status").json()["can"]["terminal_shells"]
    t = _open(client, shell="bash")
    assert t["shell_kind"] == "bash"
    _send(client, t["id"], "false")
    wait_tail(client, t["id"], lambda x: x["exit_code"] == 1 and not x["busy"], timeout=60)
    _send(client, t["id"], "echo bash-$((40+2))")
    wait_tail(client, t["id"], lambda x: "bash-42" in x["text"] and x["exit_code"] == 0)
    rooks = _open(client, command="echo started-$((1+1))")
    assert rooks["shell_kind"] == "bash"  # Rooks's terminals use Git Bash when it is there, as a quick command does
    wait_tail(client, rooks["id"], lambda x: "started-2" in x["text"] and x["exit_code"] == 0, timeout=60)


def test_the_apps_own_terminal_is_powershell_and_ends_with_the_tab(client, local):
    from rooks_try import winproc

    with client.websocket_connect("/api/terminal/ws", headers=ORIGIN) as ws:
        ws.send_text(json.dumps({"type": "resize", "cols": 100, "rows": 30}))
        ws.send_text(json.dumps({"type": "input", "data": "Write-Output ('sum-' + (40+2) + '-' + "
                                                          "$Host.UI.RawUI.WindowSize.Width)\r"}))
        read_until(ws, "sum-42-100")
        assert local._open
        pid = next(iter(local._open))
    for _ in range(50):
        if not local._open:
            break
        time.sleep(0.1)
    assert not local._open and _gone([pid])
    assert not winproc.alive(pid)
