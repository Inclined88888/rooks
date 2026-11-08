"""One memory (architecture g.2, first row): chat, the Memory page, the terminal and "forget" all use one store.

Before this, chat saved facts to adapt_facts, the Memory page read kn_memories, and the old memories table still
held facts from older installs, so a fact told in chat did not show on the Memory page, and forgetting it on one
screen left it in the prompt through another.
"""

import sqlite3
import uuid

import pytest
from conftest import CALLS, SCRIPT, events, tool_call

KEY = "k" * 32


@pytest.fixture
def auth(monkeypatch):
    from app import config

    monkeypatch.setattr(config, "BROWSER_API_KEY", KEY)
    return {"Authorization": f"Bearer {KEY}"}


def _prompt(client, message="hello") -> str:
    """The system prompt of the next chat turn."""
    CALLS.clear()
    SCRIPT[:] = [{"role": "assistant", "content": "ok"}]
    events(client.post("/api/assistant/chat", json={"message": message}))
    return next(c for c in CALLS if c.get("tools"))["messages"][0]["content"]


def _remember_in_chat(client, content: str, kind: str = "profile") -> None:
    SCRIPT[:] = [tool_call("remember", {"content": content, "kind": kind}), {"role": "assistant", "content": "Noted."}]
    events(client.post("/api/assistant/chat", json={"message": f"Please remember this: {content}"}))


def _on_memory_page(client, text: str) -> list[dict]:
    return [m for m in client.get("/api/knowledge/memories").json() if text in m["content"]]


def test_remember_in_chat_shows_on_the_memory_page_and_in_the_terminal(client, auth):
    _remember_in_chat(client, "Reports to Dana Whitfield in the finance team")
    shown = _on_memory_page(client, "Dana Whitfield")
    assert len(shown) == 1, "a fact told in chat is on the Memory page"
    terminal = client.get("/v1/rooks/memory", headers=auth).json()["facts"]
    assert any("Dana Whitfield" in f["content"] for f in terminal), "and in the terminal's /memory"
    ctx = client.get("/v1/rooks/context", params={"q": "who do I report to?"}, headers=auth).json()["context"]
    assert "Dana Whitfield" in ctx, "and in what the terminal's prompt is given"
    assert "Dana Whitfield" in _prompt(client, "who do I report to?")


def test_forget_on_the_memory_page_is_gone_from_the_next_prompt(client):
    _remember_in_chat(client, "Badge number for the Pitt Street office is 4471")
    m = _on_memory_page(client, "Pitt Street")[0]
    assert "Pitt Street" in _prompt(client, "what is my Pitt Street badge?")
    assert client.delete(f"/api/knowledge/memories/{m['id']}").status_code == 200
    assert "Pitt Street" not in _prompt(client, "what is my Pitt Street badge?")


def test_forget_in_the_terminal_is_gone_from_the_memory_page_and_the_prompt(client, auth):
    _remember_in_chat(client, "Uses ServiceNow queue Facilities North")
    assert _on_memory_page(client, "Facilities North")
    r = client.post("/v1/rooks/forget", headers=auth, json={"text": "Facilities North"})
    assert any("Facilities North" in x for x in r.json()["forgotten"])
    assert not _on_memory_page(client, "Facilities North")
    assert not any("Facilities North" in f["content"] for f in client.get("/v1/rooks/memory", headers=auth).json()["facts"])
    assert "Facilities North" not in _prompt(client, "which ServiceNow queue is Facilities North?")


def test_forget_in_chat_is_gone_from_the_memory_page_and_the_terminal(client, auth):
    _remember_in_chat(client, "Timesheets are due in Workday every Thursday")
    m = _on_memory_page(client, "Workday every Thursday")[0]
    SCRIPT[:] = [tool_call("forget", {"memory_id": m["id"]}), {"role": "assistant", "content": "Forgotten."}]
    events(client.post("/api/assistant/chat", json={"message": "forget the timesheet one"}))
    assert not _on_memory_page(client, "Workday every Thursday")
    assert not any("Workday" in f["content"] for f in client.get("/v1/rooks/memory", headers=auth).json()["facts"])
    assert "Workday every Thursday" not in _prompt(client, "when are timesheets due in Workday?")


def test_a_move_replaces_where_you_live_in_the_prompt(client):
    _remember_in_chat(client, "Lives in Sydney")
    assert "Lives in Sydney" in _prompt(client, "where do I live?")
    _remember_in_chat(client, "Moved to Melbourne")
    prompt = _prompt(client, "where do I live?")
    assert "Moved to Melbourne" in prompt
    assert "Lives in Sydney" not in prompt, "the newer fact about the same thing replaces the older one"
    old = [m for m in client.get("/api/knowledge/memories", params={"status": "superseded"}).json() if m["content"] == "Lives in Sydney"]
    assert old, "the older fact is kept as history, not deleted"


