"""What the assistant knows about the person: the one memory store, seen from chat, the Memory page and the terminal.

There used to be three stores for this: the plaintext `memories` table (the chat's Memory tab), the encrypted
`adapt_facts` table ("What I know about you", chat's remember and forget tools, the terminal's /memory) and
`kn_memories` (the Memory page, filled from adapt_facts once a minute). Now everything is a row in kn_memories
(knowledge/memory.py): encrypted with the memory key, de-duplicated, and a newer fact about the same thing (same
predicate, such as lives_in) replaces the older one, which is kept as history. Chat's remember tool, the background
learner, the Memory page, the terminal and every "forget" read and write the same rows, and the prompt's memory
block (recall.context_for) is built from them alone.

move_old_stores() is the one-time move of the two older tables into kn_memories (db.migrate_v5); merge_leftovers()
finishes it later if the memory key could not be read at upgrade time.

Switches (Memory page, "Learning"): adapt_memory (learn about me as we work) and adapt_memory_context (use what I know
in answers). Their setting names are kept so a person's choice survives the upgrade.
"""

from __future__ import annotations

import logging
import re
import sqlite3
import uuid

from fastapi import HTTPException

from .. import db, llm
from . import crypto, memory, schema
from .recall import context_for, recall as _recall  # the package exports a function named recall
from .text import words

log = logging.getLogger("knowledge.facts")

# Older code spoke of categories; the one store has tiers. Formats and preferences are "how you like things done".
CATEGORY_TIER = {"about": "profile", "profile": "profile", "identity": "profile", "work": "profile", "job": "profile",
                 "people": "profile", "project": "profile", "client": "profile", "fact": "profile",
                 "preference": "procedural", "format": "procedural", "tone": "procedural", "style": "procedural"}
TIER_LABEL = {"profile": "About you", "procedural": "How you like things done", "project": "Projects",
              "episodic": "Recent happenings"}
TIER_CATEGORY = {"profile": "about", "procedural": "preference", "project": "work", "episodic": "fact"}
# Where a fact came from, in the store's words (memory.why turns these into "You told me", "From a chat", ...)
SOURCE_KIND = {"user": "user", "assistant": "chat", "agent": "chat", "auto": "chat", "migrated": "chat", "chat": "chat",
               "file": "file", "task": "task", "teach": "teach", "feedback": "feedback", "import": "import",
               "site": "site", "note": "note", "email": "email", "other": "other"}
YOURS = ["shared", "private"]  # memories about you and your work; a teammate's own notes stay with that teammate
SECRETISH = re.compile(r"password|passcode|\bpin\b|card number|cvv|api key|token|secret", re.I)


def learning_on() -> bool:
    return (db.get_setting("adapt_memory", "1") or "1") == "1"


def context_on() -> bool:
    return (db.get_setting("adapt_memory_context", "1") or "1") == "1"


def tier_for(category: str | None) -> str:
    c = str(category or "fact").lower()
    return c if c in TIER_LABEL else CATEGORY_TIER.get(c, "profile")


def _fact(m: dict) -> dict:
    """A memory in the shape chat tools, the terminal and history use."""
    return {"id": m["id"], "content": m["content"], "tier": m["tier"], "category": TIER_CATEGORY.get(m["tier"], "fact"),
            "category_label": TIER_LABEL.get(m["tier"], m["tier"]), "source": m["source_kind"], "evidence": m["evidence"],
            "confidence": m["confidence"], "pinned": m["pinned"], "uses": m["uses"], "status": m["status"],
            "created_at": m["created_at"], "updated_at": m["updated_at"], "observed_at": m["observed_at"]}


