"""The Room's terminals (design 0006, sections 4 and 6; tests 7 to 19 of section 9.2).

A Room terminal is a real login shell on a pseudo terminal, started inside the Room's own home with the Room's profile
and PATH. It lives on the server, not in the socket: leaving the page keeps it, coming back replays its text. It has
no time limit, says honestly when it is busy and how its last command ended, closes on Stop and Start over, survives
nothing across a restart but is listed as ended with its text, and is in the run log without anyone's keystrokes.

Each test opens its own shells and the fixture ends every one of them. The WebSocket is checked with terminal_pty's
rules (signed in, same origin, loopback); TestClient's peer is not loopback, so the tests that use a socket allow it
the way tests/test_app_terminal.py does.
"""

import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path

import pytest
from starlette.websockets import WebSocketDisconnect

ROOT = Path(__file__).resolve().parents[3] / "rooks-try"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX pseudo terminals only")
ORIGIN = {"origin": "http://testserver"}
BASH = "/bin/bash"


@pytest.fixture()
def room_home(client, tmp_path, monkeypatch):
    """A fresh Room folder with the private folder driver, in process, and bash as the person's shell (the exit code
    marker is in bash's and zsh's profile)."""
    from app import config, room, room_terminal

    if not os.path.exists(BASH):
        pytest.skip("needs bash")
    monkeypatch.setenv("ROOKS_TRY_HOME", str(tmp_path / "try"))
    monkeypatch.setenv("ROOKS_TRY_DRIVER", "shell")
    monkeypatch.setenv("SHELL", BASH)
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

    monkeypatch.setattr(terminal_pty, "_is_local", lambda ws: True)  # TestClient's peer is "testclient", not loopback
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


def _scrollback(ws) -> dict:
    first = json.loads(ws.receive_text())
    assert first["type"] == "scrollback", first
    return first


def _type(ws, text: str) -> None:
    ws.send_text(json.dumps({"type": "input", "data": text}))


def read_until(ws, needle: str, limit: int = 400) -> str:
    seen = ""
    for _ in range(limit):
        seen += ws.receive_text()
        if needle in seen:
            return seen
    raise AssertionError(f"never saw {needle!r} in {seen[-500:]!r}")


def _tail(client, tid: str, lines: int = 200) -> dict:
    r = client.get(f"/api/room/terminals/{tid}/tail", params={"lines": lines})
    assert r.status_code == 200, r.text
    return r.json()


def wait_tail(client, tid: str, until, timeout: float = 15.0) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        t = _tail(client, tid)
        if until(t):
            return t
        if time.monotonic() > deadline:
            raise AssertionError(f"the tail never got there: {t}")
        time.sleep(0.1)


def _send(client, tid: str, text: str):
    return client.post(f"/api/room/terminals/{tid}/send", json={"text": text, "enter": True})


def _status_terms(client) -> dict:
    return {t["id"]: t for t in client.get("/api/room/status").json()["terminals"]}


def _gone(pid: int, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.05)
    return False


# 7
def test_a_room_terminal_outlives_its_socket_and_replays_its_text(client, on, local):
    t = _open(client)
    assert t["name"] == "Terminal 1" and t["owner"] == "person" and t["alive"] is True
    with _ws(client, t["id"]) as ws:
        first = _scrollback(ws)
        assert first["alive"] is True and first["cols"] and first["rows"]
        _type(ws, "echo marker-$((20+22))\n")
        read_until(ws, "marker-42")
    assert _status_terms(client)[t["id"]]["alive"] is True  # the socket closed; the shell did not
    with _ws(client, t["id"]) as ws:
        again = _scrollback(ws)
        assert "marker-42" in again["data"] and "7777" not in again["data"]
        # one window at a time: a second one takes over and the first is told why
        with _ws(client, t["id"]) as other:
            assert "marker-42" in _scrollback(other)["data"]
            with pytest.raises(WebSocketDisconnect) as e:
                for _ in range(400):
                    ws.receive_text()
            assert e.value.code == 1000 and e.value.reason == "This terminal was opened in another window."


# 8
def test_the_shell_keeps_its_folder_and_variables_across_a_reattach(client, on, local):
    t = _open(client)
    with _ws(client, t["id"]) as ws:
        _scrollback(ws)
        _type(ws, "cd Desktop; export K=1; echo ready-$((1+1))\n")
        read_until(ws, "ready-2")
    with _ws(client, t["id"]) as ws:
        _scrollback(ws)
        _type(ws, 'echo "at:$(pwd) k:$K"\n')
        out = read_until(ws, "k:1")
    assert re.search(r"at:\S*/Desktop k:1", out), out[-300:]


