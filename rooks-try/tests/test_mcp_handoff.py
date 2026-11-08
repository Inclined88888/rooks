"""The Room's MCP server never takes the calling agent's word for a person's yes.

`handoff` copies a file out of the Room onto this computer. The agent calling the tool used to be able to pass
`approve: true` and the copy happened. Now the server asks the person itself (MCP elicitation, as Rooks Desk does);
a client that cannot ask gets "waiting for a person" and nothing is copied. Every test drives the real
`python -m rooks_try mcp` program over stdio, the way rooks and other MCP clients start it.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
from pathlib import Path

import pytest

POSIX = pytest.mark.skipif(sys.platform == "win32", reason="the Room's private shell is POSIX here")


class Client:
    """A scripted MCP client. `answer` is what the person says when the server asks (None: this client cannot ask)."""

    def __init__(self, home: Path, answer: bool | None, accept: bool = True):
        env = {**os.environ, "ROOKS_TRY_HOME": str(home)}
        self.proc = subprocess.Popen([sys.executable, "-m", "rooks_try", "mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, text=True, env=env, cwd=str(Path(__file__).parents[1]))
        self.answer, self.accept = answer, accept
        self.asked: list[dict] = []
        self.replies: queue.Queue = queue.Queue()
        self.n = 0
        threading.Thread(target=self._read, daemon=True).start()
        caps = {"elicitation": {}} if answer is not None else {}
        self.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": caps,
                                    "clientInfo": {"name": "test", "version": "0"}})
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def _send(self, msg: dict) -> None:
        assert self.proc.stdin
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def _read(self) -> None:
        assert self.proc.stdout
        for line in self.proc.stdout:
            msg = json.loads(line)
            if msg.get("method") == "elicitation/create":
                self.asked.append(msg["params"])
                if self.accept:
                    result = {"action": "accept", "content": {"approve": bool(self.answer)}}
                else:
                    result = {"action": "decline"}
                self._send({"jsonrpc": "2.0", "id": msg["id"], "result": result})
            else:
                self.replies.put(msg)

    def request(self, method: str, params: dict) -> dict:
        self.n += 1
        self._send({"jsonrpc": "2.0", "id": self.n, "method": method, "params": params})
        msg = self.replies.get(timeout=60)
        assert msg.get("id") == self.n, msg
        return msg["result"]

    def call(self, name: str, args: dict) -> tuple[bool, str]:
        r = self.request("tools/call", {"name": name, "arguments": args})
        return not r.get("isError"), r["content"][0]["text"]

    def close(self) -> None:
        try:
            self.call("down", {})
        finally:
            assert self.proc.stdin
            self.proc.stdin.close()
            self.proc.wait(timeout=10)


@pytest.fixture()
def home(tmp_path):
    return tmp_path / "try"


def _room_with_a_file(client: Client) -> None:
    ok, text = client.call("up", {"driver": "shell"})
    assert ok, text
    ok, text = client.call("run", {"command": "echo secret > keep.txt"})
    assert ok, text


@POSIX
def test_the_agents_own_approve_flag_copies_nothing_when_the_client_cannot_ask(home, tmp_path):
    c = Client(home, answer=None)
    try:
        _room_with_a_file(c)
        dest = tmp_path / "out" / "keep.txt"
        ok, text = c.call("handoff", {"src": "keep.txt", "dest": str(dest), "approve": True})
        assert not dest.exists(), "the agent's own approve flag copied the file out of the Room"
        out = json.loads(text)
        assert out["ok"] is False and out["waiting_for"] == "a person"
        assert c.asked == []  # nobody could be asked, so nobody was
    finally:
        c.close()


@POSIX
def test_the_agents_own_approve_flag_is_not_a_yes_the_person_is_asked(home, tmp_path):
    c = Client(home, answer=False)
    try:
        _room_with_a_file(c)
        dest = tmp_path / "out" / "keep.txt"
        ok, text = c.call("handoff", {"src": "keep.txt", "dest": str(dest), "approve": True})
        assert not dest.exists(), "copied although the person said no"
        assert len(c.asked) == 1 and "keep.txt" in c.asked[0]["message"]
        assert json.loads(text)["ok"] is False
    finally:
        c.close()


@POSIX
def test_a_declined_question_copies_nothing(home, tmp_path):
    c = Client(home, answer=True, accept=False)
    try:
        _room_with_a_file(c)
        dest = tmp_path / "out" / "keep.txt"
        c.call("handoff", {"src": "keep.txt", "dest": str(dest)})
        assert not dest.exists() and len(c.asked) == 1
    finally:
        c.close()


@POSIX
def test_the_persons_yes_copies_the_file(home, tmp_path):
    c = Client(home, answer=True)
    try:
        _room_with_a_file(c)
        dest = tmp_path / "out" / "keep.txt"
        ok, text = c.call("handoff", {"src": "keep.txt", "dest": str(dest)})
        assert ok and json.loads(text)["ok"] is True, text
        assert dest.read_text().strip() == "secret" and len(c.asked) == 1
    finally:
        c.close()


def test_the_tool_no_longer_offers_an_approve_flag(home):
    c = Client(home, answer=None)
    try:
        tools = {t["name"]: t for t in c.request("tools/list", {})["tools"]}
        assert "approve" not in tools["handoff"]["inputSchema"]["properties"]
    finally:
        assert c.proc.stdin
        c.proc.stdin.close()
        c.proc.wait(timeout=10)