def test_a_key_never_goes_into_memory(client):
    """What is remembered goes into prompts, so a key or password never does, from chat or from the Memory page."""
    key = "sk-proj-" + "FAKE" * 6 + "0123"  # made up at run time, so secret scanners see no key in the source
    SCRIPT[:] = [tool_call("remember", {"content": f"The billing key is {key}", "kind": "fact"}), {"role": "assistant", "content": "ok"}]
    events(client.post("/api/assistant/chat", json={"message": "remember the billing key"}))
    assert client.post("/api/knowledge/memories", json={"content": f"Billing key {key}"}).status_code == 400
    assert not _on_memory_page(client, key) and not _on_memory_page(client, "billing key")
    assert key not in _prompt(client, "what is the billing key?")


def test_correcting_a_fact_on_the_memory_page_is_what_the_next_prompt_uses(client):
    _remember_in_chat(client, "Desk is on level 4 of the Collins Street building")
    m = _on_memory_page(client, "Collins Street")[0]
    r = client.patch(f"/api/knowledge/memories/{m['id']}", json={"content": "Desk is on level 7 of the Collins Street building"})
    assert r.status_code == 200 and r.json()["source_kind"] == "user"
    prompt = _prompt(client, "where is my desk on Collins Street?")
    assert "level 7" in prompt and "level 4" not in prompt


# The one-time move ----------------------------------------------------------------------------------------------------
OLD_MEMORIES = """
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY, content TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'fact', source TEXT NOT NULL DEFAULT 'auto',
  conversation_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, content='memories', content_rowid='id', tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;
"""
OLD_ADAPT_FACTS = """
CREATE TABLE IF NOT EXISTS adapt_facts (
  id INTEGER PRIMARY KEY, content_enc TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'fact', source TEXT NOT NULL DEFAULT 'chat',
  evidence_enc TEXT NOT NULL DEFAULT '', confidence REAL NOT NULL DEFAULT 0.7, pinned INTEGER NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0, fingerprint TEXT NOT NULL DEFAULT '', conversation_id INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
"""


