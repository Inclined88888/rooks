# 0004: Coworkers. One assistant, a team behind it.

Status: research done, first increment on branch `feat/coworkers` (2026-11-07). Not merged.

Evidence for every claim below is in three reports, written from the code and tests rather than the docs:

1. `docs/evidence/2026-11-07-inventory-agents-tools-mcp-memory.md` (ROOKS areas 1 to 7)
2. `docs/evidence/2026-11-07-inventory-automation-apps-security.md` (ROOKS areas 8 to 14)
3. `docs/competitive/rerun.md` (Rerun, `rerun-build/rerun` at commit ab3def9, 16 components)

The labels mean this. **Works**: code plus passing tests. **Untested**: code, no test. **Documented**: prose only. Nothing here was verified against a live third party service.

## 1. Corrections to the brief

1. The brief names `Inclined88888/ai-workspace` and the branch `integration/v0.3`. AGENTS.md says the install line is `Inclined88888/rooks`, branch `main`, and that the old repo must not be merged. This work starts from `rooks` `main` at 4ccddba. `SECURITY.md:10` still points at the old repo and branch; that is a doc bug.
2. Baseline on clean `main` in a Linux container: backend 823 passed, 5 failed, 1 skipped. Four failures pass alone, so the suite leaks state between tests (`test_connect_mail_calendar::test_assistant_reads_and_drafts_with_microsoft`, `test_desk::test_desk_emails_a_render_with_attachments`, `test_health::test_status_page_reports_every_part_and_the_worst_wins`, `test_lock_reset::test_forgotten_pin_can_be_replaced`). The fifth, `test_room::test_a_private_desktop_has_a_real_screen`, fails because `mss` is declared in `rooks-try/pyproject.toml` but `scripts/test-all.sh` never installs it.

## 2. Licensing

ROOKS is proprietary (`LICENSE`). Rerun is AGPL 3.0, with `ee/` directories under a separate commercial licence, and its name, logo, coworker characters and "Foreman" are trademarks (`TRADEMARK.md`). Any copied code, or a close port of its file structure, would oblige ROOKS to publish its source under AGPL. Decision: **no code, prompts, schemas, assets or names are taken from Rerun.** Only general mechanisms are studied, and each ROOKS implementation is written from the ROOKS code outward. The word "Foreman" is not used.

## 3. What ROOKS has today

| Area | Status | Where |
| --- | --- | --- |
| Agents with roles, budgets, reporting lines ("Company") | Works, one test | `company.py`, tables `agents`, `agent_tasks`; UI under Advanced |
| Teammates with persona, model, tool groups | Works | `teammates/`, `test_grok_style.py` |
| Team lead sub agents (read only) | Works | `team/lead.py`, `test_team_lead_subagents.py` |
| Tool approval at the execution boundary | Works | `assistant.py:757 hold_reason`, `:1638 decide`, `needs_you.py` |
| MCP client (stdio, HTTP, SSE) | Works | `mcp_client.py`, `test_mcp_client.py` |
| App as MCP server | Untested as a server; skips approval | `mcp_server.py` |
| Packs (trade, legal, study) through the skill security gate | Works | `packs/registry.py`, `test_packs.py` |
| Models: 17 presets, user's own CLI plans, Auto router | Works | `llm.py`, `adapters.py`, `router.py` |
| Memory | Works, split over five stores | `adapt_facts`, `kn_*`, `memories`, `tm_notes`, terminal `memory.json` |
| Schedules (cron in local timezone, late job runs once) | Partial: no one time runs, no retries, no run history | `scheduler.py` |
| Automations (mail, calendar, site, folder triggers) | Works, no webhook trigger | `automations.py`, `test_v02_automations.py` |
| Jobs board (pause, resume, stop, recover after restart) | Works | `jobs.py`, `test_reliability.py` |
| Needs you inbox | Works | `needs_you.py` |
| Phone app (pairing, approvals, chat) | Works; push untested against Expo | `mobile/`, `push.py` |
| Desktop (Tauri) | Works; few Rust tests | `desktop/` |
| Browser and computer control with kill switch | Works | `rooks-browser`, `rooks-desk`, `rooks-try`, `room.py` |
| Accounts | One owner by design; no users or workspaces table | `security.py`, `SECURITY.md` |
| First run Welcome | Works; offers no profession or pack | `pages/Welcome.tsx` |

### Disconnections that block the brief

1. **Unattended runs refuse instead of waiting.** `assistant.py:740` treats `schedule` and `agent` channels as "nobody is there", so any action needing approval is refused with outcome `denied` and never reaches Needs you (`:939`). A scheduled coworker can therefore never do anything consequential, even with the owner's yes. This is the first fix.
2. **Three agent models.** Company agents, teammates and sub agents share no identity, budget or policy. Schedules point only at Company agents (`schedules.agent_id`).
3. **The app's own MCP server bypasses approval.** `mcp_server.py:137 run_skill_script` calls `skills_hub.run_script` directly. The only guard is the bearer key on `/mcp` (`main.py:118`).
4. **Persistent tools run without a yes on a clean conversation:** `schedule_task`, `delegate_task`, `save_skill`, `remember`, `watch_site`, `run_skill_script`. An agent can create its own schedule.
5. Welcome never offers packs; nothing in the code knows a profession.
6. No workspace model. Every table is global to the one owner.
7. The terminal reaches none of Company, Teammates, Goals or lead runs, and its MCP client is stdio only.

## 4. Rerun, in one paragraph

