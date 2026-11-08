"""The assistant in the Room's browser (design 0007, sections 1.5 and 3): use_room's browser actions and what waits.

use_room gains browse, page, shot, click, type, scroll, key, back and tabs. page, shot and tabs only look (never asked,
never deduplicated); the rest ask first like every other Room action. On top of that, some steps wait for a yes in Needs
you that the chat tool cannot give itself:

* a purchase, on any site (the words, or a form with card fields);
* a submit or a message on a site the person did not ask for. Asked sites are the hosts in the person's own messages in
  this conversation and the hosts they typed into the Room browser's address bar. Page text, tool results and the
  rooks terminal's key never add one;
* a click that lands on a frame from another site, which the snapshot cannot read.

The assistant never types into a password field. The run log keeps the host and path (no query), the element's name and
"(N characters)" for typing, never the text. While the assistant acts the window says so, and the person's own input
takes the browser back.

The tests that need a real Chromium start one (Playwright's, or the system's) and skip when none can start here.
"""

from __future__ import annotations

import asyncio
import http.server
import json
import threading
import time

import pytest

from tests.test_room_browser import _page, _wait_page, chromium, local, on, room_home  # noqa: F401 - shared fixtures

pytestmark = pytest.mark.skipif(__import__("sys").platform == "win32", reason="the Room's browser is not on Windows yet")

SHOP = """<!doctype html><title>Shop</title>
<body style="margin:0;font:16px sans-serif">
<p>Notes on this page name other places: evil.example and {host} and shop.invalid.</p>
<a href="second.html">Next page</a>
<button type="button" onclick="document.getElementById('out').textContent='bought-' + (40+2)">Add to cart</button>
<form action="search.html"><input name="q" aria-label="Search words"><button type="submit">Search</button></form>
<form action="pay.html"><input name="cc" aria-label="Card number"><button type="submit">Continue</button></form>
<form action="in.html"><input name="u" aria-label="User name"><input type="password" name="p" aria-label="Password">
  <button type="submit">Sign in</button></form>
<iframe title="other" src="{frame}" style="display:block;width:320px;height:120px;border:0"></iframe>
<p id="out">waiting</p>
</body>"""
FRAME = """<!doctype html><title>Frame</title><body style="margin:0">
<button style="width:320px;height:120px" onclick="parent.postMessage('frame-clicked','*')">Pay now</button></body>"""


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def _serve(folder):
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), lambda *a, **k: _Quiet(*a, directory=str(folder), **k))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


@pytest.fixture()
def shop(tmp_path):
    """A small shop on 127.0.0.1, with a frame from another site (localhost on another port)."""
    other = tmp_path / "other"
    other.mkdir()
    (other / "frame.html").write_text(FRAME)
    osrv = _serve(other)
    folder = tmp_path / "shop"
    folder.mkdir()
    srv = _serve(folder)
    port = srv.server_address[1]
    (folder / "shop.html").write_text(SHOP.format(host=f"127.0.0.1:{port}",
                                                  frame=f"http://localhost:{osrv.server_address[1]}/frame.html"))
    for name, words in (("second", "the second page"), ("search", "search results"), ("pay", "paid"),
                        ("in", "signed in")):
        (folder / f"{name}.html").write_text(f"<title>{name}</title><p>{words}</p>")
    yield port
    srv.shutdown()
    osrv.shutdown()


def _ctx(asked: str | None = None, channel: str = "web"):
    """A chat; `asked` is what the person wrote in it (their own message)."""
    from app import assistant

    cid = assistant.new_conversation(channel)
    if asked:
        assistant._save(cid, "user", asked)
    return assistant.Ctx(channel=channel, conversation_id=cid)


_LOOP: list = []


def _run(coro):
    """On one loop that lives as long as the tests, as the app's does: the browser is started from that loop's worker
    thread, and bwrap's --die-with-parent ends it when the thread that started it ends (asyncio.run per call would)."""
    if not _LOOP:
        loop = asyncio.new_event_loop()
        threading.Thread(target=loop.run_forever, daemon=True).start()
        _LOOP.append(loop)
    return asyncio.run_coroutine_threadsafe(coro, _LOOP[0]).result(90)