# 9
def test_a_tool_installed_in_one_terminal_is_found_in_the_next_and_by_run(client, on, local):
    one = _open(client)
    with _ws(client, one["id"]) as ws:
        _scrollback(ws)
        _type(ws, "mkdir -p ~/.local/bin && printf '#!/bin/sh\\necho hi\\n' > ~/.local/bin/hello && chmod +x ~/.local/bin/hello"
                  " && echo installed-$((2+2))\n")
        read_until(ws, "installed-4")
    two = _open(client)
    assert two["name"] == "Terminal 2"
    with _ws(client, two["id"]) as ws:
        _scrollback(ws)
        _type(ws, "hello && echo found-$((40+2))\n")
        out = read_until(ws, "found-42")
    assert "hi\r\n" in out
    ran = client.post("/api/room/run", json={"command": "hello"}).json()
    assert ran["code"] == 0 and ran["stdout"] == "hi\n", ran


# 10
def test_a_long_command_is_not_cut_off_in_a_terminal(client, on, monkeypatch):
    from app import room

    monkeypatch.setattr(room, "RUN_MAX_S", 1)
    t = _open(client, command="sleep 3; echo slow-$((0+1))")
    assert t["owner"] == "rooks" and t["name"] == "Rooks"
    done = wait_tail(client, t["id"], lambda x: "slow-1" in x["text"] and not x["busy"], timeout=20)
    assert done["alive"] is True and done["exit_code"] == 0 and done["elapsed_s"] >= 3
    cut = client.post("/api/room/run", json={"command": "sleep 3"}).json()
    assert cut["code"] == 124 and "start it in a Room terminal" in cut["note"]


# 11
def test_tail_says_busy_and_the_exit_code_honestly(client, on):
    t = _open(client, command="sleep 2; false")
    now = _tail(client, t["id"])
    assert now["busy"] is True and now["exit_code"] is None and now["owner"] == "rooks" and now["taken"] is False
    later = wait_tail(client, t["id"], lambda x: not x["busy"], timeout=20)
    assert later["exit_code"] == 1 and later["alive"] is True
    assert "\x1b]7777" not in later["text"]  # the marker never reaches the screen
    assert client.get("/api/room/terminals/nope0000/tail").status_code == 404


# 12
def test_stop_hangs_every_terminal_up_and_says_so(client, on):
    pids = []
    for _ in range(2):
        tid = _open(client)["id"]
        assert _send(client, tid, "sleep 300 & echo pid=$$ job=$!").status_code == 200
        got = wait_tail(client, tid, lambda x: re.search(r"pid=(\d+) job=(\d+)", x["text"]))
        m = re.search(r"pid=(\d+) job=(\d+)", got["text"])
        pids += [int(m.group(1)), int(m.group(2))]
    down = client.post("/api/room/down").json()
    assert down["running"] is False and down["terminals_closed"] == 2
    terms = client.get("/api/room/status").json()["terminals"]
    assert len(terms) == 2 and all(t["alive"] is False and t["ended_reason"] == "stop" for t in terms), terms
    for pid in pids:
        assert _gone(pid), pid  # the shells and what they started


# 13
def test_start_over_closes_terminals_first_and_reopens_one(client, on):
    point = client.post("/api/room/checkpoint", json={"label": "before"}).json()
    assert point["verified"] is True
    old = _open(client)["id"]
    back = client.post("/api/room/reset", json={"name": point["name"]})
    assert back.status_code == 200, back.text
    back = back.json()
    assert back["verified"] is True and back["terminals_closed"] == 1
    assert back["terminal"]["id"] and back["terminal"]["id"] != old and back["terminal"]["name"] == "Terminal 1"
    alive = [t for t in client.get("/api/room/status").json()["terminals"] if t["alive"]]
    assert [t["id"] for t in alive] == [back["terminal"]["id"]]


# 14
def test_the_rooks_terminal_is_not_typed_into_until_taken(client, on):
    t = _open(client, command="sleep 5")
    r = _send(client, t["id"], "echo mine")
    assert r.status_code == 409 and r.json()["detail"] == "Rooks is working in that terminal. Take it first, or open your own."
    took = client.post(f"/api/room/terminals/{t['id']}/take", json={"owner": "person"})
    assert took.status_code == 200 and took.json() == {"id": t["id"], "owner": "person", "taken": True}
    assert _send(client, t["id"], "echo mine").status_code == 200
    tail = _tail(client, t["id"])
    assert tail["taken"] is True and "theirs" in tail["note"]
    from app import presence

    assert presence.plain_step("use_room", {"action": "tail"}) == "You took the terminal; Rooks waits"


