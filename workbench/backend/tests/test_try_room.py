"""Try Room API: disposable computer on this machine, checkpoints, handoff needs a yes."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3] / "rooks-try"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture()
def try_home(tmp_path, monkeypatch):
    monkeypatch.setenv("ROOKS_TRY_HOME", str(tmp_path / "try"))
    monkeypatch.setenv("ROOKS_TRY_DRIVER", "shell")
    import app.try_proxy as try_proxy

    try_proxy._ROOM = None
    yield tmp_path / "try"
    try_proxy._ROOM = None


def test_virtual_computer_starts_as_a_private_folder_when_the_package_is_missing(client, monkeypatch, tmp_path):
    import app.try_proxy as try_proxy

    monkeypatch.setattr(try_proxy, "_import_room", lambda: None)
    monkeypatch.setattr(try_proxy.config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(try_proxy.config, "TRY_URL", "")
    try_proxy._BUILTIN = None
    st = client.get("/api/try/status").json()
    assert st["available"] is True
    assert st["driver"] == "shell"
    assert st["running"] is False
    up = client.post("/api/try/up").json()
    assert up["running"] is True
    run = client.post("/api/try/run", json={"command": "echo virtual-ok"}).json()
    assert run["ok"] is True
    assert "virtual-ok" in run["stdout"]
    try_proxy._BUILTIN = None


def test_try_status_and_run(client, try_home):
    st = client.get("/api/try/status").json()
    assert st["available"] is True
    up = client.post("/api/try/up").json()
    assert up["running"] is True
    run = client.post("/api/try/run", json={"command": "echo try-ok > hello.txt && cat hello.txt"}).json()
    assert run["ok"] is True
    assert "try-ok" in run["stdout"]


def test_try_checkpoint_reset_and_handoff(client, try_home, tmp_path):
    client.post("/api/try/up")
    client.post("/api/try/run", json={"command": "echo one > mark.txt"})
    cp = client.post("/api/try/checkpoint", json={"label": "snap"}).json()
    assert "name" in cp
    client.post("/api/try/run", json={"command": "echo two > mark.txt"})
    client.post("/api/try/reset", json={"name": cp["name"]})
    again = client.post("/api/try/run", json={"command": "cat mark.txt"}).json()
    assert "one" in again["stdout"]

    asked = client.post("/api/try/handoff", json={"src": "mark.txt", "dest": str(tmp_path / "out.txt"), "approve": False}).json()
    assert asked.get("needs_approval") is True
    done = client.post("/api/try/handoff", json={"src": "mark.txt", "dest": str(tmp_path / "out.txt"), "approve": True}).json()
    assert done["ok"] is True
    assert (tmp_path / "out.txt").read_text().strip() == "one"


def test_surfaces_mentions_try_room(client, try_home):
    body = client.get("/api/surfaces").json()
    assert body.get("local") is True
    assert "try_room" in body
