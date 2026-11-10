"""Self improvement, run in the background after each turn:

* memories: durable facts about the user are mined from new messages into the one memory store (knowledge/facts.py)
* skills: after a complex task (several tool calls) the model decides whether to save or improve a reusable procedure

Both use the conversation's model and can be switched off in Settings (learning costs extra model calls).
"""

import asyncio
import json
import logging
import re

from fastapi import HTTPException

from . import db, llm

log = logging.getLogger("learn")
_lock = asyncio.Lock()
_tasks: set[asyncio.Task] = set()
SKILL_MIN_TOOL_CALLS = 3
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,48}$")


def enabled() -> bool:
    return db.get_setting("learning_enabled", "1") == "1"


def _step_diff(previous: str, fresh: str) -> str:
    """Lines that left and lines that arrived, so a refined skill shows what changed."""
    old, new = previous.splitlines(), fresh.splitlines()
    gone = [f"- {line}" for line in old if line not in new]
    added = [f"+ {line}" for line in new if line not in old]
    return "\n".join([*gone, *added])[:4000]


def upsert_skill(name: str, description: str, steps: str, source: str = "auto") -> dict:
    name = name.strip().lower().replace(" ", "-")
    if not NAME_RE.match(name):
        raise HTTPException(400, "Skill name must be short-kebab-case (letters, digits, dashes).")
    if not steps.strip() or not description.strip():
        raise HTTPException(400, "A skill needs a description and steps.")
    existing = db.one("SELECT id, source, steps FROM skills WHERE name = ?", name)
    if existing and existing["source"] == "github":  # reviewed third-party text: only a new reviewed install may change it
        raise HTTPException(409, f"{name} was installed from GitHub after a security check and cannot be edited here. Save under another name.")
    if existing:
        previous = existing["steps"] or ""
        fresh = steps.strip()[:20000]
        db.run("UPDATE skills SET description = ?, steps = ?, updated_at = ? WHERE id = ?",
               description.strip()[:300], fresh, db.now(), existing["id"])
        return {"updated": name, "previous": previous, "diff": _step_diff(previous, fresh)}
    db.run("INSERT INTO skills(name, description, steps, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
           name, description.strip()[:300], steps.strip()[:20000], source, db.now(), db.now())
    return {"created": name}


async def _model_json(conv: dict, prompt: str, payload: str, channel: str):
    res = await llm.chat(conv["model"] or None, [{"role": "system", "content": prompt}, {"role": "user", "content": payload}],
                         trace={"channel": f"learn:{channel}", "agent_id": conv.get("agent_id"), "conversation_id": conv["id"]})
    return llm.parse_json(res["message"].get("content") or "")


SKILL_PROMPT = (
    "You review a completed task by an AI assistant and decide whether its procedure should become a reusable skill: "
    "a recurring kind of task where written steps would make the next run faster or more reliable. "
    "Do not save one-off questions or trivial lookups. If an existing skill covers it, improve that skill (same name). "
    'Reply with only JSON: {"save": true|false, "name": "short-kebab-case", "description": "when to use it, one sentence", '
    '"steps": "numbered Markdown steps naming the tools to use and pitfalls seen"}'
)


async def mine_skill(conv_id: int) -> str:
    conv = db.one("SELECT * FROM conversations WHERE id = ?", conv_id)
    last_user = db.one("SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1", conv_id)
    if not conv or not last_user:
        return ""
    rows = db.all("SELECT role, content, tool_calls, name FROM messages WHERE conversation_id = ? AND id >= ? ORDER BY id",
                  conv_id, last_user["id"])
    from .assistant import UNTRUSTED_TOOLS

    if any(r["role"] == "tool" and r["name"] in UNTRUSTED_TOOLS for r in rows):
        return ""  # a skill learned from a turn that read web pages or email could carry injected instructions forever
    lines = []
    for r in rows:
        if r["role"] == "tool":
            lines.append(f"TOOL RESULT {r['name']}: {r['content'][:600]}")
        elif r["tool_calls"]:
            calls = ", ".join(f"{c['function']['name']}({c['function']['arguments'][:200]})" for c in json.loads(r["tool_calls"]))
            lines.append(f"ASSISTANT CALLED: {calls}")
        else:
            lines.append(f"{r['role'].upper()}: {r['content'][:2000]}")
    skills = db.all("SELECT name, description FROM skills")
    payload = ("Existing skills:\n" + "\n".join(f"- {s['name']}: {s['description']}" for s in skills) +
               "\n\nTranscript:\n" + "\n".join(lines))
    out = await _model_json(conv, SKILL_PROMPT, payload[:24000], "skill")
    if isinstance(out, dict) and out.get("save") is True:
        try:
            r = upsert_skill(str(out.get("name", "")), str(out.get("description", "")), str(out.get("steps", "")))
            name = next(iter(r.values()))
            # Visible “learned this” moment (Hermes soul) — same conversation, plain words
            kind = "Updated" if "updated" in r else "Saved"
            note = (f"{kind} a reusable skill: **{name}**. "
                    f"{str(out.get('description') or '').strip()[:200]} "
                    "Open Skills to read or forget it.")
            db.run("INSERT INTO messages(conversation_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)",
                   conv_id, note.strip(), db.now())
            db.run("UPDATE conversations SET updated_at = ? WHERE id = ?", db.now(), conv_id)
            return name
        except HTTPException:
            return ""
    return ""


async def _after(conv_id: int, tool_calls: int, channel: str = "web") -> None:
    from .adapt import hooks as adapt_hooks

    async with _lock:  # one learning job at a time keeps it light
        try:
            await adapt_hooks.after_turn(conv_id, channel)  # facts into the one memory store, plus job patterns
            if tool_calls >= SKILL_MIN_TOOL_CALLS:
                await mine_skill(conv_id)
        except Exception as e:  # noqa: BLE001 - learning is best effort and must never break chat
            log.warning("learning failed for conversation %s: %s", conv_id, e)


def after_turn(ctx) -> None:
    if not enabled():
        return
    try:
        task = asyncio.get_running_loop().create_task(_after(ctx.conversation_id, ctx.tool_calls, ctx.channel))
    except RuntimeError:
        return
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
