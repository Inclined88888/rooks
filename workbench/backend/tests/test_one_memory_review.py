"""Review of the one-memory step (branch cleanup/workplace): each test failed on the tree before its fix.

* the `ws` terminal chat client's login and memory commands reach the app again with the Terminal access token
* a memory marked sensitive never reaches a cloud model through chat's search_memory tool, project context, the
  learner's "already known" list or the bridge's /v1/rooks/memory
* the one-time move keeps a decision made on the Memory page (a replaced copy of an old fact stays replaced)
* a pinned fact is never silently replaced by an unpinned guess; it becomes a question instead
* forgetting a newer fact brings back the one it replaced, so nothing is stored that no screen shows
* only text that carries a secret is refused or dropped, not every sentence with "secretary" or "token" in it
* correcting a memory on the Memory page cannot put a key into it
"""

import importlib.machinery
import importlib.util
import io
import sqlite3
import urllib.error
import uuid
from pathlib import Path

import pytest
from conftest import CALLS, SCRIPT, events, tool_call
from test_one_memory import OLD_ADAPT_FACTS, OLD_MEMORIES

WS = Path(__file__).resolve().parents[3] / "cli" / "ws"


@pytest.fixture
def fresh(client, tmp_path, monkeypatch):
    """A database of its own, so rules about one predicate are not disturbed by facts other tests left."""
    from app import config, db, knowledge
    from app.knowledge import crypto, schema

    path = tmp_path / "workbench.db"
    monkeypatch.setattr(config, "DB_PATH", path)
    db._local.conn = None
    schema.reset_ready()
    crypto.reset_cache()
    db.init()
    knowledge.ensure()
    try:
        yield path
    finally:
        if getattr(db._local, "conn", None) is not None:
            db._local.conn.close()
        db._local.conn = None
        monkeypatch.undo()
        schema.reset_ready()
        crypto.reset_cache()


# 1. The ws terminal chat client ------------------------------------------------------------------------------------
def _ws(tmp_path, anon):
    """cli/ws, loaded as a module, talking to the app through a client that has no session cookie."""
    loader = importlib.machinery.SourceFileLoader("ws_review", str(WS))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    module.CONFIG = str(tmp_path / "ws" / "cli.json")

    def urlopen(req, timeout=None):
        path = req.full_url.split("://", 1)[1].split("/", 1)[1]
        r = anon.request(req.get_method(), "/" + path, headers=dict(req.header_items()), content=req.data)
        if r.status_code >= 400:
            raise urllib.error.HTTPError(req.full_url, r.status_code, r.reason_phrase, r.headers, io.BytesIO(r.content))
        return io.BytesIO(r.content)

    module.urllib.request.urlopen = urlopen
    return module


def test_ws_login_and_memory_work_with_the_terminal_token(client, tmp_path, monkeypatch, capsys):
    from fastapi.testclient import TestClient

    from app import main

    token = client.post("/api/cli-token").json()["token"]
    assert client.post("/api/knowledge/memories", json={"content": "Files expenses in Concur by the 25th"}).status_code == 200
    assert client.post("/api/knowledge/memories",
                       json={"content": "Sees a cardiologist every March", "privacy": "sensitive"}).status_code == 200
    anon = TestClient(main.app)
    assert anon.get("/api/memories").status_code == 401, "no token, no memories"
    ws = _ws(tmp_path, anon)
    monkeypatch.setattr(ws.getpass, "getpass", lambda prompt="": token)
    ws.main(["login", "http://testserver"])
    assert "Logged in." in capsys.readouterr().out
    ws.main(["memory"])
    out = capsys.readouterr().out
    assert "Files expenses in Concur by the 25th" in out
    assert "cardiologist" not in out, "a sensitive memory stays on the Memory page"
    ws.main(["memory", "Concur expenses"])
    assert "Concur" in capsys.readouterr().out


# 2. Sensitive memories never reach a cloud model -------------------------------------------------------------------
def test_a_sensitive_memory_is_not_given_to_a_cloud_model_by_any_path(client):
    from app import assistant, db, projects
    from app.knowledge import facts

    db.set_setting("learning_enabled", "1")
    r = client.post("/api/knowledge/memories", json={"content": "Has a diagnosis of type 1 diabetes", "privacy": "sensitive"})
    assert r.status_code == 200
    assert facts.context_block("diabetes diagnosis") == "" or "diabetes" not in facts.context_block("diabetes diagnosis")
    assert not any("diabetes" in m["content"] for m in assistant.search_memories("diabetes diagnosis"))
    # the chat tool, on the test's cloud model
    CALLS.clear()
    SCRIPT[:] = [tool_call("search_memory", {"query": "diabetes diagnosis"}), {"role": "assistant", "content": "ok"}]
    events(client.post("/api/assistant/chat", json={"message": "what do you know about my diabetes diagnosis?"}))
    sent = " ".join(str(m.get("content")) for c in CALLS for m in c["messages"])
    assert "type 1 diabetes" not in sent
    # project context, the terminal's /memory and the learner's "already known" list
    assert not any("diabetes" in f["content"] for f in projects.related_facts(
        {"name": "Diabetes", "keywords": "diabetes, diagnosis", "description": "type 1 diabetes"}))
    assert not any("diabetes" in f["content"] for f in facts.all_facts())


