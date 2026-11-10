"""The Room (design 0003, sections 4 and 8): Rooks's own computer inside the app, restored honestly.

/api/room says what the Room really is (screen, pointer, isolation, a plain label), every action is in the run log,
a saved point and a start over are checked against the store, a hand-off waits in Needs you and copies only after a
yes, the chat tool is offered only when a real driver exists, and a remote helper is proxied the same way."""

import asyncio
import base64
import json
import shutil
import socket
import sys
import threading
import time
from pathlib import Path

import pytest
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from conftest import SCRIPT, _port, events, tool_call

ROOT = Path(__file__).resolve().parents[3] / "rooks-try"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")
PLAIN_LABEL = "A private folder on this computer"  # room-pro: no "shell" on a normal screen (label_detail keeps it)


@pytest.fixture()
def room_home(client, tmp_path, monkeypatch):
    """A fresh Room folder with the private folder driver, in process; nothing remote."""
    from app import config, room

    monkeypatch.setenv("ROOKS_TRY_HOME", str(tmp_path / "try"))
    monkeypatch.setenv("ROOKS_TRY_DRIVER", "shell")
    monkeypatch.delenv("ROOKS_TRY_OFFLINE", raising=False)
    monkeypatch.setattr(config, "TRY_URL", "")
    monkeypatch.setattr(config, "TRY_API_KEY", "")
    room.reset()
    yield tmp_path / "try"
    room.reset()


def _audit(db, since: int) -> list[dict]:
    rows = db.all("SELECT tool, channel, args, outcome, verified, evidence, detail FROM actions WHERE id > ? AND channel = 'room' "
                  "AND kind = 'tool_call' ORDER BY id", since)
    for r in rows:
        r["action"] = json.loads(r["args"])["action"]
    return rows


def test_status_is_honest_for_the_private_folder(client, room_home):
    st = client.get("/api/room/status").json()
    assert st["available"] is True and st["running"] is False
    assert st["screen"] is False and st["pointer"] is False
    assert st["isolation"] in ("none", "namespace")
    assert st["label"] == PLAIN_LABEL and "Commands run as you" in st["note"]
    assert st["driver"] == "shell" and st["checkpoints"] == [] and st["last_checkpoint"] is None
    for word in ("Xvfb", "unshare", "namespace", "driver", "http", "Workbench"):
        assert word not in st["label"] and word not in st["note"], word


def test_status_says_how_the_rooms_programs_are_kept_together(client, room_home, monkeypatch):
    """Design 0011, section 3: on Windows every Room program is in a job ("containment": "job"), which is not a wall,
    so isolation stays "none" and the note says they can read and change your files. Elsewhere there is no job. (The
    driver's words on Windows are checked in rooks-try's test_room_job_windows.py; here, that the app passes them on.)"""
    import sys

    from rooks_try.drivers import shell as shell_mod

    st = client.get("/api/room/status").json()
    assert st["containment"] == ("job" if sys.platform == "win32" else "none")
    plain = shell_mod.ShellDriver.status
    monkeypatch.setattr(shell_mod.ShellDriver, "status", lambda self: {
        **plain(self), "isolation": "none", "containment": "job", "note": shell_mod.NOTE_WINDOWS})
    st = client.get("/api/room/status").json()
    assert st.get("containment") == "job" and st["isolation"] == "none", st
    assert "they all stop when the Room stops" in st["note"] and "they can read and change your files" in st["note"]


def test_up_and_run_write_only_inside_the_room_and_are_in_the_run_log(client, room_home, tmp_path):
    from app import db

    since = db.one("SELECT COALESCE(MAX(id), 0) AS m FROM actions")["m"]
    up = client.post("/api/room/up").json()
    assert up["running"] is True and up["label"] == PLAIN_LABEL
    assert "room" in client.get("/api/presence", params={"fresh": "true"}).json()["watching"]
    out = client.post("/api/room/run", json={"command": "echo room-ok > note.txt; pwd"}).json()
    assert out["ok"] is True and out["code"] == 0 and out["isolation"] in ("none", "namespace")
    home = room_home / "home"
    assert (home / "note.txt").read_text().strip() == "room-ok"
    assert Path(out["stdout"].strip().splitlines()[-1]).resolve() == home.resolve()
    assert {p.name for p in tmp_path.iterdir()} == {"try"}  # nothing landed outside the Room's folder
    assert client.post("/api/room/run", json={"command": "   "}).status_code == 400

    rows = _audit(db, since)
    assert [(r["action"], r["outcome"]) for r in rows] == [("up", "ok"), ("run", "ok"), ("run", "rejected")]
    assert all(r["tool"] == "use_room" for r in rows)
    assert "room-ok" in rows[1]["args"]  # the command is in the trace
    assert client.post("/api/room/down").json()["running"] is False
    assert "room" not in client.get("/api/presence", params={"fresh": "true"}).json()["watching"]
    assert [r["action"] for r in _audit(db, since)][-1] == "down"


