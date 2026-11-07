"""Starting points by line of work (feat/coworkers, design record 0004).

A profession is a recommended setup, not a product: a small team of coworkers (rows in the Company `agents` table),
scheduled jobs for them (rows in `schedules`, created OFF), the connections those jobs need, and the integrations worth
knowing about with an honest status. Nothing here calls a model, installs anything or turns anything on by itself:

1. `proposal` shows what would be created, what each job reads and may change, and what is missing.
2. `apply` creates the coworkers and the jobs, all jobs off.
3. Each job is turned on only by the owner answering its card ("s:<schedule id>" in Needs you, or the setup page).
   A job whose connection is missing cannot be turned on.
4. `remove` deletes what one profession created and nothing else (mail, tasks, notes and chats stay).

When a job runs it is an ordinary scheduled run on the `schedule` channel, so anything that sends or changes something
outside the app waits in Needs you (assistant.hold_reason) and runs once on yes.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import db, scheduler
from .security import require_user_or_terminal

# The owner in the app, or the terminal with its key: the same setup is reachable from both (AGENTS.md parity rule)
router = APIRouter(prefix="/api/starters", tags=["starters"], dependencies=[Depends(require_user_or_terminal)])

# How an integration reaches the service. Plain words for the card; the key goes under Advanced.
KINDS = {
    "native": "Built into the app",
    "official_api": "Connects to the service directly, with your own key",
    "official_mcp": "The service publishes its own connector; you add it yourself",
    "community_mcp": "Only community connectors exist; not checked by us",
    "browser": "Done in a browser the assistant drives, with your OK",
    "unverified": "Not supported yet",
}
# What the app can do with it today. "tested" says how it was tested, never more than that.
STATES = {
    "ready": "Works in the app",
    "needs_setup": "Works once you set it up",
    "not_built": "Not in the app yet",
}

MAIL = {"key": "mail", "name": "Email (any provider, with an app password)", "kind": "native", "state": "ready",
        "what": "Reads your inbox and saves reply drafts. Sending always waits for your OK.",
        "tested": "Tested with a stand in mail server; not with your provider until you connect it.", "page": "/mail"}
GOOGLE_MS = {"key": "google_microsoft", "name": "Google or Microsoft 365 (mail and calendar)", "kind": "native", "state": "needs_setup",
             "what": "One sign in for mail and calendar.",
             "tested": "Tested with a stand in service. This copy of the app needs its sign in set up first (Advanced).",
             "page": "/mail"}
SERVICEM8 = {"key": "servicem8", "name": "ServiceM8", "kind": "official_api", "state": "needs_setup",
             "what": "Sends a quote or invoice you approved to ServiceM8 as a job, with your own key.",
             "tested": "Tested against a stand in for ServiceM8, never a real account.", "page": "/packs/trade",
             "source": "developer.servicem8.com/docs/authentication"}
XERO = {"key": "xero", "name": "Xero", "kind": "official_api", "state": "needs_setup",
        "what": "Sends an invoice you approved to Xero as a draft, through a Custom Connection you create in Xero.",
        "tested": "Tested against a stand in for Xero, never a real account. Xero also publishes its own connector that "
                  "you can add under Advanced.",
        "page": "/packs/trade", "source": "github.com/XeroAPI/xero-mcp-server"}
PROCORE = {"key": "procore", "name": "Procore", "kind": "community_mcp", "state": "not_built",
           "what": "Procore has a developer API. The app has no Procore connection, and the only connectors found are "
                   "community projects we have not checked.",
           "tested": "Not tested.", "page": ""}

_BRIEF = ("Work only from what the tools return. Never invent jobs, prices, dates or people. If something is unclear, "
          "say so. Never send anything yourself: save drafts and say what is waiting for the user's OK.")

PROFESSIONS: dict[str, dict] = {
    "construction": {
        "label": "Construction and trades",
        "blurb": "Jobs, quotes, invoices and keeping your crew up to date.",
        "pack": "trade",
        "coordinator": {"key": "office", "name": "Office manager", "title": "Runs the office and hands out the work",
                        "instructions": "You coordinate the office for a building or trade business. You read what came "
                                        "in, decide what needs doing and by whom, and keep a short daily list. " + _BRIEF},
        "coworkers": [
            {"key": "quotes", "name": "Quotes", "title": "Prepares quotes from customer requests",
             "instructions": "You turn customer requests into clear draft quotes: scope, labour, materials and what is "
                             "still unknown. Ask for site details instead of guessing. " + _BRIEF},
            {"key": "accounts", "name": "Accounts", "title": "Tracks invoices and payments",
             "instructions": "You keep track of invoices sent, paid and overdue, and draft polite payment reminders "
                             "for the user to send. " + _BRIEF},
            {"key": "crew", "name": "Crew updates", "title": "Keeps workers informed about the schedule",
             "instructions": "You prepare short schedule updates for the crew from the user's calendar and tasks: who "
                             "is where, when, and what changed. Drafts only. " + _BRIEF},
        ],
        "schedules": [
            {"key": "morning_mail", "agent": "office", "name": "Morning mail check", "cron": "0 7 * * 1-5",
             "plain_time": "Weekdays at 7:00", "needs": ["mail"],
             "prompt": "Check email from the last day with search_email. List every quote request, invoice or payment "
                       "notice, and job change, each with sender, date and one line on what they want. Create a task "
                       "for each item that needs action. For each quote request, save a short reply draft that thanks "
                       "them and asks for anything missing. End with a summary under the headings Quotes, Invoices, "
                       "Jobs and Waiting for your OK.",
             "reads": "Your email from the last day.",
             "changes": "Adds tasks in the app. Saves reply drafts.",
             "result": "A morning summary in your inbox, plus tasks and drafts ready for you.",
             "risks": "Emails are written by other people, so after reading them anything that changes something outside "
                      "the app waits for your OK. Nothing is sent."},
            {"key": "friday_invoices", "agent": "accounts", "name": "Friday unpaid invoices", "cron": "0 15 * * 5",
             "plain_time": "Fridays at 15:00", "needs": ["mail"],
             "prompt": "Search email from the last 60 days for invoices the business sent and payment confirmations it "
                       "received. List invoices that look unpaid, with customer, amount and date as written in the "
                       "email. Save a polite reminder draft for each one older than 14 days. Say clearly which ones you "
                       "could not match.",
             "reads": "Your email from the last 60 days.",
             "changes": "Saves reminder drafts.",
             "result": "A list of invoices that look unpaid and reminder drafts.",
             "risks": "It can only see what is in your email, so a payment made another way may be missed. Nothing is sent."},
        ],
        "integrations": [MAIL, GOOGLE_MS, SERVICEM8, XERO, PROCORE],
    },
    "business": {
        "label": "Business operations",
        "blurb": "Inbox, calendar, follow ups and a weekly overview.",
        "pack": "",
        "coordinator": {"key": "ops", "name": "Operations lead", "title": "Keeps the week on track",
                        "instructions": "You keep the user's week on track: what came in, what is due, what slipped. " + _BRIEF},
        "coworkers": [
            {"key": "followups", "name": "Follow ups", "title": "Chases replies and open threads",
             "instructions": "You find emails the user sent that got no reply and draft short follow ups. " + _BRIEF},
        ],
        "schedules": [
            {"key": "monday_overview", "agent": "ops", "name": "Monday overview", "cron": "0 8 * * 1",
             "plain_time": "Mondays at 8:00", "needs": ["mail"],
             "prompt": "Use get_agenda for the next 7 days and search_email for the last 7 days. Write a one page "
                       "overview: meetings, deadlines, overdue tasks, and emails that still need an answer.",
             "reads": "Your calendar, tasks and email from the last week.",
             "changes": "Nothing.", "result": "A weekly overview in your inbox.",
             "risks": "Emails are written by other people; anything that would change something outside waits for your OK."},
        ],
        "integrations": [MAIL, GOOGLE_MS],
    },
    "personal": {
        "label": "Personal assistance",
        "blurb": "Your day, your errands and reminders.",
        "pack": "",
        "coordinator": {"key": "pa", "name": "Personal assistant", "title": "Looks after your day",
                        "instructions": "You look after the user's day: agenda, errands and reminders. " + _BRIEF},
        "coworkers": [],
        "schedules": [
            {"key": "daily_brief", "agent": "pa", "name": "Daily brief", "cron": "30 7 * * *",
             "plain_time": "Every day at 7:30", "needs": [],
             "prompt": "Use get_agenda for today and tomorrow and list_tasks. Write a short brief: what is on today, "
                       "what is due, and one thing to prepare for tomorrow.",
             "reads": "Your calendar and tasks in the app.", "changes": "Nothing.",
             "result": "A short brief in your inbox.", "risks": "None outside the app."},
        ],
        "integrations": [MAIL, GOOGLE_MS],
    },
}

DEFAULT_BUDGET_CENTS = 500  # per coworker per month; shown and editable in the proposal, 0 = no limit


_ready: set[str] = set()


def _ensure() -> None:
    from . import config

    if str(config.DB_PATH) in _ready:
        return
    db.conn().executescript("""
    CREATE TABLE IF NOT EXISTS starter_setups (
      id INTEGER PRIMARY KEY,
      profession TEXT NOT NULL UNIQUE,
      region TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS starter_items (
      id INTEGER PRIMARY KEY,
      setup_id INTEGER NOT NULL REFERENCES starter_setups(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,                 -- agent | schedule
      ref_id INTEGER NOT NULL,            -- agents.id or schedules.id
      item_key TEXT NOT NULL,
      card TEXT NOT NULL DEFAULT '{}',    -- schedules: what it reads, changes, returns and risks (JSON)
      approved_at TEXT
    );
    """)
    _ready.add(str(config.DB_PATH))


# --- connections ---------------------------------------------------------------------------------------------------------
def connected(need: str) -> bool:
    if need == "mail":
        return bool(db.one("SELECT 1 AS x FROM mail_accounts LIMIT 1"))
    return False


NEED_LABEL = {"mail": "Connect your email first."}


def _missing(needs: list[str]) -> list[str]:
    return [n for n in needs if not connected(n)]


# --- proposal ------------------------------------------------------------------------------------------------------------
def _profession(pid: str) -> dict:
    if pid not in PROFESSIONS:
        raise HTTPException(404, "That line of work is not in the list.")
    return PROFESSIONS[pid]


def catalogue() -> list[dict]:
    _ensure()
    done = {r["profession"] for r in db.all("SELECT profession FROM starter_setups")}
    return [{"id": pid, "label": p["label"], "blurb": p["blurb"], "set_up": pid in done} for pid, p in PROFESSIONS.items()]


def _card(sched: dict, agent_name: str) -> dict:
    """What the owner is asked to approve, in plain words (design record 0004, approval cards)."""
    return {"requester": agent_name, "action": f"{sched['name']} ({sched['plain_time']})", "when": sched["plain_time"],
            "reads": sched["reads"], "changes": sched["changes"], "result": sched["result"], "risks": sched["risks"],
            "choices": ["Turn on", "Not now"]}


def proposal(professions: list[str], region: str = "") -> dict:
    if not professions:
        raise HTTPException(400, "Pick at least one line of work, or skip this step.")
    out = {"region": region.strip()[:80], "professions": [], "integrations": []}
    seen = set()
    for pid in dict.fromkeys(professions):
        p = _profession(pid)
        people = [p["coordinator"], *p["coworkers"]]
        names = {c["key"]: c["name"] for c in people}
        out["professions"].append({
            "id": pid, "label": p["label"], "pack": p["pack"],
            "team": [{**c, "role": "coordinator" if c is p["coordinator"] else "coworker",
                      "monthly_budget_cents": DEFAULT_BUDGET_CENTS} for c in people],
            "schedules": [{"key": s["key"], "name": s["name"], "cron": s["cron"], "plain_time": s["plain_time"],
                           "agent": s["agent"], "needs": s["needs"], "missing": [NEED_LABEL[n] for n in _missing(s["needs"])],
                           "card": _card(s, names[s["agent"]])} for s in p["schedules"]],
        })
        for i in p["integrations"]:
            if i["key"] not in seen:
                seen.add(i["key"])
                out["integrations"].append({**i, "kind_label": KINDS[i["kind"]], "state_label": STATES[i["state"]],
                                            "connected": connected(i["key"])})
    out["costs"] = ("Each scheduled job is one run of your chosen model. With a local model it costs nothing extra; with a "
                    "paid model it is billed by your provider. Each coworker has a monthly limit you can change; at the "
                    "limit it pauses and tells you.")
    return out


# --- apply ---------------------------------------------------------------------------------------------------------------
class MemberIn(BaseModel):
    key: str
    name: str = ""
    title: str = ""
    instructions: str = ""
    monthly_budget_cents: int = Field(DEFAULT_BUDGET_CENTS, ge=0, le=1_000_000)
    include: bool = True


class ScheduleChoice(BaseModel):
    key: str
    include: bool = True


class ApplyIn(BaseModel):
    profession: str
    region: str = ""
    team: list[MemberIn] = []
    schedules: list[ScheduleChoice] = []


def apply(data: ApplyIn) -> dict:
    """Create one profession's coworkers and jobs (jobs off). Run twice: refused, nothing is duplicated."""
    _ensure()
    p = _profession(data.profession)
    if db.one("SELECT 1 AS x FROM starter_setups WHERE profession = ?", data.profession):
        raise HTTPException(409, f"{p['label']} is already set up. Change it on the team page, or remove it first.")
    edits = {m.key: m for m in data.team}
    drop_sched = {c.key for c in data.schedules if not c.include}
    coord_key = p["coordinator"]["key"]
    if coord_key in edits and not edits[coord_key].include:
        raise HTTPException(400, "The team needs its coordinator. Rename it if you like, but keep it.")
    region = data.region.strip()[:80]
    with db.tx():
        sid = db.run("INSERT INTO starter_setups (profession, region, created_at) VALUES (?, ?, ?)", data.profession, region, db.now())
        ids: dict[str, int] = {}
        names: dict[str, str] = {}
        for c in [p["coordinator"], *p["coworkers"]]:
            e = edits.get(c["key"])
            if e and not e.include:
                continue
            instructions = (e.instructions.strip() if e and e.instructions.strip() else c["instructions"])
            if region:  # used only as context; never a source of legal or professional rules
                instructions += (f"\nThe business is in {region}. Do not assume local laws, codes, taxes or standards from "
                                 "that; when they matter, say so and ask the user.")
            name = (e.name.strip() if e and e.name.strip() else c["name"])[:80]
            aid = db.run("INSERT INTO agents(name, title, reports_to, model, instructions, monthly_budget_cents, "
                         "monthly_token_limit, created_at) VALUES (?, ?, ?, '', ?, ?, 0, ?)",
                         name, (e.title.strip() if e and e.title.strip() else c["title"])[:120],
                         ids.get(coord_key), instructions[:8000],
                         e.monthly_budget_cents if e else DEFAULT_BUDGET_CENTS, db.now())
            ids[c["key"]], names[c["key"]] = aid, name
            db.run("INSERT INTO starter_items (setup_id, kind, ref_id, item_key) VALUES (?, 'agent', ?, ?)", sid, aid, c["key"])
        for s in p["schedules"]:
            if s["key"] in drop_sched:
                continue
            owner = s["agent"] if s["agent"] in ids else coord_key
            row = scheduler.create_schedule(s["name"], s["cron"], s["prompt"], "inbox", ids[owner])
            db.run("UPDATE schedules SET enabled = 0 WHERE id = ?", row["id"])
            card = {**_card(s, names[owner]), "needs": s["needs"]}
            db.run("INSERT INTO starter_items (setup_id, kind, ref_id, item_key, card) VALUES (?, 'schedule', ?, ?, ?)",
                   sid, row["id"], s["key"], json.dumps(card))
    return setup(data.profession)


# --- the setup as it is now ----------------------------------------------------------------------------------------------
def _schedule_view(item: dict) -> dict | None:
    s = db.one("SELECT * FROM schedules WHERE id = ?", item["ref_id"])
    if not s:
        return None
    card = json.loads(item["card"] or "{}")
    missing = _missing(card.get("needs", []))
    state = "on" if s["enabled"] else ("waiting" if not item["approved_at"] else "off")
    return {"schedule_id": s["id"], "key": item["item_key"], "name": s["name"], "cron": s["cron"], "state": state,
            "approved_at": item["approved_at"], "last_run": s["last_run"], "last_status": s["last_status"],
            "next_run": s["next_run"] if s["enabled"] else None, "card": card,
            "missing": [NEED_LABEL.get(n, n) for n in missing]}


def setup(profession: str) -> dict:
    _ensure()
    st = db.one("SELECT * FROM starter_setups WHERE profession = ?", profession)
    if not st:
        raise HTTPException(404, "Not set up.")
    items = db.all("SELECT * FROM starter_items WHERE setup_id = ? ORDER BY id", st["id"])
    team = [a for a in (db.one("SELECT id, name, title, status, paused_reason, monthly_budget_cents FROM agents WHERE id = ?", i["ref_id"])
                        for i in items if i["kind"] == "agent") if a]
    scheds = [v for v in (_schedule_view(i) for i in items if i["kind"] == "schedule") if v]
    return {"profession": profession, "label": _profession(profession)["label"], "region": st["region"],
            "created_at": st["created_at"], "team": team, "schedules": scheds}


def _item_for_schedule(schedule_id: int) -> dict:
    _ensure()
    it = db.one("SELECT * FROM starter_items WHERE kind = 'schedule' AND ref_id = ?", schedule_id)
    if not it:
        raise HTTPException(404, "Nothing is waiting under that name.")
    return it


def waiting() -> list[dict]:
    """Jobs from a setup that the owner has not answered yet (shown in Needs you as s:<schedule id>)."""
    _ensure()
    out = []
    for it in db.all("SELECT * FROM starter_items WHERE kind = 'schedule' AND approved_at IS NULL ORDER BY id"):
        v = _schedule_view(it)
        if v and v["state"] == "waiting":
            out.append({**v, "since": db.one("SELECT created_at FROM schedules WHERE id = ?", it["ref_id"])["created_at"]})
    return out


def decide(schedule_id: int, approve: bool) -> dict:
    """The owner's answer to a job card. Yes turns it on (only if its connection is there); no removes the job."""
    it = _item_for_schedule(schedule_id)
    s = db.one("SELECT * FROM schedules WHERE id = ?", schedule_id)
    if not s:
        raise HTTPException(404, "Nothing is waiting under that name.")
    if it["approved_at"] is not None or s["enabled"]:
        raise HTTPException(409, "Already answered.")
    if not approve:
        with db.tx():
            db.run("DELETE FROM starter_items WHERE id = ?", it["id"])
            db.run("DELETE FROM schedules WHERE id = ?", schedule_id)
        return {"schedule_id": schedule_id, "status": "denied"}
    missing = _missing(json.loads(it["card"] or "{}").get("needs", []))
    if missing:
        raise HTTPException(409, " ".join(NEED_LABEL.get(n, n) for n in missing))
    with db.tx():
        n = db.conn().execute("UPDATE starter_items SET approved_at = ? WHERE id = ? AND approved_at IS NULL",
                              (db.now(), it["id"])).rowcount
        if not n:
            raise HTTPException(409, "Already answered.")
        db.run("UPDATE schedules SET enabled = 1, next_run = ? WHERE id = ?", scheduler.next_run(s["cron"]), schedule_id)
    return {"schedule_id": schedule_id, "status": "approved", "next_run": scheduler.next_run(s["cron"])}


def remove(profession: str) -> dict:
    """Undo one setup: its coworkers and jobs go; the user's mail, tasks, notes, drafts and chats stay."""
    _ensure()
    st = db.one("SELECT * FROM starter_setups WHERE profession = ?", profession)
    if not st:
        raise HTTPException(404, "Not set up.")
    items = db.all("SELECT * FROM starter_items WHERE setup_id = ?", st["id"])
    with db.tx():
        for i in items:
            if i["kind"] == "schedule":
                db.run("DELETE FROM schedules WHERE id = ?", i["ref_id"])
        for i in items:
            if i["kind"] == "agent":
                db.run("UPDATE schedules SET agent_id = NULL WHERE agent_id = ?", i["ref_id"])
                db.run("DELETE FROM agents WHERE id = ?", i["ref_id"])
        db.run("DELETE FROM starter_items WHERE setup_id = ?", st["id"])
        db.run("DELETE FROM starter_setups WHERE id = ?", st["id"])
    return {"removed": profession}


# --- routes --------------------------------------------------------------------------------------------------------------
class ProposalIn(BaseModel):
    professions: list[str]
    region: str = ""


@router.get("")
def list_professions():
    return {"professions": catalogue(), "kinds": KINDS, "states": STATES}


@router.post("/proposal")
def make_proposal(data: ProposalIn):
    return proposal(data.professions, data.region)


@router.post("/apply")
def apply_route(data: ApplyIn):
    return apply(data)


@router.get("/{profession}")
def get_setup(profession: str):
    return setup(profession)


@router.delete("/{profession}")
def remove_route(profession: str):
    return remove(profession)