A Next.js app on Supabase (mandatory) plus one engine container per workspace that runs every agent in a shared Unix user. A built in coordinator builds a team from a conversation. Agents talk to each other with no hop limit. Approvals, questions and secret requests are tools the model chooses to call; **approval is enforced only by the prompt** (`apps/engine/src/tools/builtin/hitl.ts`, verified). The Claude sign in reuses Claude Code's private OAuth client id, which its own source calls undocumented (`apps/ui/lib/engine/claude-oauth.ts`, verified). The engine runs Claude Code with `bypassPermissions` and Codex with `danger-full-access` (`apps/engine/src/agents/providers.ts:286,339`, verified). Webhooks are a secret path token with no signature, replay window or rate limit. Self hosting needs 6 GB of memory and 60 GB of disk before Supabase.

## 5. Classification

| Mechanism | Class | Decision for ROOKS |
| --- | --- | --- |
| Approval enforced at the tool boundary | EXISTING | ROOKS is ahead. Keep `hold_reason`; never move to prompt enforcement. |
| Unattended runs wait for approval instead of failing | UPGRADE | Hold the call in Needs you, run it once on yes, dedupe repeats. Increment 1. |
| Coworker identity (name, role, purpose, instructions, model, budget, schedules) | INTEGRATE | Use the Company `agents` table as the one coworker record; schedules already point at it. Teammates become a view of it later, not a second engine. |
| Team built from a plain description | NEW | A profession catalogue proposes coworkers, schedules and integrations; the owner edits and approves; it is created through `agents` and `schedules`. No model call is needed to build. |
| Profession onboarding | NEW on EXISTING | One Welcome step, multi select, skippable, reversible. Packs are recommended, not separate products. |
| Integration catalogue with honest status | NEW | Each entry says native, official API, official MCP, community MCP, browser, or unverified. Increment 2, after each entry is checked against the vendor's own docs. |
| Secret form bound to a pending request, names only back to the agent | UPGRADE | ROOKS already keeps keys out of chat (`security.py`, vault). Add a request card tied to the held action. |
| Sub agents with tools off by construction and a concurrency cap | EXISTING | `assistant.py:731` and `company.py MAX_DEPTH = 3`. Keep the depth limit Rerun lacks. |
| Agent to agent calls with no hop limit | REJECT | Loops A to B to A. |
| At most once schedule firing | EXISTING | `scheduler.run_schedule` books the next slot first. |
| One time tasks, retries, run history, missed run policy | UPGRADE | Increment 3. |
| Webhook trigger | NEW | Path token plus HMAC signature, timestamp window, nonce store and rate limit. Not path token alone. Increment 4. |
| Push limits per source and per user, quiet while watching | UPGRADE | `push.py` has no rate limit. Increment 5. |
| Memory that fades by kind and is reconciled | UPGRADE, later | Consolidate the five stores first. |
| Agents propose shared knowledge, owner accepts | INTEGRATE | Same shape as skill proposals already in `skills_hub`. |
| Supabase, per workspace engine container, shared Unix user | REJECT | Heavy, and a shared user is not an isolation boundary. Keep FastAPI and SQLite. |
| `bypassPermissions` or full access CLI modes | REJECT | ROOKS drives the user's own CLI through `CliPlan` with its own guard. |
| Borrowed private OAuth client ids | REJECT | Terms of service risk. Use API keys or the user's own signed in CLI. |
| Unredacted tool logs | REJECT | ROOKS redacts (`redact.py`). |
| Multiple workspaces with private credentials | NEW, later | Needs a `workspace_id` on credentials, memory, agents and files plus a migration. Not before the slice works. |

## 6. Increment 1: the vertical slice

Goal from the brief: a new user picks a profession, gets a recommended team, connects one genuinely supported app, approves a scheduled task, watches a coworker run it, and gets a correct result.

What it uses, all existing:

1. **Profession catalogue** `app/starters.py`: static data, no model call. Each profession lists coworkers, suggested schedules with a plain explanation of what each reads and may change, and the pack it maps to.
2. **Proposal and create** `POST /api/starters/proposal`, `POST /api/starters/apply`: creates Company `agents` rows and `schedules` rows. Schedules are created **off**. Turning one on is the approval, done by the owner through the authenticated API; the agent has no route to it.
3. **Connected app**: mail by app password (IMAP and SMTP, `mail.py`). It is the one connection that works in this build with no vendor client id. Google and Microsoft one click sign in needs `oauth_clients.py` filled in and stays a later step.
4. **Run**: the existing scheduler runs the coworker on the `schedule` channel. Anything that would send or change something outside is held in Needs you (the fix above), and runs once on yes.
5. **Result**: delivered to the inbox and to the phone through the existing paths.

What is not proven by this increment:

1. No real model call is made in tests; the model is scripted, as in the rest of the suite.
2. No real mail provider is contacted. A local IMAP server is used if one can be installed in the test environment; otherwise the existing fakes, and the report says which.
3. Multiple workspaces, the integration catalogue beyond mail, webhooks and the new navigation are later increments.

## 7. Order after increment 1

1. Integration catalogue entries for construction, software and business, each checked against vendor docs, with status shown honestly.
2. Close disconnection 3 and 4: the app's MCP server and persistent tools go through `hold_reason`.
3. Schedules: one time runs, run history table, retry policy, missed run policy, tests for timezone and daylight saving.
4. Webhook trigger with signature, replay window and rate limit.
5. Push rate limits and per workspace preferences.
6. Coworker board on real state from `jobs`, `actions` and `schedules`.
7. Workspaces: schema, isolation tests, then UI.
8. Navigation: Home, Chat, Workspaces, Teams, Activity, Settings, mapped onto `pages/registry.ts`.