def test_the_bridge_memory_list_leaves_sensitive_memories_out(client, monkeypatch):
    from app import config

    key = "k" * 32
    monkeypatch.setattr(config, "BROWSER_API_KEY", key)
    client.post("/api/knowledge/memories", json={"content": "Takes leave for IVF appointments", "privacy": "sensitive"})
    client.post("/api/knowledge/memories", json={"content": "Takes the 7:40 train from Strathfield"})
    shown = [f["content"] for f in client.get("/v1/rooks/memory", headers={"Authorization": f"Bearer {key}"}).json()["facts"]]
    assert "Takes the 7:40 train from Strathfield" in shown
    assert not any("IVF" in s for s in shown)


def test_a_local_model_may_search_a_sensitive_memory(client):
    """The prompt block lets a model on this computer see sensitive memories; the search tool does the same."""
    from app import assistant, db

    # switched off, so no other test's chat is routed to it; only its residency matters here
    cid = db.run("INSERT INTO connections(name, auth_kind, protocol, base_url, residency, enabled, created_at) "
                 "VALUES ('Here', 'openai_compatible', 'chat_completions', 'http://127.0.0.1:1/v1', 'local', 0, ?)", db.now())
    try:
        client.post("/api/knowledge/memories", json={"content": "Takes sertraline every morning", "privacy": "sensitive"})
        ctx = assistant.Ctx(channel="web", conversation_id=0, model=f"{cid}/small")
        assert any("sertraline" in m["content"] for m in assistant.search_memories("sertraline morning", ctx=ctx))
        assert not any("sertraline" in m["content"] for m in assistant.search_memories("sertraline morning"))
    finally:
        db.run("DELETE FROM connections WHERE id = ?", cid)


# 3. The move keeps the Memory page's decision ----------------------------------------------------------------------
def test_the_move_keeps_a_replaced_copy_replaced(client, tmp_path, monkeypatch):
    from app import config, db, knowledge
    from app.knowledge import crypto, memory, schema
    from app.security import encrypt

    path = tmp_path / "workbench.db"
    monkeypatch.setattr(config, "DB_PATH", path)
    db._local.conn = None
    schema.reset_ready()
    crypto.reset_cache()
    try:
        c = db.conn()
        c.executescript(db.SCHEMA)
        c.executescript(OLD_MEMORIES + OLD_ADAPT_FACTS)
        c.execute("PRAGMA user_version = 4")
        schema.migrate(c, path, upto=3)
        a, b = "2025-02-01T08:00:00+00:00", "2025-06-15T10:30:00+00:00"
        c.execute("INSERT INTO adapt_facts(content_enc, category, source, confidence, pinned, created_at, updated_at) "
                  "VALUES (?, 'about', 'chat', 0.8, 0, ?, ?)", (encrypt("Lives in Sydney"), a, a))
        sydney = c.execute("SELECT id FROM adapt_facts").fetchone()[0]
        ins = ("INSERT INTO kn_memories(uid, tier, content_enc, fingerprint, predicate, source_kind, source_ref, status, "
               "superseded_by, observed_at, created_at, updated_at) VALUES (?, 'profile', ?, ?, 'lives_in', ?, ?, ?, ?, ?, ?, ?)")
        new = c.execute(ins, (uuid.uuid4().hex, crypto.seal("Lives in Melbourne"), memory.fingerprint("Lives in Melbourne"),
                              "user", "", "active", None, b, b, b)).lastrowid
        c.execute(ins, (uuid.uuid4().hex, crypto.seal("Lives in Sydney"), memory.fingerprint("Lives in Sydney"),
                        "adapter", f"adapt_fact:{sydney}", "superseded", new, a, a, b))
        c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        c.close()
        db._local.conn = None
        schema.reset_ready()

        db.init()
        knowledge.ensure()

        assert [m["content"] for m in knowledge.list_memories()] == ["Lives in Melbourne"], "the person's decision stands"
        every = [m["content"] for m in knowledge.list_memories(status="")]
        assert every.count("Lives in Sydney") == 1, every
    finally:
        if getattr(db._local, "conn", None) is not None:
            db._local.conn.close()
        db._local.conn = None
        monkeypatch.undo()
        schema.reset_ready()
        crypto.reset_cache()


# 4. A pinned fact is not silently replaced by a guess ---------------------------------------------------------------
def test_a_pinned_fact_is_not_replaced_by_an_unpinned_guess(fresh):
    from app.knowledge import facts, memory

    nurse = facts.add("Is a nurse at St Vincent's hospital", "about", "chat", confidence=0.9, pinned=True)
    guess = facts.add("Their manager is a stickler for deadlines", "fact", "chat")
    assert guess["outcome"] == "conflict", "a question for the person, not a silent swap"
    assert "Is a nurse at St Vincent's hospital" in [f["content"] for f in facts.all_facts()]
    assert [c["old"]["id"] for c in memory.conflicts()] == [nurse["id"]]
    # a newer pinned fact told in chat still replaces it (chat's remember pins what you say about yourself)
    moved = facts.add("Is a midwife at the Royal Women's", "about", "chat", confidence=0.9, pinned=True)
    assert moved["outcome"] == "superseded"