def test_checkpoint_and_reset_round_trip_are_verified(client, room_home):
    from app import db

    since = db.one("SELECT COALESCE(MAX(id), 0) AS m FROM actions")["m"]
    client.post("/api/room/up")
    client.post("/api/room/run", json={"command": "echo one > mark.txt"})
    cp = client.post("/api/room/checkpoint", json={"label": "before"}).json()
    assert cp["name"] and cp["verified"] is True and cp["label"] == "before"
    st = client.get("/api/room/status").json()
    assert st["last_checkpoint"]["name"] == cp["name"] and cp["name"] in [c["name"] for c in st["checkpoints"]]
    client.post("/api/room/run", json={"command": "echo two > mark.txt"})
    back = client.post("/api/room/reset", json={"name": cp["name"]}).json()
    assert back["verified"] is True and back["name"] == cp["name"]
    assert client.post("/api/room/run", json={"command": "cat mark.txt"}).json()["stdout"].strip() == "one"
    assert client.post("/api/room/reset", json={"name": "../outside"}).status_code == 404
    rows = _audit(db, since)
    saved = next(r for r in rows if r["action"] == "checkpoint")
    assert saved["verified"] == 1 and saved["outcome"] == "verified" and cp["name"] in saved["evidence"]
    back_rows = [r for r in rows if r["action"] == "reset"]
    assert (back_rows[0]["verified"], back_rows[0]["outcome"]) == (1, "verified")
    assert (back_rows[1]["verified"], back_rows[1]["outcome"]) == (None, "rejected")  # the bad name was refused, and that is on record


def test_handoff_waits_in_needs_you_and_copies_only_after_a_yes(client, room_home, tmp_path):
    from app import actions

    client.post("/api/room/up")
    client.post("/api/room/run", json={"command": "echo secret > keep.txt"})
    dest = tmp_path / "out" / "keep.txt"
    held = client.post("/api/room/handoff", json={"src": "keep.txt", "dest": str(dest)}).json()
    assert held["held"] is True and held["request_id"] and not dest.exists()
    aid = held["action_id"]
    assert actions.approval(aid)["status"] == "pending" and actions.approval(aid)["tool"] == "use_room"
    item = next(i for i in client.get("/api/needs-you").json() if i["id"] == f"a:{aid}")
    assert item["kind"] == "room" and item["title"] == "Copy a file out of the Room: keep.txt"
    assert item["tool"] == "use_room" and "keep.txt" in item["detail"] and item["actions"] == ["approve", "deny"]
    assert client.get("/api/presence", params={"fresh": "true"}).json()["needs_you"] >= 1
    # asking again before the answer: still held, nothing copied
    again = client.post("/api/room/handoff", json={"src": "keep.txt", "dest": str(dest), "request_id": held["request_id"]}).json()
    assert again["held"] is True and not dest.exists()
    r = client.post(f"/api/needs-you/a:{aid}/approve")
    assert r.status_code == 200 and r.json()["status"] == "done", r.text
    assert dest.read_text().strip() == "secret"
    assert client.post(f"/api/needs-you/a:{aid}/approve").status_code == 409
    done = client.post("/api/room/handoff", json={"src": "keep.txt", "dest": str(dest), "request_id": held["request_id"]}).json()
    assert done["ok"] is True and done["already"] is True  # copied once, on the yes
    other = client.post("/api/room/handoff", json={"src": "keep.txt", "dest": str(tmp_path / "elsewhere.txt"), "request_id": held["request_id"]})
    assert other.status_code == 409 and not (tmp_path / "elsewhere.txt").exists()  # the yes was for one file
    assert client.post("/api/room/handoff", json={"src": "keep.txt", "dest": str(dest), "request_id": "room:nothing"}).status_code == 404