def add(content: str, category: str = "fact", source: str = "user", evidence: str = "", confidence: float = 0.7,
        pinned: bool = False, conversation_id: int | None = None) -> dict | None:
    """Save one fact about the person. None when it was already known, in any tier (the known one is refreshed)."""
    schema.ensure()
    tier = tier_for(category)
    fp = memory.fingerprint(" ".join((content or "").split())[:1000])
    for r in db.all("SELECT id, tier, fingerprint FROM kn_memories WHERE status IN ('active', 'conflict') AND subject_id IS NULL "
                    "AND scope = 'shared' AND tier != ?", tier):
        if memory._jaccard(fp, r["fingerprint"]) >= 0.75:
            db.run("UPDATE kn_memories SET updated_at = ? WHERE id = ?", db.now(), r["id"])
            return None
    res = memory.remember(content, tier, pinned=pinned or str(category).lower() in ("about", "profile"),
                          confidence=confidence, source_kind=SOURCE_KIND.get(source, source),
                          source_ref=f"conversation:{conversation_id}" if conversation_id else "", evidence=evidence)
    return None if res["outcome"] == "duplicate" else _fact(res["memory"]) | {"outcome": res["outcome"]}


def get(mid: int) -> dict:
    return _fact(memory.get(mid))


def update(mid: int, content: str | None = None, category: str | None = None, pinned: bool | None = None) -> dict:
    return _fact(memory.update(mid, content, pinned=pinned, tier=tier_for(category) if category else None))


def delete(mid: int) -> dict:
    memory.forget(mid)
    return {"deleted": mid}


def all_facts(limit: int = 500) -> list[dict]:
    """What is known now: pinned first, then newest."""
    return [_fact(m) for m in memory.list_(scopes=YOURS, limit=limit)]


def search(query: str, limit: int = 8) -> list[dict]:
    return [_fact(m) | {"score": m["score"]} for m in _recall(query, scopes=YOURS, k=limit)]


def context_block(user_text: str, budget_tokens: int = 500) -> str:
    """The memory block for a prompt outside chat (the terminal). Chat builds the same block in knowledge/live.py."""
    if not context_on():
        return ""
    return context_for(user_text, budget_tokens=budget_tokens, recent=3)["block"]


def forget_everything() -> dict:
    schema.ensure()
    ids = [r["id"] for r in db.all(f"SELECT id FROM kn_memories WHERE scope IN ({','.join('?' * len(YOURS))})", *YOURS)]
    for mid in ids:
        memory.forget(mid)
    return {"deleted": len(ids)}


def forget_matching(text: str) -> list[str]:
    """Drop facts whose words contain this phrase, including older versions kept as history. 'everything' clears
    them all. Returns what went."""
    phrase = " ".join((text or "").split())
    if len(phrase) < 2:
        raise HTTPException(400, "Say which memory to forget.")
    every = phrase.lower() in {"everything", "all", "*"}
    gone = []
    for m in memory.list_(scopes=YOURS, status="", limit=100_000):
        if every or phrase.lower() in m["content"].lower():
            memory.forget(m["id"])
            if m["status"] in ("active", "conflict"):
                gone.append(m["content"])
    return gone


# Learning ------------------------------------------------------------------------------------------------------------
# Keep the phrase "long term memory": the offline test model answers prompts containing it with a profile fact.
MINE_PROMPT = (
    "You keep the long term memory for ONE person so their assistant adapts to them, whatever their field (trades, "
    "office, law, science, study, maths, design, music, anything). From the new material, extract durable facts worth "
    "remembering: who they are and what they do, their field and role, recurring clients, projects, sites or courses, "
    "important people, how they like things done, tone and document formats they use. Only what the person stated, "
    "showed or clearly confirmed; never guess; skip one-off requests, small talk, secrets (passwords, card numbers) and "
    "anything already known. When something they said changes an earlier fact (they moved, changed jobs), write the "
    "new fact plainly, like 'Moved to Melbourne'. "
    'Reply with only a JSON array (possibly empty) of {"content": "one short sentence", '
    '"kind": "about|work|people|preference|format|fact"}. Max 5 items.'
)


