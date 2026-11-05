"""Try Room: a disposable computer on this machine for the agent to try things.

Runs in-process when the `rooks_try` package is installed (the usual desktop install).
When that package is missing, a private folder on this computer still starts, so the
page is never a dead end. Optionally proxies to a separate `rooks-try serve` when TRY_URL is set.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response

from . import config
from .security import require_user

_SECRET_ENV = {"APP_SECRET", "TOOLS_API_KEY", "BROWSER_API_KEY"}

router = APIRouter(prefix="/api/try", dependencies=[Depends(require_user)])

_ROOM = None


def enabled() -> bool:
    """The virtual computer can always start. A fuller one is used when it is installed."""
    return True


def _import_room():
    global _ROOM
    if _ROOM is not None:
        return _ROOM
    try:
        from rooks_try.room import TryRoom
    except ImportError:
        # Editable checkout next to workbench
        root = Path(__file__).resolve().parents[3] / "rooks-try"
        if (root / "rooks_try").is_dir():
            import sys
            sys.path.insert(0, str(root))
            try:
                from rooks_try.room import TryRoom
            except ImportError:
                return None
        else:
            return None
    prefer = os.environ.get("ROOKS_TRY_DRIVER", "auto")
    offline = os.environ.get("ROOKS_TRY_OFFLINE", "").lower() in {"1", "true", "yes"}
    _ROOM = TryRoom(prefer=prefer, offline=offline)
    return _ROOM


async def _remote(method: str, path: str, json: dict | None = None, timeout: float = 60) -> httpx.Response:
    url = getattr(config, "TRY_URL", "") or ""
    key = getattr(config, "TRY_API_KEY", "") or ""
    if not url:
        raise HTTPException(503, "Virtual computer is not running.")
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            return await client.request(
                method, f"{url}{path}", json=json,
                headers={"Authorization": f"Bearer {key}"} if key else {},
            )
    except httpx.HTTPError as exc:
        raise HTTPException(502, "Virtual computer could not be reached.") from exc


class BuiltinVirtual:
    """A private folder when the fuller virtual computer is not installed. Commands run as you."""

    def __init__(self, home: Path):
        self.home = home
        self.points = home.parent / "virtual-points"

    def status(self) -> dict:
        running = (self.home / ".on").is_file()
        last = None
        if self.points.is_dir():
            names = sorted(p.name for p in self.points.iterdir() if p.is_dir())
            if names:
                label_path = self.points / names[-1] / ".label"
                label = label_path.read_text(encoding="utf-8") if label_path.is_file() else names[-1]
                last = {"name": names[-1], "label": label}
        return {
            "running": running,
            "screen": False,
            "driver": "shell",
            "label": "A private folder. Commands run as you.",
            "note": "A private folder on this computer. Commands run as you.",
            "last_checkpoint": last,
        }

    def up(self) -> dict:
        self.home.mkdir(parents=True, exist_ok=True)
        (self.home / ".on").write_text("1", encoding="utf-8")
        return self.status()

    def down(self) -> dict:
        try:
            (self.home / ".on").unlink()
        except OSError:
            pass
        return self.status()

    def checkpoint(self, label: str = "") -> dict:
        self.home.mkdir(parents=True, exist_ok=True)
        name = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        dest = self.points / name
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(self.home, dest, ignore=shutil.ignore_patterns(".on"))
        text = (label or "Saved point").strip() or "Saved point"
        (dest / ".label").write_text(text, encoding="utf-8")
        return {"name": name, "label": text}

    def reset(self, name: str | None = None) -> dict:
        self.points.mkdir(parents=True, exist_ok=True)
        picked = name
        if not picked and self.points.is_dir():
            names = sorted(p.name for p in self.points.iterdir() if p.is_dir())
            picked = names[-1] if names else None
        if self.home.exists():
            shutil.rmtree(self.home)
        self.home.mkdir(parents=True, exist_ok=True)
        if picked:
            src = self.points / picked
            if not src.is_dir() or src.resolve().parent != self.points.resolve():
                raise HTTPException(404, "That saved point is not on this computer.")
            for child in src.iterdir():
                if child.name == ".label":
                    continue
                target = self.home / child.name
                if child.is_dir():
                    shutil.copytree(child, target)
                else:
                    shutil.copy2(child, target)
        (self.home / ".on").write_text("1", encoding="utf-8")
        return {"name": picked, "status": self.status()}

    def run(self, command: str, timeout: float = 120) -> dict:
        command = (command or "").strip()
        if not command:
            return {"ok": False, "error": "Say what command to run."}
        if len(command) > 500:
            return {"ok": False, "error": "That command is too long."}
        self.up()
        env = {
            k: v for k, v in os.environ.items()
            if k not in _SECRET_ENV and not k.endswith(("_API_KEY", "_TOKEN", "_SECRET", "_PASSWORD"))
        }
        try:
            done = subprocess.run(
                command, shell=True, cwd=self.home, env=env,
                capture_output=True, text=True, timeout=max(1.0, min(timeout, 120.0)),
            )
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "The command took too long."}
        return {
            "ok": done.returncode == 0,
            "code": done.returncode,
            "stdout": done.stdout[-8000:],
            "stderr": done.stderr[-8000:],
            "note": "This ran as you, in the private folder.",
        }

    def handoff(self, src: str, dest: str, approve: bool = False) -> dict:
        return {"ok": False, "error": "Copying files out of this folder is not available yet."}

    def click(self, x: int, y: int, button: str = "left", count: int = 1) -> dict:
        return {"ok": False, "error": "This computer has no screen."}

    def type_text(self, text: str) -> dict:
        return {"ok": False, "error": "This computer has no screen."}

    def key(self, keys: str) -> dict:
        return {"ok": False, "error": "This computer has no screen."}


_BUILTIN: BuiltinVirtual | None = None


def _builtin() -> BuiltinVirtual:
    global _BUILTIN
    home = Path(config.DATA_DIR) / "virtual"
    if _BUILTIN is None or _BUILTIN.home != home:
        _BUILTIN = BuiltinVirtual(home)
    return _BUILTIN


def _room():
    return _import_room() or _builtin()


def _local_call(action: str, body: dict | None = None) -> dict:
    room = _room()
    body = body or {}
    if action == "status":
        return {"available": True, **room.status()}
    if action == "up":
        return room.up()
    if action == "down":
        return room.down()
    if action == "checkpoint":
        return room.checkpoint(body.get("label") or "")
    if action == "reset":
        return room.reset(body.get("name"))
    if action == "run":
        return room.run(body.get("command") or "", float(body.get("timeout") or 120))
    if action == "click":
        return room.click(body["x"], body["y"], body.get("button", "left"), body.get("count", 1))
    if action == "type":
        return room.type_text(body.get("text") or "")
    if action == "key":
        return room.key(body.get("keys") or "")
    if action == "handoff":
        return room.handoff(body.get("src") or "", body.get("dest") or "", bool(body.get("approve")))
    raise HTTPException(404, "Unknown virtual computer action")


@router.get("/status")
async def status():
    if getattr(config, "TRY_URL", ""):
        r = await _remote("GET", "/api/status")
        if r.status_code >= 400:
            raise HTTPException(r.status_code, r.text)
        return {"available": True, **r.json()}
    return {"available": True, **_local_call("status")}


@router.post("/up")
async def up():
    if getattr(config, "TRY_URL", ""):
        r = await _remote("POST", "/api/up", {})
        return r.json()
    return _local_call("up")


@router.post("/down")
async def down():
    if getattr(config, "TRY_URL", ""):
        return (await _remote("POST", "/api/down", {})).json()
    return _local_call("down")


@router.post("/checkpoint")
async def checkpoint(request: Request):
    body = await request.json()
    if getattr(config, "TRY_URL", ""):
        return (await _remote("POST", "/api/checkpoint", body)).json()
    return _local_call("checkpoint", body)


@router.post("/reset")
async def reset(request: Request):
    body = await request.json()
    if getattr(config, "TRY_URL", ""):
        return (await _remote("POST", "/api/reset", body)).json()
    return _local_call("reset", body)


@router.post("/click")
async def click(request: Request):
    body = await request.json()
    if getattr(config, "TRY_URL", ""):
        return (await _remote("POST", "/api/click", body)).json()
    return _local_call("click", body)


@router.post("/type")
async def type_text(request: Request):
    body = await request.json()
    if getattr(config, "TRY_URL", ""):
        return (await _remote("POST", "/api/type", body)).json()
    return _local_call("type", body)


@router.post("/key")
async def key(request: Request):
    body = await request.json()
    if getattr(config, "TRY_URL", ""):
        return (await _remote("POST", "/api/key", body)).json()
    return _local_call("key", body)


@router.post("/run")
async def run(request: Request):
    body = await request.json()
    if getattr(config, "TRY_URL", ""):
        return (await _remote("POST", "/api/run", body)).json()
    return _local_call("run", body)


@router.post("/handoff")
async def handoff(request: Request):
    body = await request.json()
    if getattr(config, "TRY_URL", ""):
        return (await _remote("POST", "/api/handoff", body)).json()
    return _local_call("handoff", body)


@router.get("/screenshot")
async def screenshot():
    if getattr(config, "TRY_URL", ""):
        r = await _remote("GET", "/api/screenshot")
        return Response(r.content, media_type="image/png", headers={"Cache-Control": "no-store"})
    room = _room()
    if not hasattr(room, "screenshot"):
        raise HTTPException(404, "This virtual computer has no screen.")
    path = room.screenshot()
    return Response(Path(path).read_bytes(), media_type="image/png", headers={"Cache-Control": "no-store"})