def test_a_denied_handoff_never_copies(client, room_home, tmp_path):
    client.post("/api/room/up")
    client.post("/api/room/run", json={"command": "echo private > keep.txt"})
    dest = tmp_path / "out" / "nope.txt"
    held = client.post("/api/room/handoff", json={"src": "keep.txt", "dest": str(dest)}).json()
    r = client.post(f"/api/approvals/{held['action_id']}", json={"approve": False})  # the same card everywhere
    assert r.status_code == 200 and r.json()["status"] == "denied"
    assert not dest.exists()
    r = client.post("/api/room/handoff", json={"src": "keep.txt", "dest": str(dest), "request_id": held["request_id"]})
    assert r.status_code == 409 and not dest.exists()


def test_the_chat_tool_hands_off_through_the_same_held_request(client, room_home, tmp_path):
    from app import assistant

    client.post("/api/room/up")
    client.post("/api/room/run", json={"command": "echo from-chat > report.txt"})
    dest = tmp_path / "out" / "report.txt"
    cid = assistant.new_conversation("web")
    ctx = assistant.Ctx(channel="web", conversation_id=cid)
    out = asyncio.run(assistant._use_room(action="handoff", src="report.txt", dest=str(dest), ctx=ctx))
    assert out["held"] is True and not dest.exists()
    # the model cannot approve it itself: passing the request back copies nothing until a person says yes
    again = asyncio.run(assistant._use_room(action="handoff", src="report.txt", dest=str(dest), request_id=out["request_id"], ctx=ctx))
    assert again["held"] is True and not dest.exists()
    ok = client.post(f"/api/approvals/{out['action_id']}", json={"approve": True}).json()
    assert ok["status"] == "done" and dest.read_text().strip() == "from-chat"


def test_screenshot_only_when_there_is_a_screen(client, room_home, monkeypatch):
    from app import room

    client.post("/api/room/up")
    r = client.get("/api/room/screenshot")
    assert r.status_code == 404 and "screen" in r.json()["detail"].lower()
    # the drawn terminal has a picture and no pointer; it is only reachable by name and is not a real Room
    monkeypatch.setenv("ROOKS_TRY_DRIVER", "display")
    room.reset()
    st = client.get("/api/room/status").json()
    assert st["screen"] is True and st["pointer"] is False and st["label"] == "A picture of a screen, not a computer" \
        and st["label_detail"] == "A drawing of a terminal"  # room-pro: plain words; the exact label for Advanced
    assert client.get("/api/room/screenshot").status_code == 404  # off: nothing to show yet
    client.post("/api/room/up")
    r = client.get("/api/room/screenshot")
    assert r.status_code == 200 and r.headers["content-type"] == "image/png" and r.headers["cache-control"] == "no-store"
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n"
    assert room.enabled() is False


def test_use_room_is_offered_only_with_a_real_driver(client, room_home, monkeypatch):
    from app import assistant, room

    ctx = assistant.Ctx(channel="web", conversation_id=assistant.new_conversation("web"))

    def names() -> set[str]:
        return {t.name for t in assistant.available_tools(ctx)}

    assert room.enabled() is True  # a private folder and shell is a real Room
    assert "use_room" in names()
    tool = assistant.TOOL_MAP["use_room"]
    assert tool.effect == "external" and tool.untrusted is True
    assert tool.confirm({"action": "up"}) == assistant.ROOM_CONFIRM == "This uses the Room, Rooks's own computer. In a private folder, commands run as you."
    assert tool.confirm({"action": "run", "command": "ls"}) == assistant.ROOM_CONFIRM
    assert tool.confirm({"action": "handoff"}) == ""  # a hand-off makes its own held request; one yes, not two
    assert "call use_room" in assistant.system_prompt(ctx, "hi")
    monkeypatch.setenv("ROOKS_TRY_DRIVER", "display")
    room.reset()
    assert room.enabled() is False  # a drawing is not
    assert "use_room" not in names() and "use_room" not in assistant.system_prompt(ctx, "hi")
    monkeypatch.setattr(room, "enabled", lambda: True)
    assert "use_room" in names()