def _use(ctx, **kw) -> dict:
    from app import assistant

    return _run(assistant._use_room(ctx=ctx, **kw))


def _num(page: dict, name: str) -> int:
    for e in page["elements"]:
        if e["name"] == name:
            return e["id"]
    raise AssertionError(f"no element named {name!r}: {page['elements']}")


def _opened(ctx, port: int) -> dict:
    out = _use(ctx, action="browse", address=f"http://127.0.0.1:{port}/shop.html")
    assert out.get("title") == "Shop", out
    return _use(ctx, action="page")


# --- what asks, without a browser --------------------------------------------------------------------------------------------------
def test_reads_are_never_asked_and_acting_in_the_browser_asks_first(client):
    from app import assistant

    tool = assistant.TOOL_MAP["use_room"]
    for read in ("page", "shot", "tabs"):
        assert read in assistant.ROOM_READS
        assert tool.confirm({"action": read}) == ""
        assert assistant._room_reads("use_room", {"action": read}) is True  # never deduplicated either
    for act in ("browse", "click", "type", "scroll", "key", "back"):
        assert tool.confirm({"action": act}) == assistant.ROOM_CONFIRM
    words = json.dumps(tool.spec())
    for act in ("browse", "page", "shot", "click", "type", "scroll", "key", "back", "tabs"):
        assert act in words


def test_presence_and_needs_you_say_what_the_browser_step_is(client):
    from app import needs_you, presence

    assert presence.plain_step("use_room", {"action": "page"}) == "Looking at a page in the Room's browser"
    assert presence.plain_step("use_room", {"action": "shot"}) == "Looking at a page in the Room's browser"
    assert presence.plain_step("use_room", {"action": "browse", "address": "https://shop.example/a?x=1"}) == \
        "Opening a page in the Room's browser: shop.example"
    assert presence.plain_step("use_room", {"action": "click"}) == "Clicking in the Room's browser"
    typing = presence.plain_step("use_room", {"action": "type", "text": "my secret words"})
    assert typing == "Typing in the Room's browser" and "secret" not in typing
    assert presence.plain_step("use_room", {"action": "tabs"}) == "Checking the Room browser's tabs"
    assert needs_you._title("use_room", {"action": "browse", "address": "https://shop.example/a?x=1"}) == \
        "Open a page in the Room's browser: shop.example"
    assert needs_you._title("use_room", {"action": "type", "text": "my secret words"}) == "Type in the Room's browser"


def test_the_run_log_never_keeps_typed_text_or_a_query(client):
    """The chat tool's own row for a browser step: the text becomes "(N characters)", an address loses its query."""
    from app import actions, assistant, receipts

    ctx = _ctx()
    aid = receipts.record_tool(ctx, "use_room", "ok", None, "", False, 1, effect="external",
                               args=json.dumps({"action": "type", "element": 3, "text": "my secret words"}))
    bid = receipts.record_tool(ctx, "use_room", "ok", None, "", False, 1, effect="external",
                               args=json.dumps({"action": "browse", "address": "https://shop.example/cart?token=abc123#x"}))
    rows = [actions.db.one("SELECT args FROM actions WHERE id = ?", i)["args"] for i in (aid, bid)]
    assert "secret" not in rows[0] and "(15 characters)" in rows[0]
    assert "abc123" not in rows[1] and "token" not in rows[1] and "shop.example/cart" in rows[1]
    assert assistant is not None


# --- with a real browser -------------------------------------------------------------------------------------------------------
def test_browse_page_and_an_ordinary_click(client, chromium, shop):
    ctx = _ctx()  # nothing asked: an ordinary link is still followed
    page = _opened(ctx, shop)
    assert page["url"] == f"http://127.0.0.1:{shop}/shop.html" and "Notes on this page" in page["text"]
    names = [e["name"] for e in page["elements"]]
    assert {"Next page", "Add to cart", "Search words", "Card number", "Password", "Sign in"} <= set(names)
    tabs = _use(ctx, action="tabs")
    assert len(tabs["tabs"]) == 1 and tabs["tabs"][0]["title"] == "Shop"
    shot = _use(ctx, action="shot")
    assert shot["view"] and any(e.get("role") == "frame" and e.get("site") == "localhost" for e in shot["elements"])
    out = _use(ctx, action="click", element=_num(page, "Next page"))
    assert out.get("ok") is True and not out.get("held"), out
    assert "the second page" in _wait_page(client, "the second page")["text"]
    back = _use(ctx, action="back")
    assert back.get("ok") is True, back
    _wait_page(client, "Notes on this page")


