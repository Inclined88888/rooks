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

## 8. Stage report: increment 1 (2026-11-07)

### Source changes

1. `assistant.py`: unattended runs (`schedule`, `agent`) hold a gated call in Needs you instead of refusing it. A repeat of the same held call from a later run of the same schedule is not asked again. When a held call from a schedule is answered, the outcome goes to the inbox under that schedule (`_report_unattended`).
2. `scheduler.py`: a run with a held step records `last_status = "waiting"` and the app itself, not the model, appends "Not done yet, waiting for your OK in Needs you" to the inbox entry.
3. `starters.py` (new): profession catalogue (construction, business, personal), proposal, apply (coworkers in `agents`, jobs in `schedules`, all off), job cards, remove. Tables `starter_setups`, `starter_items`.
4. `needs_you.py`: job cards appear as `s:<schedule id>`. Yes turns the job on, and is refused while its connection is missing. No removes the job.
5. Frontend: Welcome step 4 of 5 "What do you do?" (optional, skippable); the Coworkers page (`/coworkers`, More sheet, Workspace).

### Test results

1. Backend, full suite on commit c375aec: 827 passed, 5 failed, 1 skipped. The 5 failures are the same 5 that fail on clean `main` (section 1). No new failures.
2. New backend tests: `test_hardening.py` (2 replaced 1; both failed on the old code first), `test_starters.py` (3).
3. Frontend: type check clean, build clean, `npm test` 256 passed.
4. Real user workflow, run by hand in a browser against the built app on a fresh database: first run up to the model step, then the Coworkers page. Created the team, saw both jobs marked not ready with no approve button, connected a mailbox through the app's own app password form, saw the approve buttons appear, approved one job and declined the other. Result: the job shows On with the next run Monday 9 November 07:00 in the workspace timezone. No console errors.

### What was real and what was not

1. **Real:** the mail server. Dovecot 2.3 on 127.0.0.1 with TLS. The app's IMAP code logged in, listed and read a message appended over IMAP, and a wrong password was refused by the server.
2. **Not real:** the model. The coworker run in `test_starters.py` uses the suite's scripted model. No real model ran the job in this session.
3. **Not tested:** any public mail provider, ServiceM8, Xero, Procore, Google or Microsoft. The catalogue says so on each entry.

### Remaining limitations

1. Coworkers have no per coworker tool list yet. A scheduled run offers the full tool set; the approval gate is what limits it.
2. `schedule_task`, `delegate_task`, `save_skill`, `remember`, `watch_site` and `run_skill_script` still run without a yes on a clean conversation, and the app's own MCP server still skips approval (section 3, items 3 and 4).
3. The Needs you pill refreshes on its poll (up to 10 seconds), not right after an answer on another page.
4. The `/api/schedules` PATCH route can still turn a job on without the connection check. It is owner only, but it skips the card.
5. Only three professions. The other six in the brief are not in the catalogue yet.

### Next dependency

Section 7, item 2: put the app's MCP server and the persistent tools behind `hold_reason`. A coworker that can schedule its own jobs is the largest open risk.

## 9. Stage report: increment 2, approval gaps (2026-11-07)

### Source changes

1. `assistant.py`: `schedule_task` always needs the owner's yes (`confirm`, `SCHEDULE_ASK_REASON`), on every channel. A sentence the owner types ("every morning at 6 ...") is still saved directly by `front_door.py`, because that is the owner asking and no third party text reaches it.
2. `assistant.py`: a new `mcp` channel, treated as unattended. Any call with an `external` or `persistent` effect from it is held (`MCP_SERVER_REASON`).
3. `mcp_server.py`: `run_skill_script` no longer runs on the bearer key alone. It goes through `assistant.run_tool` on the `mcp` channel, waits in Needs you, returns `{"status": "waiting", "request": N}`, asks once however often the client repeats it, and runs once on yes. Arguments are joined with `shlex.join` and split back by the same `shlex.split` the chat tool uses, so arguments with spaces survive.

### Deliberately not changed

1. `remember`, `save_skill`, `watch_site`: still need a yes only once untrusted content is in the conversation. `test_clean_conversations_are_not_interrupted` pins that, and a fact or skill the owner asks for in a clean chat is not autonomous work.
2. `delegate_task`: only offered to Company agents, whose runs are on the `agent` channel and now hold gated calls (increment 1).
3. The other MCP server tools (notes, tasks, events without attendees, drafts, reads) are local, reversible writes or reads, the same effects that need no yes in chat.

### Tests

1. `tests/test_approval_gaps.py` (3 tests). All 3 failed on the previous commit: the schedule was created without a yes, and the skill script ran at once.
2. `tests/test_v02_core.py::test_memory_and_schedule_undo` now approves the held schedule before checking History. That is the intended change of behaviour.
3. Terminal (`rooks-code`): 203 passed, 1 failed. The failure, `test_project_sandbox_blocks_a_write_outside_the_folder`, also fails on clean `main` in this container (the tests run as root, and the project sandbox does not stop root writing outside the folder). Not caused by this change; not fixed here.