def test_up_publishes_a_watch_event_and_says_what_the_room_is(client, room_home):
    from app import assistant

    q: asyncio.Queue = asyncio.Queue()
    ctx = assistant.Ctx(channel="web", conversation_id=assistant.new_conversation("web"), live=q)
    out = asyncio.run(assistant._use_room(action="up", goal="Install the tool and try it", ctx=ctx))
    assert out["running"] is True and out["label"] == PLAIN_LABEL and out["isolation"] in ("none", "namespace")
    assert out["screen"] is False and out["pointer"] is False and "Commands run as you" in out["note"]
    assert q.get_nowait() == {"type": "watch", "surface": "room", "job_id": "room", "goal": "Install the tool and try it"}
    ran = asyncio.run(assistant._use_room(action="run", command="echo via-tool", ctx=ctx))
    assert ran["ok"] is True and "via-tool" in ran["stdout"]
    assert asyncio.run(assistant._use_room(action="down", ctx=ctx))["running"] is False

    SCRIPT[:] = [tool_call("use_room", {"action": "up", "goal": "Try the installer"}),
                 {"role": "assistant", "content": "I need your OK to use the Room."}]
    ev = events(client.post("/api/assistant/chat", json={"message": "try it in the Room"}))
    held = next(e for e in ev if e["type"] == "approval_required")
    assert held["tool"] == "use_room" and held["reason"] == assistant.ROOM_CONFIRM
    item = next(i for i in client.get("/api/needs-you").json() if i["id"] == f"a:{held['id']}")
    assert item["kind"] == "room" and item["title"] == "Start the Room: Try the installer"
    ok = client.post(f"/api/approvals/{held['id']}", json={"approve": True}).json()
    assert ok["status"] == "done" and PLAIN_LABEL in ok["result"]
    assert client.get("/api/room/status").json()["running"] is True


@pytest.mark.skipif(not shutil.which("Xvfb"), reason="needs Xvfb")
def test_a_private_desktop_has_a_real_screen(client, room_home, monkeypatch):
    """On Linux with Xvfb the Room is a private desktop: a real picture with many colours, a pointer, and a command
    that sees the Room's display, never the person's own."""
    import io

    from PIL import Image

    from app import room

    monkeypatch.setenv("ROOKS_TRY_DRIVER", "nested")
    monkeypatch.setenv("ROOKS_TRY_DISPLAY", ":24")
    monkeypatch.delenv("DISPLAY", raising=False)
    room.reset()
    try:
        st = client.post("/api/room/up").json()
        assert st["running"] is True and st["screen"] is True and st["pointer"] is True
        assert client.get("/api/room/status").json()["label"] == "A private desktop on this computer"
        colours = 0
        for _ in range(40):  # the terminal needs a moment to map its window
            r = client.get("/api/room/screenshot")
            assert r.status_code == 200 and r.headers["content-type"] == "image/png"
            with Image.open(io.BytesIO(r.content)) as img:
                colours = len(img.convert("RGB").getcolors(maxcolors=1 << 20) or [])
            if colours > 1:
                break
            time.sleep(0.25)
        assert colours > 1, "the Room's screen is one flat colour: nothing real is drawn on it"
        out = client.post("/api/room/run", json={"command": "echo display=$DISPLAY"}).json()
        assert out["ok"] is True and "display=:24" in out["stdout"]
        assert client.post("/api/room/click", json={"x": 10, "y": 10}).json()["ok"] is True
        assert client.post("/api/room/drag", json={"x1": 10, "y1": 10, "x2": 40, "y2": 40}).json()["ok"] is True
        assert client.post("/api/room/scroll", json={"x": 10, "y": 10, "dy": -2}).json()["ok"] is True
    finally:
        client.post("/api/room/down")
        room.reset()


def test_room_routes_need_sign_in(client, room_home):
    from fastapi.testclient import TestClient

    from app import main

    anon = TestClient(main.app)
    assert anon.get("/api/room/status").status_code == 401
    assert anon.get("/api/room/screenshot").status_code == 401
    for path in ("up", "run", "handoff", "reset"):
        assert anon.post(f"/api/room/{path}", json={"command": "id"}, headers={"X-Workbench": "1"}).status_code == 401, path


def test_without_the_package_the_room_is_honestly_unavailable(client, room_home, monkeypatch):
    from app import room, surfaces

    monkeypatch.setattr(room, "_import_room", lambda: None)
    st = client.get("/api/room/status").json()
    assert st["available"] is False and st["running"] is False and st["screen"] is False and st["pointer"] is False
    assert st["checkpoints"] == [] and "not installed" in st["label"].lower()
    assert client.post("/api/room/up").status_code == 503
    assert room.enabled() is False and room.running() is False
    assert surfaces.status()["room"]["available"] is False


