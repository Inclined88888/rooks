"""Try Room: a disposable computer on this machine for the agent to try things.

Runs in-process when the `rooks_try` package is installed (the usual desktop install).
Optionally proxies to a separate `rooks-try serve` when TRY_URL is set.
"""

from __future__ import annotations

import os
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response

from . import config
from .security import require_user

router = APIRouter(prefix="/api/try", dependencies=[Depends(require_user)])

_ROOM = None


def enabled() -> bool:
    if getattr(config, "TRY_URL", "") and getattr(config, "TRY_API_KEY", ""):
        return True
    return _import_room() is not None


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
        raise HTTPException(503, "Try Room is not running on this computer.")
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            return await client.request(
                method, f"{url}{path}", json=json,
                headers={"Authorization": f"Bearer {key}"} if key else {},
            )
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"Try Room unreachable: {exc}") from exc


def _local_call(action: str, body: dict | None = None) -> dict:
    room = _import_room()
    if room is None:
        raise HTTPException(503, "Try Room is not installed on this computer. Re-run the installer.")
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
    raise HTTPException(404, "Unknown Try Room action")


@router.get("/status")
async def status():
    if getattr(config, "TRY_URL", ""):
        r = await _remote("GET", "/api/status")
        if r.status_code >= 400:
            raise HTTPException(r.status_code, r.text)
        return {"available": True, **r.json()}
    if not enabled():
        return {"available": False, "note": "Try Room is not installed on this computer yet."}
    return _local_call("status")


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
    room = _import_room()
    if room is None:
        raise HTTPException(503, "Try Room is not installed on this computer.")
    path = room.screenshot()
    return Response(Path(path).read_bytes(), media_type="image/png", headers={"Cache-Control": "no-store"})