async def model_json(prompt: str, payload: str, model: str | None = None, channel: str = "adapt"):
    """One JSON reply from the conversation's model (patched in tests)."""
    res = await llm.chat(model or None, [{"role": "system", "content": prompt}, {"role": "user", "content": payload}],
                         trace={"channel": f"learn:{channel}"})
    return llm.parse_json(res["message"].get("content") or "")


async def learn_from(material: str, source: str, evidence: str = "", model: str | None = None,
                     conversation_id: int | None = None) -> list[dict]:
    if not learning_on() or len((material or "").strip()) < 40:
        return []
    known = [f["content"] for f in all_facts(80)]
    payload = "Already known:\n" + "\n".join(f"- {k}" for k in known) + f"\n\nNew material ({source}):\n" + material[:20000]
    items = await model_json(MINE_PROMPT, payload, model, source)
    added = []
    for it in (items if isinstance(items, list) else [])[:5]:
        if not isinstance(it, dict) or not isinstance(it.get("content"), str) or SECRETISH.search(it["content"]):
            continue
        try:
            f = add(it["content"], it.get("kind") or it.get("category") or "fact", source, evidence, 0.7,
                    conversation_id=conversation_id)
        except HTTPException:
            continue
        if f:
            added.append(f)
    return added


async def mine_conversation(conv_id: int) -> list[dict]:
    """After a chat turn: the new messages since the conversation's memory cursor, mined into the store."""
    conv = db.one("SELECT * FROM conversations WHERE id = ?", conv_id)
    if not conv:
        return []
    rows = db.all("SELECT id, role, content FROM messages WHERE conversation_id = ? AND id > ? AND role IN ('user', 'assistant') "
                  "ORDER BY id", conv_id, conv["memory_cursor"])
    if not rows or sum(len(r["content"]) for r in rows if r["role"] == "user") < 40:
        return []
    db.run("UPDATE conversations SET memory_cursor = ? WHERE id = ?", rows[-1]["id"], conv_id)
    text = "\n".join(f"{r['role'].upper()}: {r['content'][:2000]}" for r in rows)
    first_user = next((r["content"] for r in rows if r["role"] == "user"), "")
    return await learn_from(text, "chat", first_user[:200], conv["model"] or None, conv_id)


# The one-time move of the two older stores -------------------------------------------------------------------------
OLD_TABLES = ("memories", "adapt_facts")