# --- a separate rooks-try serve, proxied through the app (TRY_URL) ---------------------------------------------------
HELPER_KEY = "r" * 32
helper = FastAPI()
SEEN: dict[str, list] = {"auth": [], "posts": []}
REMOTE: dict = {"running": False, "checkpoints": [], "driver": "nested"}


def _auth(req: Request) -> bool:
    SEEN["auth"].append(req.headers.get("authorization"))
    return req.headers.get("authorization") == f"Bearer {HELPER_KEY}"


def _remote_status() -> dict:
    return {"version": "0.1.0", "driver": REMOTE.get("driver", "nested"), "running": REMOTE["running"], "screen": True, "pointer": True,
            "isolation": "namespace", "label": "A private desktop on this computer",
            "note": "A screen of its own on this computer. Commands run as you, in a folder of its own.", "home": "/x/home",
            "checkpoints": [{"name": n, "path": f"/x/checkpoints/{n}"} for n in reversed(REMOTE["checkpoints"])],
            "last_checkpoint": {"name": REMOTE["checkpoints"][-1]} if REMOTE["checkpoints"] else None,
            "checkpoint_limit": 20, "pruned": None, "drivers": []}


@helper.get("/api/status")
def h_status(req: Request):
    if not _auth(req):
        return JSONResponse({"detail": "Not signed in"}, 401)
    return _remote_status()


@helper.post("/api/{action}")
async def h_action(action: str, req: Request):
    if not _auth(req):
        return JSONResponse({"detail": "Not signed in"}, 401)
    body = await req.json()
    SEEN["posts"].append((action, body))
    if action == "up":
        REMOTE["running"] = True
        return _remote_status()
    if action == "run":
        return {"ok": True, "code": 0, "stdout": f"remote ran: {body.get('command')}\n", "stderr": "", "note": "This ran as you, in the private folder."}
    if action == "checkpoint":
        name = f"20261106T12000{len(REMOTE['checkpoints'])}-{body.get('label') or 'save'}"
        REMOTE["checkpoints"].append(name)
        return {"name": name, "label": body.get("label") or "save", "path": f"/x/checkpoints/{name}", "removed": []}
    if action == "handoff":
        return {"ok": True, "from": body.get("src"), "to": body.get("dest")}
    return JSONResponse({"detail": "Not found"}, 404)


@helper.get("/api/screenshot")
def h_shot(req: Request):
    if not _auth(req):
        return JSONResponse({"detail": "Not signed in"}, 401)
    return Response(PNG, media_type="image/png", headers={"Cache-Control": "no-store"})


@pytest.fixture(scope="module")
def helper_url():
    port = _port()
    server = uvicorn.Server(uvicorn.Config(helper, host="127.0.0.1", port=port, log_level="error"))
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
            break
        except OSError:
            time.sleep(0.1)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True


@pytest.fixture()
def remote_room(client, helper_url, monkeypatch):
    from app import config, room

    monkeypatch.setattr(config, "TRY_URL", helper_url)
    monkeypatch.setattr(config, "TRY_API_KEY", HELPER_KEY)
    for v in SEEN.values():
        v.clear()
    REMOTE.update(running=False, checkpoints=[], driver="nested")
    room.reset()
    yield helper_url
    room.reset()


def test_a_separate_helper_is_proxied_with_the_same_contract(client, remote_room, tmp_path):
    from app import room, surfaces

    st = client.get("/api/room/status").json()
    assert st["available"] is True and st["running"] is False and st["screen"] is True and st["pointer"] is True
    assert st["isolation"] == "namespace" and st["label"] == "A private desktop on this computer" and st["driver"] == "nested"
    assert SEEN["auth"][0] == f"Bearer {HELPER_KEY}"
    assert client.post("/api/room/up").json()["running"] is True
    assert room.running() is True and "room" in client.get("/api/presence", params={"fresh": "true"}).json()["watching"]
    assert surfaces.status()["room"] == {"available": True, "label": "A private desktop on this computer", "isolation": "namespace"}
    out = client.post("/api/room/run", json={"command": "ls"}).json()
    assert out["ok"] is True and "remote ran: ls" in out["stdout"]
    r = client.get("/api/room/screenshot")
    assert r.status_code == 200 and r.headers["content-type"] == "image/png" and r.content == PNG
    cp = client.post("/api/room/checkpoint", json={"label": "snap"}).json()
    assert cp["verified"] is True and cp["name"].endswith("-snap")
    assert ("run", {"command": "ls", "timeout": 120}) in SEEN["posts"]
    # a hand-off still waits here, in Needs you, and the helper is only asked after the yes
    dest = tmp_path / "out.txt"
    held = client.post("/api/room/handoff", json={"src": "a.txt", "dest": str(dest)}).json()
    assert held["held"] is True and not any(a == "handoff" for a, _ in SEEN["posts"])
    assert client.post(f"/api/needs-you/a:{held['action_id']}/approve").json()["status"] == "done"
    assert ("handoff", {"src": "a.txt", "dest": str(dest), "approve": True}) in SEEN["posts"]


