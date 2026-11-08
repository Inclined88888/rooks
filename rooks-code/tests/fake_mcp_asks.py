"""A stdio MCP server for tests that asks the person before it acts (MCP elicitation), as rooks-try's handoff does.

Tool `copy_out`: when the client said it can ask the person, the server sends elicitation/create and copies only on an
accepted yes. A client that cannot ask gets WAITING FOR A PERSON. The server never takes an `approve` argument."""

import json
import sys

caps = {}


def send(msg):
    print(json.dumps(msg), flush=True)


def read():
    line = sys.stdin.readline()
    return json.loads(line) if line else None


while True:
    msg = read()
    if msg is None:
        break
    if "id" not in msg:
        continue
    if msg["method"] == "initialize":
        caps = msg["params"].get("capabilities") or {}
        result = {"protocolVersion": msg["params"]["protocolVersion"], "capabilities": {"tools": {}},
                  "serverInfo": {"name": "asks", "version": "1"}}
    elif msg["method"] == "tools/list":
        result = {"tools": [{"name": "copy_out", "description": "Copy a file out, after the person says yes",
                             "inputSchema": {"type": "object", "properties": {"src": {"type": "string"}},
                                             "required": ["src"]}}]}
    elif msg["method"] == "tools/call":
        src = msg["params"]["arguments"].get("src", "")
        if "elicitation" not in caps:
            text = "WAITING FOR A PERSON"
        else:
            send({"jsonrpc": "2.0", "id": "ask-1", "method": "elicitation/create", "params": {
                "message": f"Copy {src} out of the Room?",
                "requestedSchema": {"type": "object", "properties": {"approve": {"type": "boolean"}},
                                    "required": ["approve"]}}})
            answer = read()
            while answer is not None and answer.get("id") != "ask-1":
                answer = read()
            r = (answer or {}).get("result") or {}
            ok = r.get("action") == "accept" and (r.get("content") or {}).get("approve") is True
            text = f"COPIED {src}" if ok else "NOT COPIED: the person said no"
        result = {"content": [{"type": "text", "text": text}]}
    else:
        send({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "no such method"}})
        continue
    send({"jsonrpc": "2.0", "id": msg["id"], "result": result})
