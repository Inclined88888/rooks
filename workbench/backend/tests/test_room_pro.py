"""The Room for workplace teams: Files and Saved points for everyone; Terminals and the Room's browser are developer tools.

A new install (no setting stored) has both switched off: Settings says so, no terminal socket or Room terminal opens,
the Room's status offers neither, and the assistant is not offered use_room's terminal or browser actions (it never
tries). An install that switched one on keeps it on. The code behind both stays: switched on, everything works as before.
"""

from __future__ import annotations

import asyncio

import pytest

from tests.test_room_browser import room_home  # noqa: F401

KEYS = ("app_terminal", "room_browser")
BROWSER_ACTIONS = ("browse", "page", "shot", "click", "type", "scroll", "key", "back", "tabs")
TERMINAL_ACTIONS = ("start", "tail")


@pytest.fixture()
def fresh(client):
    """A new install: neither switch stored. The session's own settings come back afterwards."""
    from app import db

    saved = {k: db.get_setting(k, None) for k in KEYS}
    db.run("DELETE FROM settings WHERE key IN ('app_terminal', 'room_browser')")
    try:
        yield db
    finally:
        for k, v in saved.items():
            if v is None:
                db.run("DELETE FROM settings WHERE key = ?", k)
            else:
                db.set_setting(k, v)


def _offered_actions(ctx) -> str:
    from app import assistant

    tool = next(t for t in assistant.available_tools(ctx) if t.name == "use_room")
    spec = tool.spec()["function"]
    return spec["parameters"]["properties"]["action"]["description"] + " " + spec["description"]


def _actions_list(ctx) -> list[str]:
    from app import assistant

    tool = next(t for t in assistant.available_tools(ctx) if t.name == "use_room")
    return tool.spec()["function"]["parameters"]["properties"]["action"]["description"].split("|")


def test_a_new_install_has_terminals_and_the_room_browser_off(client, fresh):
    from app import room_browser, terminal_pty

    s = client.get("/api/settings").json()
    assert s["app_terminal"] is False and s["room_browser"] is False
    assert terminal_pty.enabled() is False
    assert room_browser.enabled() is False
    assert client.get("/api/terminal/status").json()["enabled"] is False


def test_an_install_that_switched_them_on_keeps_them_on(client, fresh):
    from app import room_browser, terminal_pty

    fresh.set_setting("app_terminal", "1")
    fresh.set_setting("room_browser", "1")
    s = client.get("/api/settings").json()
    assert s["app_terminal"] is True and s["room_browser"] is True
    assert terminal_pty.enabled() is (__import__("sys").platform != "win32")
    assert room_browser.enabled() is True
    # and switched off again through Settings, off is stored
    assert client.put("/api/settings", json={"app_terminal": False, "room_browser": False}).json()["app_terminal"] is False
    assert fresh.get_setting("app_terminal", "") == "0" and fresh.get_setting("room_browser", "") == "0"


def test_the_rooms_status_offers_no_terminal_and_no_browser_by_default(client, fresh, room_home, monkeypatch):  # noqa: F811
    from app import room_browser
    from rooks_try import browser as rb

    monkeypatch.setattr(room_browser, "_engine", lambda: rb.Engine("/x/chrome", "system"))  # an engine is here
    can = client.get("/api/room/status").json()["can"]
    assert can["files"] is True
    assert can["terminal"] is False and can["browser"] is False
    # a Room terminal is refused by the service itself, not only hidden
    assert client.post("/api/room/up").json()["running"] is True
    assert client.post("/api/room/terminals", json={}).status_code == 409


def test_windows_never_shows_a_terminal_whatever_the_switch(client, fresh, monkeypatch):
    """On Windows there is no pseudo terminal: switched on, off or never set, the Room offers none."""
    import sys
    from types import SimpleNamespace

    from app import room_files, terminal_pty

    driver = SimpleNamespace(name="shell", terminal_argv=lambda home: ["/bin/sh"])
    monkeypatch.setattr(sys, "platform", "win32")
    for value in (None, "0", "1"):
        if value is None:
            fresh.run("DELETE FROM settings WHERE key = 'app_terminal'")
        else:
            fresh.set_setting("app_terminal", value)
        assert terminal_pty.enabled() is False
        assert room_files.can(driver, False)["terminal"] is False


def test_the_assistant_is_not_offered_the_rooms_browser_or_terminals_when_they_are_off(client, fresh, room_home):  # noqa: F811
    from app import assistant, room_browser_tool

    assert set(BROWSER_ACTIONS) == set(room_browser_tool.ACTIONS)
    ctx = assistant.Ctx(channel="web", conversation_id=assistant.new_conversation("web"))
    offered = _actions_list(ctx)
    for a in (*BROWSER_ACTIONS, *TERMINAL_ACTIONS):
        assert a not in offered, f"{a} is not offered with the switches off"
    for a in ("status", "up", "down", "run", "files", "checkpoint", "reset", "handoff"):
        assert a in offered, f"{a} stays"
    text = _offered_actions(ctx)
    assert "browser" not in text.lower() and "Room terminal" not in text and "tail" not in text

    fresh.set_setting("room_browser", "1")
    offered = _actions_list(ctx)
    assert all(a in offered for a in BROWSER_ACTIONS) and not any(a in offered for a in TERMINAL_ACTIONS)

    fresh.set_setting("app_terminal", "1")
    fresh.set_setting("room_browser", "0")
    offered = _actions_list(ctx)
    expect_terminal = __import__("sys").platform != "win32"
    assert all((a in offered) is expect_terminal for a in TERMINAL_ACTIONS)
    assert not any(a in offered for a in BROWSER_ACTIONS)

    fresh.set_setting("room_browser", "1")
    offered = _actions_list(ctx)
    assert all(a in offered for a in BROWSER_ACTIONS)


def test_a_browser_or_terminal_call_that_comes_anyway_is_refused_without_trying(client, fresh, room_home, monkeypatch):  # noqa: F811
    from app import assistant, room_browser_tool, room_terminal

    tried: list[str] = []

    async def no_browser(*a, **k):
        tried.append("browser")
        return {"ok": True}

    async def no_terminal(*a, **k):
        tried.append("terminal")
        raise AssertionError("no terminal opens")

    monkeypatch.setattr(room_browser_tool, "run", no_browser)
    monkeypatch.setattr(room_terminal, "open_terminal", no_terminal)
    for action in ("browse", "page", "start", "tail"):
        out = asyncio.run(assistant._use_room(action, address="example.com", command="sleep 1"))
        assert out.get("ok") is False and "switched off" in out.get("error", ""), (action, out)
    assert tried == []
