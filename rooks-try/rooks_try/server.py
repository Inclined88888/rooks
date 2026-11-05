"""Tiny HTTP API so the Rooks app can start, watch and drive the Try Room on loopback."""

from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from . import __version__
from .room import TryRoom

API_KEY = os.environ.get("ROOKS_TRY_API_KEY", "") or os.environ.get("TOOLS_API_KEY", "")


class Handler(BaseHTTPRequestHandler):
    room: TryRoom

    def log_message(self, fmt: str, *args) -> None:  # quieter than the default
        pass

    def _auth(self) -> bool:
        if not API_KEY:
            return True
        auth = self.headers.get("Authorization", "")
        return auth == f"Bearer {API_KEY}"

    def _json(self, code: int, data) -> None:
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self) -> None:  # noqa: N802
        if not self._auth():
            return self._json(401, {"detail": "Not signed in"})
        path = urlparse(self.path).path
        if path == "/api/status":
            return self._json(200, {"version": __version__, **self.room.status()})
        if path == "/api/screenshot":
            dest = self.room.screenshot()
            data = Path(dest).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return
        return self._json(404, {"detail": "Not found"})

    def do_POST(self) -> None:  # noqa: N802
        if not self._auth():
            return self._json(401, {"detail": "Not signed in"})
        path = urlparse(self.path).path
        body = self._read()
        try:
            if path == "/api/up":
                return self._json(200, self.room.up())
            if path == "/api/down":
                return self._json(200, self.room.down())
            if path == "/api/checkpoint":
                return self._json(200, self.room.checkpoint(body.get("label") or ""))
            if path == "/api/reset":
                return self._json(200, self.room.reset(body.get("name")))
            if path == "/api/click":
                return self._json(200, self.room.click(body["x"], body["y"], body.get("button", "left"), body.get("count", 1)))
            if path == "/api/type":
                return self._json(200, self.room.type_text(body.get("text") or ""))
            if path == "/api/key":
                return self._json(200, self.room.key(body.get("keys") or ""))
            if path == "/api/run":
                return self._json(200, self.room.run(body.get("command") or "", float(body.get("timeout") or 120)))
            if path == "/api/handoff":
                return self._json(200, self.room.handoff(body.get("src") or "", body.get("dest") or "", bool(body.get("approve"))))
        except KeyError as exc:
            return self._json(400, {"detail": f"Missing {exc}"})
        except Exception as exc:  # noqa: BLE001
            return self._json(400, {"detail": str(exc)})
        return self._json(404, {"detail": "Not found"})


def serve(host: str = "127.0.0.1", port: int = 3127, driver: str = "auto", offline: bool = False) -> None:
    Handler.room = TryRoom(prefer=driver, offline=offline)
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"rooks-try listening on http://{host}:{port}", flush=True)
    httpd.serve_forever()