# 15
def test_four_terminals_at_most_counted_apart_from_the_app_terminal(client, on):
    from app import terminal_pty

    before = set(terminal_pty._open)
    for n in range(4):
        assert _open(client)["name"] == f"Terminal {n + 1}"
    r = client.post("/api/room/terminals", json={})
    assert r.status_code == 429 and r.json()["detail"] == "Four terminals can be open in the Room. Close one to open another."
    assert terminal_pty._open == before  # the app terminal's six are its own
    listed = client.get("/api/room/terminals").json()
    assert listed["max"] == 4 and len(listed["terminals"]) == 4 and listed["terminals"][0]["shell"]


# 16
@pytest.mark.parametrize("case", ["signed_out", "other_origin", "remote", "switched_off", "unknown", "ended"])
def test_who_may_not_open_a_room_terminal(client, on, monkeypatch, case):
    from app import db, terminal_pty

    tid = _open(client)["id"]
    monkeypatch.setattr(terminal_pty, "_is_local", lambda ws: case != "remote")
    headers = {"origin": "https://evil.example"} if case == "other_origin" else ORIGIN
    if case == "signed_out":
        monkeypatch.setattr(terminal_pty, "check_session", lambda cookie: False)
    if case == "switched_off":
        assert client.put("/api/settings", json={"app_terminal": False}).json()["app_terminal"] is False
    if case == "unknown":
        tid = "0000dead"
    if case == "ended":
        assert client.delete(f"/api/room/terminals/{tid}").status_code == 200
        tid = _open(client)["id"]
        _send(client, tid, "exit")
        wait_tail(client, tid, lambda x: not x["alive"])
    want = {"signed_out": 4401, "unknown": 4404, "ended": 4409}.get(case, 4403)
    try:
        with client.websocket_connect(f"/api/room/terminals/{tid}/ws", headers=headers) as ws:
            with pytest.raises(WebSocketDisconnect) as e:
                ws.receive_text()
        assert e.value.code == want, (case, e.value.code, e.value.reason)
        assert "pty" not in e.value.reason and "Workbench" not in e.value.reason
    finally:
        db.set_setting("app_terminal", "1")


# 17
def test_terminal_rows_are_in_the_run_log_and_keystrokes_are_not(client, on, local):
    from app import db

    since = db.one("SELECT COALESCE(MAX(id), 0) AS m FROM actions")["m"]
    t = _open(client)
    with _ws(client, t["id"]) as ws:
        _scrollback(ws)
        _type(ws, "echo secret-sauce-$((1+1))\n")
        read_until(ws, "secret-sauce-2")
        assert _send(client, t["id"], "echo api_key=sauce-1234").status_code == 200
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and not db.one("SELECT id FROM actions WHERE id > ? AND channel = 'room' AND args LIKE "
                                                     "'%used terminal%'", since):
        time.sleep(0.05)
    assert client.delete(f"/api/room/terminals/{t['id']}").json()["closed"] is True
    rows = db.all("SELECT tool, args, detail, evidence, failure_reason FROM actions WHERE id > ? AND channel = 'room' "
                  "AND kind = 'tool_call' ORDER BY id", since)
    assert [json.loads(r["args"])["action"] for r in rows] == ["open terminal", "send", "used terminal", "close terminal"], rows
    assert all(r["tool"] == "use_room" for r in rows)
    send = json.loads(rows[1]["args"])
    assert "echo api_key=" in send["text"] and "sauce-1234" not in rows[1]["args"]  # scrubbed like every preview
    assert re.fullmatch(r"You used the terminal for \d+ min", rows[2]["detail"]), rows[2]["detail"]
    for r in rows:
        assert "secret-sauce" not in json.dumps(r), r  # what the person typed is never recorded