def _norm(text: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", (text or "").lower()).split())


def _tables(c: sqlite3.Connection) -> set[str]:
    return {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}


def old_stores_left(c: sqlite3.Connection | None = None) -> bool:
    return bool(set(OLD_TABLES) & _tables(c or db.conn()))


def _old_facts(c: sqlite3.Connection, have: set[str]) -> tuple[list[dict], list[int]]:
    """Every fact in the two older tables, in one shape. Also the adapt_facts ids that could not be read."""
    from ..security import decrypt

    out, unreadable = [], []
    if "memories" in have:
        for r in c.execute("SELECT id, content, kind, source, conversation_id, created_at, updated_at FROM memories ORDER BY id"):
            mid, content, kind, source, cid, created, updated = r
            yours = source == "user"
            out.append({"table": "memories", "id": mid, "content": content,
                        "secret": bool(SECRETISH.search(content or "") or memory.KEYLIKE.search(content or "")), "tier": "procedural" if kind == "preference" else "profile",
                        "pinned": kind == "profile", "confidence": 1.0 if yours else 0.8, "source_kind": "user" if yours else "chat",
                        "source_ref": f"conversation:{cid}" if cid else "", "evidence": "", "uses": 0,
                        "created_at": created, "updated_at": updated})
    if "adapt_facts" in have:
        for r in c.execute("SELECT id, content_enc, category, source, evidence_enc, confidence, pinned, uses, conversation_id, "
                           "created_at, updated_at FROM adapt_facts ORDER BY id"):
            fid, enc, cat, source, ev, conf, pinned, uses, cid, created, updated = r
            content = decrypt(enc)
            if not content:
                unreadable.append(fid)  # sealed with an older app secret: left where it is, never dropped
                continue
            out.append({"table": "adapt_facts", "id": fid, "content": content, "secret": bool(memory.KEYLIKE.search(content)),
                        "tier": tier_for(cat), "pinned": bool(pinned),
                        "confidence": float(conf), "source_kind": SOURCE_KIND.get(source, source),
                        "source_ref": f"conversation:{cid}" if cid else "", "evidence": decrypt(ev), "uses": int(uses or 0),
                        "created_at": created, "updated_at": updated, "mirror": f"adapt_fact:{fid}"})
    return out, unreadable


def move_old_stores(c: sqlite3.Connection) -> dict:
    """Move every fact from `memories` (plaintext) and `adapt_facts` (encrypted with the app secret) into kn_memories
    (encrypted with the memory key). Facts with the same words become one row that keeps the earliest date, the
    person's own word as its source when either copy had it, pinned if either was, and every use. The copies the live
    sync made of adapt_facts in kn_memories (source_ref adapt_fact:<id>) are that same fact, not a second one.
    Runs inside the caller's transaction. The old tables are dropped once nothing readable is left in them."""
    have = _tables(c)
    if not set(OLD_TABLES) & have:
        return {"moved": 0, "merged": 0, "dropped": 0, "left": 0}
    crypto.seal("check")  # the memory key must be readable before anything changes (raises KeyMissing)
    if "kn_memories" not in have:
        schema._exec_many(c, schema.KNOWLEDGE_SQL)
        schema._exec_many(c, schema.TRIGGERS_SQL)
    facts, unreadable = _old_facts(c, have)
    cols = ("id", "content_enc", "tier", "pinned", "confidence", "source_kind", "source_ref", "evidence_enc", "uses",
            "observed_at", "created_at", "updated_at")
    rows = [dict(zip(cols, r)) for r in c.execute(
        f"SELECT {', '.join(cols)} FROM kn_memories WHERE subject_id IS NULL AND scope = 'shared' AND status IN ('active', 'conflict')")]
    by_norm, by_ref = {}, {}
    for r in rows:
        r["content"] = crypto.open_text(r["content_enc"])
        by_norm.setdefault(_norm(r["content"]), r)
        if r["source_ref"].startswith("adapt_fact:"):
            by_ref[r["source_ref"]] = r
    moved = merged = dropped = 0
    for f in facts:
        content = " ".join(f["content"].split())[:1000]
        if len(content) < 3 or f.get("secret"):
            # a password or card number in the old plaintext table never goes into a prompt (the old code's own move
            # dropped these too, adapt.knowledge.migrate_legacy), and a key never, from either table
            c.execute(f"DELETE FROM {f['table']} WHERE id = ?", (f["id"],))
            dropped += 1
            continue
        key = _norm(content)
        row = by_ref.get(f.get("mirror", "")) or by_norm.get(key)
        if row is None:
            now = f["created_at"] or db.now()
            cur = c.execute(
                "INSERT INTO kn_memories(uid, tier, content_enc, fingerprint, predicate, scope, privacy, pinned, confidence, "
                "source_kind, source_ref, evidence_enc, observed_at, created_at, updated_at, uses) "
                "VALUES (?, ?, ?, ?, ?, 'shared', 'normal', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (uuid.uuid4().hex, f["tier"], crypto.seal(content), memory.fingerprint(content),
                 memory.predicate_of(content) if f["tier"] == "profile" else "", int(f["pinned"]), f["confidence"],
                 f["source_kind"], f["source_ref"], crypto.seal(f["evidence"][:400]), now, now, f["updated_at"] or now, f["uses"]))
            row = {"id": cur.lastrowid, "content": content, "tier": f["tier"], "pinned": int(f["pinned"]),
                   "confidence": f["confidence"], "source_kind": f["source_kind"], "source_ref": f["source_ref"],
                   "evidence_enc": "", "uses": f["uses"], "observed_at": now, "created_at": now, "updated_at": f["updated_at"] or now}
            by_norm[key] = row
            moved += 1
        else:
            if row["source_kind"] == "adapter":  # the live sync's copy: this fact is the truth (it may have been edited)
                row["content"], row["tier"], row["source_kind"], row["source_ref"] = content, f["tier"], f["source_kind"], f["source_ref"]
            elif f["source_kind"] == "user":
                row["source_kind"] = "user"
            first = min(x for x in (row["observed_at"], f["created_at"]) if x)
            row.update(pinned=int(bool(row["pinned"]) or f["pinned"]), confidence=max(row["confidence"], f["confidence"]),
                       uses=row["uses"] + f["uses"], observed_at=first, created_at=min(row["created_at"], first),
                       updated_at=max(row["updated_at"], f["updated_at"] or ""),
                       source_ref=row["source_ref"] if row["source_ref"] and not row["source_ref"].startswith("adapt_fact:") else f["source_ref"])
            ev = crypto.open_text(row["evidence_enc"]) or f["evidence"]
            c.execute("UPDATE kn_memories SET content_enc = ?, fingerprint = ?, predicate = ?, tier = ?, pinned = ?, confidence = ?, "
                      "source_kind = ?, source_ref = ?, evidence_enc = ?, uses = ?, observed_at = ?, created_at = ?, updated_at = ? "
                      "WHERE id = ?",
                      (crypto.seal(row["content"]), memory.fingerprint(row["content"]),
                       memory.predicate_of(row["content"]) if row["tier"] == "profile" else "", row["tier"], row["pinned"],
                       row["confidence"], row["source_kind"], row["source_ref"], crypto.seal(ev[:400]), row["uses"],
                       row["observed_at"], row["created_at"], row["updated_at"], row["id"]))
            row["evidence_enc"] = crypto.seal(ev[:400])
            merged += 1
        c.execute(f"DELETE FROM {f['table']} WHERE id = ?", (f["id"],))
    # mirrors whose adapt fact was forgotten before the move were already gone for the person; drop them too
    for ref, row in by_ref.items():
        if row["source_kind"] == "adapter":
            c.execute("DELETE FROM kn_memories WHERE id = ?", (row["id"],))
            c.execute("DELETE FROM kn_docs WHERE kind = 'memory' AND ref = ?", (str(row["id"]),))
    if "memories" in have:
        for t in ("memories_ai", "memories_ad", "memories_au"):
            c.execute(f"DROP TRIGGER IF EXISTS {t}")
        c.execute("DROP TABLE IF EXISTS memories_fts")
        c.execute("DROP TABLE memories")
    if "adapt_facts" in have:
        if unreadable:
            c.execute(f"DELETE FROM adapt_facts WHERE id NOT IN ({','.join('?' * len(unreadable))})", unreadable)
            log.warning("%s facts could not be read with this app secret and were left in adapt_facts", len(unreadable))
        else:
            c.execute("DROP TABLE adapt_facts")
    return {"moved": moved, "merged": merged, "dropped": dropped, "left": len(unreadable)}


def merge_leftovers() -> dict | None:
    """Finish the move later (the memory key was locked at upgrade time). Cheap when there is nothing to do."""
    c = db.conn()
    if not old_stores_left(c):
        return None
    if "adapt_facts" in _tables(c) and "memories" not in _tables(c):
        from ..security import decrypt

        if all(not decrypt(r[0]) for r in c.execute("SELECT content_enc FROM adapt_facts")):
            return None  # only facts this app secret cannot read: nothing to move
    c.execute("BEGIN IMMEDIATE")
    try:
        out = move_old_stores(c)
        c.execute("COMMIT")
    except BaseException:
        c.execute("ROLLBACK")
        raise
    memory.index_missing()
    return out
