"""MCP server on stdio for the Room.

A copy out of the Room (`handoff`) needs a person's yes, and the calling agent can never give it: the server asks the
person itself with MCP elicitation (as Rooks Desk does). A client that cannot ask gets "waiting for a person" and
nothing is copied; the person can hand the file off from the Rooks app (Needs you) or with /room handoff in rooks.
"""

from __future__ import annotations

import base64
import itertools
import json
import sys
import threading

from . import __version__
from .room import TryRoom

PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")

TOOLS = [
    {"name": "status", "description": "Is the Room running, what it really is (screen, pointer, isolation, label), its saved points.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "up", "description": "Start the Room on this computer: a private desktop, a Linux guest, or a private folder and shell. The host desktop stays alone; status says which it is.",
     "inputSchema": {"type": "object", "properties": {
         "driver": {"type": "string", "enum": ["auto", "qemu", "nested", "shell"]},
         "offline": {"type": "boolean", "default": False}}}},
    {"name": "down", "description": "Stop the Room.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "checkpoint", "description": "Save a restore point of the Room's home (the 20 newest are kept).",
     "inputSchema": {"type": "object", "properties": {"label": {"type": "string"}}}},
    {"name": "reset", "description": "Roll the Room back to a saved point (latest if omitted).",
     "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}}}},
    {"name": "screenshot", "description": "PNG of the Room's screen (not the host desktop). Only when status says screen is true.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "click", "description": "Click inside the Room at screenshot pixels. Only when status says pointer is true.",
     "inputSchema": {"type": "object", "properties": {
         "x": {"type": "number"}, "y": {"type": "number"},
         "button": {"type": "string", "enum": ["left", "right", "middle"]},
         "count": {"type": "integer", "default": 1}}, "required": ["x", "y"]}},
    {"name": "drag", "description": "Drag inside the Room.",
     "inputSchema": {"type": "object", "properties": {
         "x1": {"type": "number"}, "y1": {"type": "number"},
         "x2": {"type": "number"}, "y2": {"type": "number"}}, "required": ["x1", "y1", "x2", "y2"]}},
    {"name": "scroll", "description": "Scroll inside the Room.",
     "inputSchema": {"type": "object", "properties": {
         "x": {"type": "number"}, "y": {"type": "number"}, "dy": {"type": "integer", "default": -3},
     }, "required": ["x", "y"]}},
    {"name": "type", "description": "Type text inside the Room.",
     "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
    {"name": "key", "description": "Press a key combo inside the Room (e.g. ctrl+s, Return).",
     "inputSchema": {"type": "object", "properties": {"keys": {"type": "string"}}, "required": ["keys"]}},
    {"name": "run", "description": "Run a shell command inside the Room's home as the person (not on the host desktop). The result says how separate it was (isolation) and what ran it (shell: \"sh\" for a POSIX shell, \"cmd\" for Windows Command Prompt).",
     "inputSchema": {"type": "object", "properties": {
         "command": {"type": "string"}, "timeout": {"type": "number", "default": 120}}, "required": ["command"]}},
    {"name": "handoff", "description": "Copy a file out of the Room onto this computer. The person is asked; nothing is copied without their yes, and you cannot answer for them.",
     "inputSchema": {"type": "object", "properties": {
         "src": {"type": "string"}, "dest": {"type": "string"}},
         "required": ["src", "dest"]}},
]

ASK_TIMEOUT_S = 900  # how long a question to the person may stay open before it counts as a no

NO_ASK = ("Nothing was copied. The copy is waiting for a person, and this program cannot ask them here. Tell them: they "
          "can hand the file off from the Rooks app (Needs you) or with /room handoff in rooks.")


class Server:
    def __init__(self, inp=None, out=None) -> None:
        self.room = TryRoom()
        self.inp, self.out = inp or sys.stdin, out or sys.stdout
        self.client_caps: dict = {}
        self.wlock = threading.Lock()
        self.pending: dict[str, tuple[threading.Event, dict]] = {}
        self.ids = itertools.count(1)

    # --- JSON-RPC plumbing: tool calls run on their own thread so a question to the person can be answered meanwhile
    def send(self, msg: dict) -> None:
        with self.wlock:
            self.out.write(json.dumps(msg) + "\n")
            self.out.flush()

    def request(self, method: str, params: dict, timeout: float = ASK_TIMEOUT_S) -> dict | None:
        rid = f"rt-{next(self.ids)}"
        ev, box = threading.Event(), {}
        self.pending[rid] = (ev, box)
        self.send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        ok = ev.wait(timeout)
        self.pending.pop(rid, None)
        return box.get("result") if ok else None

    def serve(self) -> int:
        for line in self.inp:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "method" not in msg and str(msg.get("id")) in self.pending:  # the client's answer to our question
                ev, box = self.pending[str(msg["id"])]
                box["result"] = msg.get("result") or {"action": "decline"}
                ev.set()
                continue
            if msg.get("method") == "tools/call":
                threading.Thread(target=self._reply, args=(msg,), daemon=True).start()
            else:
                self._reply(msg)
        return 0

    def _reply(self, msg: dict) -> None:
        reply = self.handle(msg)
        if reply is not None:
            self.send(reply)

    def ask_person(self, question: str) -> bool:
        """The person's own yes, asked through the client (MCP elicitation). Never the calling agent's word."""
        if "elicitation" not in self.client_caps:
            return False
        r = self.request("elicitation/create", {
            "message": question,
            "requestedSchema": {"type": "object", "properties": {"approve": {"type": "boolean", "title": "Allow this"}},
                                "required": ["approve"]}})
        return bool(r and r.get("action") == "accept" and (r.get("content") or {}).get("approve") is True)

    def handoff(self, src: str, dest: str) -> dict:
        question = f"Copy {src} from the Room to {dest} on this computer?"
        if "elicitation" not in self.client_caps:
            return {"ok": False, "held": True, "waiting_for": "a person", "summary": question, "note": NO_ASK}
        if not self.ask_person(question):
            return {"ok": False, "denied": True, "summary": question,
                    "note": "The person did not say yes. Nothing was copied. Do not try this another way."}
        return self.room.handoff(src, dest, approve=True)

    def handle(self, msg: dict) -> dict | None:
        mid = msg.get("id")
        method = msg.get("method", "")
        params = msg.get("params") or {}
        if method == "initialize":
            self.client_caps = params.get("capabilities") or {}
            return self._ok(mid, {
                "protocolVersion": params.get("protocolVersion") if params.get("protocolVersion") in PROTOCOLS else PROTOCOLS[0],
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "rooks-try", "version": __version__},
            })
        if method == "notifications/initialized":
            return None
        if method == "tools/list":
            return self._ok(mid, {"tools": TOOLS})
        if method == "tools/call":
            return self._ok(mid, self._call(params.get("name", ""), params.get("arguments") or {}))
        if method == "ping":
            return self._ok(mid, {})
        return self._err(mid, f"Unknown method {method}")

    def _call(self, name: str, args: dict) -> dict:
        try:
            if name == "status":
                return self._text(json.dumps(self.room.status(), indent=2))
            if name == "up":
                self.room = TryRoom(prefer=args.get("driver") or "auto", offline=bool(args.get("offline")))
                return self._text(json.dumps(self.room.up(), indent=2))
            if name == "down":
                return self._text(json.dumps(self.room.down(), indent=2))
            if name == "checkpoint":
                return self._text(json.dumps(self.room.checkpoint(args.get("label") or ""), indent=2))
            if name == "reset":
                return self._text(json.dumps(self.room.reset(args.get("name")), indent=2))
            if name == "screenshot":
                path = self.room.screenshot()
                data = path.read_bytes()
                return {"content": [
                    {"type": "text", "text": f"Room screen saved ({path})"},
                    {"type": "image", "data": base64.b64encode(data).decode(), "mimeType": "image/png"},
                ]}
            if name == "click":
                return self._text(json.dumps(self.room.click(args["x"], args["y"], args.get("button", "left"), args.get("count", 1))))
            if name == "drag":
                return self._text(json.dumps(self.room.drag(args["x1"], args["y1"], args["x2"], args["y2"])))
            if name == "scroll":
                return self._text(json.dumps(self.room.scroll(args["x"], args["y"], args.get("dy", -3))))
            if name == "type":
                return self._text(json.dumps(self.room.type_text(args["text"])))
            if name == "key":
                return self._text(json.dumps(self.room.key(args["keys"])))
            if name == "run":
                return self._text(json.dumps(self.room.run(args["command"], float(args.get("timeout") or 120)), indent=2))
            if name == "handoff":
                # an "approve" the agent sends is ignored: only the person's answer to ask_person counts
                return self._text(json.dumps(self.handoff(str(args["src"]), str(args["dest"])), indent=2))
            return self._text(f"Unknown tool {name}", error=True)
        except Exception as exc:  # noqa: BLE001
            return self._text(str(exc), error=True)

    def _text(self, text: str, error: bool = False) -> dict:
        return {"content": [{"type": "text", "text": text}], "isError": error}

    def _ok(self, mid, result):
        return {"jsonrpc": "2.0", "id": mid, "result": result}

    def _err(self, mid, message):
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": message}}


def main() -> int:
    return Server().serve()