# 18
def test_an_ended_terminal_is_listed_after_a_restart_with_its_log(client, on):
    from app import assistant, actions, restart, room_terminal

    tid = _open(client)["id"]
    _send(client, tid, "echo mark-$((6*7))")
    wait_tail(client, tid, lambda x: "mark-42" in x["text"])
    room_terminal.reset_for_tests()  # what a restart does: every shell hung up, the registry forgotten
    room_terminal.load_ended()
    t = _status_terms(client)[tid]
    assert t["alive"] is False and t["ended_reason"] == "restart"
    assert "mark-42" in _tail(client, tid)["text"]  # its log is its scrollback
    # the thread is told, once
    cid = assistant.new_conversation("web")
    actions.add("turn", "running", trace={"channel": "web", "conversation_id": cid}, model="x")
    assert room_terminal.ended_at_restart() == 1
    done = restart.interrupt_running_turns()
    note = next(d for d in done if d["conversation_id"] == cid)
    rows = client.get(f"/api/conversations/{cid}").json()["messages"]
    assert rows[-1]["id"] == note["message_id"] and "Terminals in the Room ended; their files are still there." in rows[-1]["content"]
    room_terminal.reset_for_tests(restart=False)
    room_terminal.load_ended()
    assert room_terminal.ended_at_restart() == 0  # the next restart does not say it again


# 19
def test_the_chat_tool_starts_tails_and_lists_files(client, on):
    from app import assistant

    ctx = assistant.Ctx(channel="web", conversation_id=assistant.new_conversation("web"))
    out = asyncio.run(assistant._use_room(action="start", command="echo from-$((0+1))-chat", ctx=ctx))
    assert out["started"] is True and out["name"] == "Rooks" and "tail" in out["note"]
    deadline = time.monotonic() + 15
    while True:
        tail = asyncio.run(assistant._use_room(action="tail", ctx=ctx))
        if "from-1-chat" in tail["text"] and not tail["busy"]:
            break
        assert time.monotonic() < deadline, tail
        time.sleep(0.1)
    assert tail["exit_code"] == 0 and tail["id"] == out["id"]
    files = asyncio.run(assistant._use_room(action="files", ctx=ctx))
    assert "Desktop" in [e["name"] for e in files["entries"]]
    tool = assistant.TOOL_MAP["use_room"]
    assert "start" in tool.description and "more than a minute" in tool.description
    assert tool.confirm({"action": "start", "command": "x"}) == assistant.ROOM_CONFIRM
    assert tool.confirm({"action": "tail"}) == "" and tool.confirm({"action": "files"}) == ""
    from app import presence

    assert presence.plain_step("use_room", {"action": "start", "command": "x"}) == "Installing in the Room's terminal"


def test_a_room_terminal_has_none_of_the_apps_secrets_and_the_rooms_path(client, on, monkeypatch):
    monkeypatch.setenv("SOME_PROVIDER_API_KEY", "sk-should-not-leak")
    monkeypatch.setenv("SOME_SERVICE_PASSWORD", "hunter2-should-not-leak")
    tid = _open(client)["id"]
    _send(client, tid, 'echo "[${APP_SECRET}][${TOOLS_API_KEY}][${SOME_PROVIDER_API_KEY}][${SOME_SERVICE_PASSWORD}]'
                       '[$ROOKS_TRY]" "first=${PATH%%:*}"')
    out = wait_tail(client, tid, lambda x: "[][][][][1]" in x["text"])["text"]
    assert "should-not-leak" not in out.replace("SOME_PROVIDER_API_KEY", "").replace("SOME_SERVICE_PASSWORD", "")
    assert re.search(r"first=\S*/\.local/bin", out), out[-300:]


def test_the_chat_can_watch_an_install_more_than_once_in_a_turn(client, on):
    """tail twice in one turn is watching, not a repeated change: neither is turned away as "already done"."""
    from conftest import SCRIPT, events, tool_call

    from app import db

    tid = _open(client, command="sleep 1; echo watched-$((2*3))")["id"]
    since = db.one("SELECT COALESCE(MAX(id), 0) AS m FROM actions")["m"]
    SCRIPT[:] = [tool_call("use_room", {"action": "tail", "id": tid}, "t1"),
                 tool_call("use_room", {"action": "tail", "id": tid}, "t2"),
                 {"role": "assistant", "content": "It is still installing."}]
    ev = events(client.post("/api/assistant/chat", json={"message": "how is the install going?"}))
    SCRIPT.clear()
    assert not [e for e in ev if e["type"] == "approval_required"]
    rows = db.all("SELECT outcome FROM actions WHERE id > ? AND kind = 'tool_call' AND tool = 'use_room' AND channel != 'room'",
                  since)
    assert [r["outcome"] for r in rows] == ["ok", "ok"], rows