def test_an_unreachable_helper_is_an_error_not_a_silent_folder(client, monkeypatch):
    from app import config, room, surfaces

    monkeypatch.setattr(config, "TRY_URL", "http://127.0.0.1:9")
    monkeypatch.setattr(config, "TRY_API_KEY", HELPER_KEY)
    room.reset()
    try:
        assert client.get("/api/room/status").status_code == 502
        assert client.post("/api/room/up").status_code == 502
        assert room.running() is False
        assert surfaces.status()["room"]["available"] is False
    finally:
        room.reset()


def test_two_asks_for_the_same_file_show_once_in_needs_you(client, room_home, tmp_path):
    """B3: a repeated hand-off request before the answer is the same request, through the route and the chat tool."""
    from app import actions, assistant

    client.post("/api/room/up")
    client.post("/api/room/run", json={"command": "echo twice > twice.txt"})
    dest = tmp_path / "out" / "twice.txt"
    before = len(client.get("/api/needs-you").json())
    first = client.post("/api/room/handoff", json={"src": "twice.txt", "dest": str(dest)}).json()
    second = client.post("/api/room/handoff", json={"src": "twice.txt", "dest": str(dest)}).json()
    assert first["held"] is True and second["held"] is True
    assert second["request_id"] == first["request_id"] and second["action_id"] == first["action_id"]
    assert len(client.get("/api/needs-you").json()) == before + 1
    # the chat tool asking again for the same file joins the same request and the turn stops asking
    cid = assistant.new_conversation("web")
    ctx = assistant.Ctx(channel="web", conversation_id=cid)
    again = asyncio.run(assistant._use_room(action="handoff", src="twice.txt", dest=str(dest), ctx=ctx))
    assert again["held"] is True and again["request_id"] == first["request_id"] and ctx.held_repeats == 1
    assert len(client.get("/api/needs-you").json()) == before + 1 and not dest.exists()
    # a different place is a different request
    other = client.post("/api/room/handoff", json={"src": "twice.txt", "dest": str(tmp_path / "elsewhere.txt")}).json()
    assert other["request_id"] != first["request_id"] and len(client.get("/api/needs-you").json()) == before + 2
    # once answered, the same ask is a new request again
    assert client.post(f"/api/approvals/{first['action_id']}", json={"approve": False}).json()["status"] == "denied"
    third = client.post("/api/room/handoff", json={"src": "twice.txt", "dest": str(dest)}).json()
    assert third["request_id"] != first["request_id"]
    for a in actions.pending():
        if a["tool"] == "use_room":
            actions.decide(a["id"], False, "test")


# --- review fixes ------------------------------------------------------------------------------------------------------
def test_a_helper_refusing_the_apps_key_is_not_a_sign_out(client, remote_room, monkeypatch):
    """A 401 from the helper is the helper's key, not the person's sign-in: the app answers 502, never 401."""
    from app import config

    monkeypatch.setattr(config, "TRY_API_KEY", "wrong-key")
    r = client.get("/api/room/status")
    assert r.status_code == 502
    detail = r.json()["detail"]
    assert "key" in detail and "Not signed in" not in detail
    assert client.post("/api/room/up").status_code == 502
    assert client.get("/api/room/screenshot").status_code == 502


def test_a_helper_that_only_draws_is_not_a_room(client, remote_room):
    from app import room

    REMOTE["driver"] = "display"
    room.reset()
    assert room.enabled() is False
    assert room.describe()["available"] is False
    REMOTE["driver"] = "nested"
    room.reset()
    assert room.enabled() is True