def test_a_purchase_waits_for_a_yes_even_on_an_asked_site(client, chromium, shop):
    from app import actions

    ctx = _ctx(asked=f"Please add the lamp to my cart on 127.0.0.1:{shop}")
    page = _opened(ctx, shop)
    out = _use(ctx, action="click", element=_num(page, "Add to cart"))
    assert out["held"] is True and out["why"] == "purchase" and out["request_id"], out
    assert "waiting" in _page(client)["text"]  # nothing was clicked
    item = next(i for i in client.get("/api/needs-you").json() if i["id"] == f"a:{out['action_id']}")
    assert item["kind"] == "room" and item["title"] == "Buy something in the Room's browser: Add to cart"
    # the model passing its own request back does nothing until a person says yes
    again = _use(ctx, action="click", element=_num(page, "Add to cart"), request_id=out["request_id"])
    assert again["held"] is True and "waiting" in _page(client)["text"]
    r = client.post(f"/api/approvals/{out['action_id']}", json={"approve": True})
    assert r.status_code == 200 and r.json()["status"] == "done", r.text
    _wait_page(client, "bought-42")
    assert actions.approval(out["action_id"])["status"] == "done"
    once = _use(ctx, action="click", element=_num(page, "Add to cart"), request_id=out["request_id"])
    assert once.get("ok") is not True or once.get("already") is True  # the yes was for one click, once


def test_card_fields_are_a_purchase_and_password_fields_are_the_persons(client, chromium, shop):
    ctx = _ctx(asked=f"Fill in the form on 127.0.0.1:{shop}")
    page = _opened(ctx, shop)
    card = _use(ctx, action="type", element=_num(page, "Card number"), text="4111 1111 1111 1111")
    assert card["held"] is True and card["why"] == "purchase"
    pw = _use(ctx, action="type", element=_num(page, "Password"), text="hunter2")
    assert pw.get("ok") is False and pw.get("held") is not True
    assert pw["error"] == "I never type passwords. Type it yourself in the Room's Browser window."
    assert "hunter2" not in json.dumps(_page(client))


def test_a_submit_waits_only_on_a_site_the_person_did_not_ask_for(client, chromium, shop):
    from app import assistant

    # asked in this chat: the search runs
    asked = _ctx(asked=f"Search for lamps on 127.0.0.1:{shop} please")
    page = _opened(asked, shop)
    out = _use(asked, action="type", element=_num(page, "Search words"), text="lamp", submit=True)
    assert out.get("ok") is True and not out.get("held"), out
    _wait_page(client, "search results")
    # not asked in this chat: held. The page's own text names the host, and so does a tool result; neither counts
    other = _ctx(asked="Find me a lamp somewhere")
    page = _opened(other, shop)
    assert f"127.0.0.1:{shop}" in page["text"]
    assistant._save(other.conversation_id, "user", f"[I approved request #1: use_room. Result: 127.0.0.1:{shop}]",
                    name="use_room")
    out = _use(other, action="type", element=_num(page, "Search words"), text="lamp", submit=True)
    assert out["held"] is True and out["why"] == "submit", out
    # Enter in a form field is a submit too
    _use(other, action="type", element=_num(page, "Search words"), text="lamp")
    out = _use(other, action="key", key="Enter")
    assert out["held"] is True and out["why"] == "submit", out
    assert "Notes on this page" in _page(client)["text"]
    # the rooks terminal's key opening the site does not ask for it either
    client.post("/api/room/browser/open", json={"address": f"127.0.0.1:{shop}/shop.html"})
    page = _use(other, action="page")
    assert _use(other, action="type", element=_num(page, "Search words"), text="lamp", submit=True)["held"] is True
    # the person typing the address into the Room browser's own address bar does
    r = client.post("/api/room/browser/act", json={"kind": "nav", "action": "go", "address": f"127.0.0.1:{shop}/shop.html"})
    assert r.status_code == 200, r.text
    time.sleep(0.5)
    page = _use(other, action="page")
    assert _use(other, action="type", element=_num(page, "Search words"), text="lamp")["error"] == "The person took the browser."
    other.approved_call = True  # the person's input took it back; their yes to the next step hands it over again
    out = _use(other, action="type", element=_num(page, "Search words"), text="lamp", submit=True)
    assert out.get("ok") is True and not out.get("held"), out