# 5. Forgetting a newer fact brings back the one it replaced --------------------------------------------------------
def test_forgetting_the_newer_fact_brings_back_the_older_one(fresh):
    from app.knowledge import facts, memory

    old = facts.add("Lives in Parramatta", "about", "chat", pinned=True)
    new = facts.add("Moved to Penrith", "about", "chat", pinned=True)
    assert new["outcome"] == "superseded"
    facts.delete(new["id"])
    shown = [f["content"] for f in facts.all_facts()]
    assert shown == ["Lives in Parramatta"], "nothing is kept that no screen shows"
    assert memory.get(old["id"])["status"] == "active"
    assert any("Parramatta" in m["content"] for m in memory.list_()), "on the Memory page again"


def test_forgetting_a_middle_version_keeps_the_newest_in_use(fresh):
    from app.knowledge import facts, memory

    a = facts.add("Lives in Parramatta", "about", "chat", pinned=True)
    b = facts.add("Moved to Penrith", "about", "chat", pinned=True)
    c = facts.add("Moved to Katoomba", "about", "chat", pinned=True)
    facts.delete(b["id"])  # history, not what is in use
    assert [f["content"] for f in facts.all_facts()] == ["Moved to Katoomba"]
    assert memory.get(a["id"])["superseded_by"] == c["id"], "the older one still points at what replaced it"
    assert [r["content"] for r in memory.why(c["id"])["replaced"]] == ["Lives in Parramatta"]


def test_undo_of_a_chat_remember_brings_back_what_it_replaced(fresh):
    from app import assistant
    from app.knowledge import facts

    assistant._remember("Works at Westpac", "profile")
    assistant._remember("Works at Commonwealth Bank", "profile")
    newest = next(f for f in facts.all_facts() if "Commonwealth" in f["content"])
    facts.delete(newest["id"])
    assert [f["content"] for f in facts.all_facts()] == ["Works at Westpac"]


# 6 and 10. Only text that carries a secret is refused or dropped ---------------------------------------------------
def test_ordinary_words_like_secretary_are_remembered(fresh):
    from app import assistant
    from app.knowledge import facts

    assert assistant._remember("Works as a legal secretary at Baker McKenzie", "profile")["saved"]
    assert assistant._remember("Prefers token rings over pins", "preference")["saved"]
    with pytest.raises(Exception):
        assistant._remember("My bank password is hunter2")
    with pytest.raises(Exception):
        assistant._remember("Their PIN 4471 opens the side door")
    shown = [f["content"] for f in facts.all_facts()]
    assert "Works as a legal secretary at Baker McKenzie" in shown and "Prefers token rings over pins" in shown


def test_the_move_keeps_facts_that_only_mention_a_secret_word(client, tmp_path, monkeypatch):
    from app import config, db, knowledge
    from app.knowledge import crypto, schema

    path = tmp_path / "workbench.db"
    monkeypatch.setattr(config, "DB_PATH", path)
    db._local.conn = None
    schema.reset_ready()
    crypto.reset_cache()
    try:
        c = db.conn()
        c.executescript(db.SCHEMA)
        c.executescript(OLD_MEMORIES)
        c.execute("PRAGMA user_version = 4")
        at = "2025-01-01T00:00:00+00:00"
        for text in ("I work as a legal secretary", "Prefers token rings over pins", "My bank password is hunter2"):
            c.execute("INSERT INTO memories(content, kind, source, created_at, updated_at) VALUES (?, 'fact', 'auto', ?, ?)",
                      (text, at, at))
        c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        c.close()
        db._local.conn = None
        schema.reset_ready()

        db.init()
        knowledge.ensure()
        kept = sorted(m["content"] for m in knowledge.list_memories(status=""))
        assert kept == ["I work as a legal secretary", "Prefers token rings over pins"]
        assert "hunter2" not in "\n".join(sqlite3.connect(path).iterdump())
    finally:
        if getattr(db._local, "conn", None) is not None:
            db._local.conn.close()
        db._local.conn = None
        monkeypatch.undo()
        schema.reset_ready()
        crypto.reset_cache()


# 7. A correction cannot put a key into memory ----------------------------------------------------------------------
def test_correcting_a_memory_cannot_store_a_key(client):
    r = client.post("/api/knowledge/memories", json={"content": "Uses the shared finance mailbox"})
    mid = r.json()["memory"]["id"]
    key = "sk-ant-" + "A" * 24
    r = client.patch(f"/api/knowledge/memories/{mid}", json={"content": f"My key is {key}"})
    assert r.status_code == 400
    assert client.get("/api/knowledge/memories").json() and not any(
        key in m["content"] for m in client.get("/api/knowledge/memories", params={"status": ""}).json())