def test_the_chat_tool_does_not_run_in_a_room_that_is_off(client, room_home):
    from app import assistant

    ctx = assistant.Ctx(channel="web", conversation_id=assistant.new_conversation("web"))
    out = asyncio.run(assistant._use_room(action="run", command="echo should-not > nope.txt", ctx=ctx))
    assert out["ok"] is False and "off" in out["error"].lower()
    assert not (room_home / "home" / "nope.txt").exists()
    assert client.get("/api/room/status").json()["running"] is False
    r = client.post("/api/room/run", json={"command": "echo should-not > nope.txt"})
    assert r.status_code == 409 and "off" in r.json()["detail"].lower()
    assert not (room_home / "home" / "nope.txt").exists()


def test_a_stop_during_a_screenshot_does_not_start_the_room_again(client, room_home, monkeypatch):
    from app import room

    monkeypatch.setenv("ROOKS_TRY_DRIVER", "display")
    room.reset()
    client.post("/api/room/up")
    live = room._import_room()
    real = live.screenshot

    def stopped_first(*a, **k):  # the person pressed Stop between the status check and the capture
        live.down()
        return real(*a, **k)

    monkeypatch.setattr(live, "screenshot", stopped_first)
    r = client.get("/api/room/screenshot")
    assert r.status_code == 404 and r.json()["detail"] == room.OFF
    assert client.get("/api/room/status").json()["running"] is False


def test_a_tainted_chat_hands_off_with_one_yes(client, room_home, tmp_path):
    """use_room taints the chat; the hand-off it then asks for waits once, in Needs you, and one yes copies it."""
    from app import actions

    client.post("/api/room/up")
    client.post("/api/room/run", json={"command": "echo once > keep.txt"})
    dest = tmp_path / "out" / "keep.txt"
    SCRIPT[:] = [tool_call("use_room", {"action": "status"}, "s1"),
                 tool_call("use_room", {"action": "handoff", "src": "keep.txt", "dest": str(dest)}, "h1"),
                 {"role": "assistant", "content": "It waits for your OK in Needs you."}]
    ev = events(client.post("/api/assistant/chat", json={"message": "copy keep.txt out"}))
    SCRIPT.clear()
    assert not [e for e in ev if e["type"] == "approval_required"], [e for e in ev if e["type"] == "approval_required"]
    waiting = [a for a in actions.pending() if a["tool"] == "use_room"]
    assert len(waiting) == 1 and json.loads(waiting[0]["args"])["action"] == "handoff"
    ok = client.post(f"/api/needs-you/a:{waiting[0]['id']}/approve").json()
    assert ok["status"] == "done" and dest.read_text().strip() == "once"
    assert not [a for a in actions.pending() if a["tool"] == "use_room"]


def test_an_approval_whose_run_only_waits_again_is_reported_held(client, room_home, tmp_path):
    """A held call that, once approved, only made another request reports held, not done."""
    from app import actions, front_door

    client.post("/api/room/up")
    client.post("/api/room/run", json={"command": "echo twice > two.txt"})
    dest = tmp_path / "out" / "two.txt"
    args = json.dumps({"action": "handoff", "src": "two.txt", "dest": str(dest)})
    aid = actions.add("tool_call", "held", trace={"channel": "web", "conversation_id": front_door.main_conversation()},
                      tool="use_room", effect="external", payload=args, args=args, detail="test")
    out = client.post(f"/api/approvals/{aid}", json={"approve": True}).json()
    assert out["status"] == "held" and not dest.exists()
    for a in actions.pending():
        if a["tool"] == "use_room":
            actions.decide(a["id"], False, "test")


def test_asking_twice_for_a_handoff_ends_without_an_id(client, room_home, tmp_path):
    from app import actions

    client.post("/api/room/up")
    client.post("/api/room/run", json={"command": "echo again > again.txt"})
    dest = tmp_path / "out" / "again.txt"
    client.post("/api/room/handoff", json={"src": "again.txt", "dest": str(dest)})
    SCRIPT[:] = [tool_call("use_room", {"action": "handoff", "src": "again.txt", "dest": str(dest)}),
                 {"role": "assistant", "content": "never"}]
    ev = events(client.post("/api/assistant/chat", json={"message": "copy again.txt out"}))
    SCRIPT.clear()
    final = next(e for e in ev if e["type"] == "message")["content"]
    assert "None" not in final and "#" not in final and "use room" not in final
    assert "Needs you" in final and "Copy a file out of the Room" in final
    for a in actions.pending():
        if a["tool"] == "use_room":
            actions.decide(a["id"], False, "test")