def test_a_click_on_a_frame_from_another_site_waits(client, chromium, shop):
    ctx = _ctx(asked=f"Look around 127.0.0.1:{shop}")
    _opened(ctx, shop)
    shot = _use(ctx, action="shot")
    frame = next(e for e in shot["elements"] if e.get("role") == "frame")
    out = _use(ctx, action="click", x=frame["x"] + 20, y=frame["y"] + 20)
    assert out["held"] is True and out["why"] == "frame", out


def test_the_browser_steps_are_in_the_run_log_without_text_or_query(client, chromium, shop):
    from app import db

    before = db.one("SELECT COALESCE(MAX(id), 0) AS n FROM actions")["n"]
    ctx = _ctx(asked=f"Search on 127.0.0.1:{shop}")
    _use(ctx, action="browse", address=f"http://127.0.0.1:{shop}/shop.html?token=abc123")
    page = _use(ctx, action="page")
    assert _use(ctx, action="type", element=_num(page, "Search words"), text="private lamp words", submit=True)["ok"]
    rows = db.all("SELECT args, detail, evidence FROM actions WHERE id > ? AND tool = 'use_room' ORDER BY id", before)
    text = json.dumps(rows)
    assert "private lamp words" not in text and "abc123" not in text and "token=" not in text
    assert "(18 characters)" in text and "Search words" in text and f"127.0.0.1:{shop}/shop.html" in text


def test_the_window_says_rooks_is_using_it_and_the_persons_input_takes_it_back(client, chromium, shop):
    ctx = _ctx(asked=f"Look around 127.0.0.1:{shop}")
    page = _opened(ctx, shop)
    assert _use(ctx, action="scroll", dy=200).get("ok") is True
    st = client.get("/api/room/browser").json()
    assert st["rooks"] is True and st["rooks_words"] == "Rooks is using the browser"
    r = client.post("/api/room/browser/act", json={"kind": "scroll", "dy": -100})
    assert r.status_code == 200
    st = client.get("/api/room/browser").json()
    assert st["rooks"] is False and st["taken"] is True
    out = _use(ctx, action="click", element=_num(page, "Next page"))
    assert out.get("ok") is False and out["error"] == "The person took the browser."
    assert _use(ctx, action="page").get("taken") is True  # reading still works, and says so


def test_through_the_chat_a_purchase_asks_twice_in_plain_words(client, chromium, shop):
    """The Room's own yes first (This uses the Room), then the purchase's own yes; one click after the second."""
    from app import actions, assistant

    ctx = _ctx(asked=f"Buy the lamp on 127.0.0.1:{shop}")
    page = _opened(ctx, shop)
    ok, msg = _run(assistant.run_tool("use_room", json.dumps({"action": "click", "element": _num(page, "Add to cart")}), ctx))
    assert ok is False
    first = ctx.receipts[-1]["action_id"]
    assert actions.approval(first)["reason"] == assistant.ROOM_CONFIRM
    r = client.post(f"/api/approvals/{first}", json={"approve": True}).json()
    assert r["status"] == "held" and "waiting" in _page(client)["text"]  # the yes ran, and the click only asked again
    held = [a for a in actions.pending(ctx.conversation_id) if a["tool"] == "use_room" and a["id"] != first]
    assert len(held) == 1 and "purchase" in held[0]["reason"].lower()
    r = client.post(f"/api/approvals/{held[0]['id']}", json={"approve": True}).json()
    assert r["status"] == "done", r
    _wait_page(client, "bought-42")