def test_the_move_keeps_every_fact_from_all_three_stores(client, tmp_path, monkeypatch):
    """A database as the last release left it: facts in memories (plaintext), adapt_facts (encrypted) and kn_memories
    (with the live sync's mirrors of adapt_facts). After the upgrade every fact is in kn_memories once, encrypted, with
    its source and dates, and the two old tables are gone."""
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
        schema.migrate(c, path, upto=3)  # the knowledge layer as the last release had it
        a, b = "2025-02-01T08:00:00+00:00", "2025-06-15T10:30:00+00:00"
        # A: the old plaintext table
        c.execute("INSERT INTO memories(content, kind, source, conversation_id, created_at, updated_at) VALUES (?, 'profile', 'user', 7, ?, ?)",
                  ("My manager is Priya Shah", a, a))
        c.execute("INSERT INTO memories(content, kind, source, created_at, updated_at) VALUES (?, 'preference', 'auto', ?, ?)",
                  ("Prefers meeting notes as bullet points", a, a))
        c.execute("INSERT INTO memories(content, kind, source, created_at, updated_at) VALUES (?, 'fact', 'auto', ?, ?)",
                  ("Works on the payroll migration project", a, a))  # also in B: one copy after the move
        c.execute("INSERT INTO memories(content, kind, source, created_at, updated_at) VALUES (?, 'fact', 'auto', ?, ?)",
                  ("My bank password is hunter2", a, a))  # a secret never moves into what prompts see
        # B: the encrypted "What I know about you" store
        for content, cat, source, pinned, ev in (("Works on the payroll migration project.", "work", "chat", 0, "said in chat"),
                                                 ("Lives in Sydney", "about", "user", 1, ""),
                                                 ("Signs emails with Kind regards", "format", "feedback", 0, "edited a draft")):
            c.execute("INSERT INTO adapt_facts(content_enc, category, source, evidence_enc, confidence, pinned, uses, conversation_id, "
                      "created_at, updated_at) VALUES (?, ?, ?, ?, 0.8, ?, 3, 12, ?, ?)",
                      (encrypt(content), cat, source, encrypt(ev), pinned, b, b))
        sydney = c.execute("SELECT id FROM adapt_facts WHERE category = 'about'").fetchone()[0]
        # C: the Memory page's store: one of its own, and a mirror of the Sydney fact made by the live sync
        for content, tier, kind, ref, at in (("Team stand-up is at 9:15 every weekday", "procedural", "user", "", a),
                                             ("Lives in Sydney", "profile", "adapter", f"adapt_fact:{sydney}", b)):
            c.execute("INSERT INTO kn_memories(uid, tier, content_enc, fingerprint, source_kind, source_ref, observed_at, created_at, "
                      "updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                      (uuid.uuid4().hex, tier, crypto.seal(content), memory.fingerprint(content), kind, ref, at, at, at))
        c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        c.close()
        db._local.conn = None
        schema.reset_ready()

        db.init()
        knowledge.ensure()

        c = db.conn()
        assert c.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION == 5
        tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        assert not {"memories", "memories_fts", "adapt_facts"} & tables, "the two old stores are gone"
        assert list(tmp_path.glob("workbench.db.pre-v5-*.bak")), "a backup is taken before the move"
        mems = knowledge.list_memories(status="")
        by = {}
        for m in mems:
            by.setdefault(m["content"].rstrip("."), []).append(m)
        expected = {"My manager is Priya Shah", "Prefers meeting notes as bullet points", "Works on the payroll migration project",
                    "Lives in Sydney", "Signs emails with Kind regards", "Team stand-up is at 9:15 every weekday"}
        assert set(by) == expected, sorted(by)
        assert all(len(v) == 1 for v in by.values()), {k: len(v) for k, v in by.items()}
        assert all(m["status"] == "active" for m in mems)
        priya = by["My manager is Priya Shah"][0]
        assert (priya["source_kind"], priya["tier"], priya["pinned"], priya["observed_at"], priya["created_at"]) == ("user", "profile", True, a, a)
        assert priya["source_ref"] == "conversation:7"
        notes = by["Prefers meeting notes as bullet points"][0]
        assert (notes["source_kind"], notes["tier"]) == ("chat", "procedural")
        payroll = by["Works on the payroll migration project"][0]
        assert payroll["observed_at"] == a, "the earliest date of a duplicate is kept"
        sydney_m = by["Lives in Sydney"][0]
        assert (sydney_m["source_kind"], sydney_m["pinned"], sydney_m["uses"], sydney_m["observed_at"]) == ("user", True, 3, b)
        assert sydney_m["predicate"] == "lives_in"
        regards = by["Signs emails with Kind regards"][0]
        assert (regards["source_kind"], regards["tier"], regards["evidence"]) == ("feedback", "procedural", "edited a draft")
        # encrypted at rest, and found again
        dump = "\n".join(sqlite3.connect(path).iterdump())
        assert not any("hunter2" in m["content"] for m in mems)
        for text in ("Priya", "payroll", "bullet points", "Kind regards", "hunter2"):
            assert text not in dump
        assert any("Priya" in m["content"] for m in knowledge.recall("who is my manager Priya"))
        # running it again changes nothing
        assert schema.migrate() == []
        db.migrate(c, path)
        assert len(knowledge.list_memories(status="")) == len(mems)
    finally:
        if getattr(db._local, "conn", None) is not None:
            db._local.conn.close()
        db._local.conn = None
        monkeypatch.undo()
        schema.reset_ready()
        crypto.reset_cache()


def test_a_locked_memory_key_at_upgrade_leaves_the_facts_in_place_until_it_opens(client, tmp_path, monkeypatch):
    """The upgrade never loses facts or blocks start-up when the memory key cannot be read (a locked keychain): the
    old table stays, and the move happens the first time the memory opens with the key."""
    from app import config, db, knowledge
    from app.knowledge import crypto, schema

    path = tmp_path / "workbench.db"
    monkeypatch.setattr(config, "DB_PATH", path)
    db._local.conn = None
    schema.reset_ready()
    crypto.reset_cache()
    real_state = crypto._state
    try:
        c = db.conn()
        c.executescript(db.SCHEMA)
        c.executescript(OLD_MEMORIES)
        c.execute("PRAGMA user_version = 4")
        c.execute("INSERT INTO memories(content, kind, source, created_at, updated_at) VALUES ('Works from the Parramatta office on Fridays', 'fact', 'user', ?, ?)",
                  ("2025-01-01T00:00:00+00:00", "2025-01-01T00:00:00+00:00"))

        def locked():
            raise crypto.KeyMissing("Your memory is locked.")

        monkeypatch.setattr(crypto, "_state", locked)
        db.init()
        assert c.execute("PRAGMA user_version").fetchone()[0] == 5, "start-up is not blocked"
        assert c.execute("SELECT COUNT(*) FROM memories").fetchone()[0] == 1, "nothing is lost while the key is locked"
        monkeypatch.setattr(crypto, "_state", real_state)
        knowledge.ensure()
        assert "memories" not in {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        assert [m["content"] for m in knowledge.list_memories()] == ["Works from the Parramatta office on Fridays"]
        assert knowledge.recall("Parramatta office")
    finally:
        if getattr(db._local, "conn", None) is not None:
            db._local.conn.close()
        db._local.conn = None
        monkeypatch.undo()
        schema.reset_ready()
        crypto.reset_cache()