def test_history_says_what_the_room_did_in_plain_words(client, room_home):
    from app import history

    up = history.describe("use_room", {"action": "up", "goal": "Try the new tool"}, {"running": True}, {})
    assert up["title"] == "Started the Room: Try the new tool" and up["category"] == "computer"
    assert "use_room" not in up["title"] and "Room page" in up["fix"]
    ran = history.describe("use_room", {"action": "run", "command": "ls -la"}, {"ok": True}, {})
    assert ran["title"] == "Ran in the Room: ls -la"
    out = history.describe("use_room", {"action": "handoff", "src": "a.txt", "dest": "/tmp/a.txt"}, {"ok": True}, {})
    assert out["title"].startswith("Copied a file out of the Room: a.txt")


# --- design 0006, 9.3: Files, what the Room can do, and the two-minute note ------------------------------------------
@pytest.mark.skipif(sys.platform == "win32", reason="POSIX links")
def test_files_lists_the_rooms_folder_on_or_off_and_never_outside(client, room_home):
    home = room_home / "home"
    client.post("/api/room/up")  # the owner's case: something was installed while it was on
    (home / "Desktop").mkdir(parents=True, exist_ok=True)
    (home / "Desktop" / "notes.txt").write_text("")
    (home / "out").symlink_to("/etc")
    assert client.post("/api/room/down").json()["running"] is False
    top = client.get("/api/room/files")
    assert top.status_code == 200, top.text
    body = top.json()
    assert body["path"] == "" and body["root_label"] == "Home" and body["truncated"] is False
    kinds = {e["name"]: e["kind"] for e in body["entries"]}
    assert kinds["Desktop"] == "folder" and kinds[".profile"] == "file" and kinds["out"] == "link"
    names = [e["name"] for e in body["entries"]]
    assert names.index("Desktop") < names.index("out") < names.index(".profile")  # folders first, dotfiles last
    desk = client.get("/api/room/files", params={"path": "Desktop"}).json()
    assert desk["path"] == "Desktop" and desk["parent"] == ""
    note = next(e for e in desk["entries"] if e["name"] == "notes.txt")
    assert note["kind"] == "file" and note["size"] == 0 and note["modified"][:4].isdigit()
    for bad in ("../", "out", "/etc", "Desktop/../../"):
        r = client.get("/api/room/files", params={"path": bad})
        assert r.status_code == 400 and r.json()["detail"] == "That is outside the Room.", (bad, r.text)
    gone = client.get("/api/room/files", params={"path": "Nowhere"})
    assert gone.status_code == 404 and gone.json()["detail"] == "That folder is gone."


def test_status_says_what_this_room_can_do(client, room_home, remote_room):
    from app import config, room

    st = client.get("/api/room/status").json()  # the helper (TRY_URL): no terminal and no folder on this computer
    assert st["can"] == {"terminal": False, "files": False, "terminal_off_reason": "helper", "browser": False,
                         "browser_off_reason": "helper", "run": True} and st["terminals"] == []  # room-pro: run
    assert client.get("/api/room/files").status_code == 501
    config.TRY_URL = ""
    room.reset()
    st = client.get("/api/room/status").json()
    if sys.platform != "win32":
        shown = {k: st["can"][k] for k in ("terminal", "files", "terminal_off_reason")}
        assert shown == {"terminal": True, "files": True, "terminal_off_reason": None}, st["can"]
        # the browser: here when an engine is found, else said why (design 0007)
        assert st["can"]["browser"] is (st["can"]["browser_off_reason"] is None), st["can"]
        assert st["can"]["browser_off_reason"] in (None, "no_engine"), st["can"]
    assert st["terminals"] == [] and st["terminal_max"] == 4


def test_the_120_second_note_points_to_a_terminal(client, room_home, monkeypatch):
    from app import room

    assert room.RUN_MAX_S == 120
    client.post("/api/room/up")
    monkeypatch.setattr(room, "RUN_MAX_S", 1)
    out = client.post("/api/room/run", json={"command": "sleep 3"}).json()
    assert out["code"] == 124
    assert out["note"] == out["error"] == "Stopped after 1 second. For something long, start it in a Room terminal."
    assert room.run_cut_note(120) == "Stopped after 120 seconds. For something long, start it in a Room terminal."
