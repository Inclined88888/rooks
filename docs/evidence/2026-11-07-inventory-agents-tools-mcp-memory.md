# ROOKS / AI Workspace: evidence inventory A (agents, teams, tools/permissions, MCP, packs/skills, models, memory)

Repo: Inclined88888/rooks (branch main at 4ccddba, working tree clean; nothing edited). Paths below are relative to the repo root.
Backend app = `workbench/backend/app`, tests = `workbench/backend/tests`, terminal = `rooks-code/rooks_code`.

## Test runs done for this inventory (offline, provider keys unset)

Venv: `/root/.venvs/aiw` exists (AGENTS.md says `~/.venvs/aiw`; `$HOME` here does not point at /root). `/root/.venvs/rooks` does NOT exist; terminal tests were run with the aiw venv.

* Backend, 22 files (test_goals, test_team_lead, test_team_lead_subagents, test_team_replies, test_grok_style, test_assistant,
  test_mcp_client, test_skills_hub, test_skill_scan, test_packs, test_bridge, test_router, test_needs_you, test_rooks_link,
  test_rooks_shared_loop, test_knowledge, test_free_providers, test_cli_agents, test_v02_automations,
  test_connect_mail_calendar, test_auth_boundaries, test_route_auth): **286 passed, 2 failed in 127 s**.
  - FAILED `test_assistant.py::test_renaming_the_assistant_renames_the_default_teammate` (assert True is False, line 140)
  - FAILED `test_knowledge.py::test_api` (integrity: "malformed inverted index for FTS5 table main.messages_fts", line 197)
  - Both PASS when run alone -> order dependent / test isolation problem (shared state between tests), not a clean pass.
* Terminal: test_delegate, test_extras, test_app_link, test_pack_cli_e2e, test_shared_loop_e2e: **32 passed**.

## Global data model facts (apply to every area)

* Single owner install. Auth = one session cookie or tokens (`security.py:152 require_user`, `:185 require_user_or_terminal`,
  `assistant_api.py:22 require_user_or_cli`, `bridge.py:35 require_bridge_key`, `security.py:207 check_bearer` for /mcp).
  There is no users table, no workspace_id, no owner_id column on any table (grep of db.py: the only `owner` column is the GitHub
  owner in `hub_skills`, db.py:271). "Workspace" in the code means the whole install.
* SQLite, `db.py` `SCHEMA_VERSION = 4` (db.py:446). Core tables in db.py; feature modules create their own tables with
  `ensure()` + `CREATE TABLE IF NOT EXISTS` (team/, teammates/, jobs.py, goals.py, packs/store.py, knowledge/schema.py, adapt/store.py ...).
* Run log: `actions` table (db.py:376) - every turn, model call, tool call, decision. Has `agent_id`, `channel`, `effect`,
  `usd_cost`, `tokens_in/out`, `outcome`, `verified`, `parent_action_id`; unique index "a held tool call is answered at most once".
* Pro gating: `account.py:189 allowed()` / `features_v02.py:77 allowed()` - every feature unlocked while billing is not live.

---

## 1. Agent creation, orchestration and delegation

### 1a. "Company" (org chart of agents with budgets) - STATUS: works (backend + UI), terminal: missing
* Code: `company.py` (100 lines). `create_task` :36, `delegate` :46 (only to direct reports, `MAX_DEPTH = 3` :18 via `_depth` :27),
  `run_task` :58 (budget stop -> `blocked`), worker `loop` :79 (one queued task every 10 s), `recover` :90, `overview` :94.
  Started in lifespan: `main.py` loops list includes `company.loop`; `company.recover()` at startup.
* Tools in `assistant.py`: `delegate_task` :676 (effect external, `when ctx.agent`), `list_team` :679; system prompt section for
  agents :1058-1062 (mission, instructions).
* Budget: `usage.py:63 agent_month`, `:74 over_budget`; checked before every model call in `assistant._run_turn` :1388-1397
  (pauses agent, yields `{"budget": True}`). Per-agent model honored: `_run_turn` uses `(ctx.agent or {}).get("model")`.
* Tables: `agents` (db.py:328: name, title, reports_to, model, instructions, monthly_budget_cents, monthly_token_limit, status,
  paused_reason), `agent_tasks` (db.py:342: parent_id, created_by board|agent:<id>, status, result, conversation_id).
* Routes (`assistant_api.py`, prefix `/api`, `require_user_or_cli`): GET `/company` :653, PUT `/company/mission` :662,
  POST/PUT/DELETE `/company/agents[/{aid}]` :690/:699/:725, POST `/company/agents/{aid}/status` :712 (refuses re-activate when
  over budget), POST/PATCH/DELETE `/company/tasks[/{tid}]` :738/:748/:762.
* UI: `frontend/src/pages/Company.tsx`, registered under section "Advanced" (`pages/registry.ts:114`).
* Tests: `tests/test_assistant.py:170 test_company_delegation_and_budget_pause` (one test: org loop rejected, delegation,
  token limit pause, cannot re-activate over budget). Passed.
* Identity/budget/approval: per-agent identity = row in `agents` + `actions.agent_id`; monthly money/token budget (enforced);
  approval policy = channel `agent` is in `UNATTENDED` (assistant.py:740), so any call that would be held is **refused**, not
  queued. Note: tools with effect external/persistent but no `confirm` (delegate_task, run_skill_script, generate_image,
  remember, save_skill, schedule_task, watch_site) run without a yes when the turn is not tainted.
* Gaps: no terminal/phone surface; one test only; tasks run serially (one at a time); company agents are a separate concept
  from Teammates and from team-lead sub-agents (three agent models, not unified).

### 1b. Team-lead sub-agents ("lead runs", B1) - STATUS: works (backend + web UI); terminal: disconnected
* Code: `team/lead.py`: `dispatch` :61 (2..6 sub-tasks, `MAX_SUBTASKS = 6` :23; each sub-task is a `jobs.create("chat", ...,
  channel="subagent")`), `tree` :85, `runs` :101, `finish_if_ready` :109 (one synthesis per run via conditional UPDATE, posts
  result into the asking conversation with `assistant._save`), `watch` :136 (poll 1 s, 1 h timeout).
* Tool: `team/tools.py` `team_dispatch` (effect write), registered by `register_tools()`.
* Safety: `assistant.available_tools` :829 limits channel `subagent` to effect=="read" and drops `team_dispatch`;
  `assistant._tool_for` :731 returns None for write tools on that channel (no recursion, no writes).
* Tables: `team_lead_runs`, `team_lead_tasks` (team/lead.py:26,35) + `jobs`.
* Routes: `/api/team/lead` and `/api/team/lead/{rid}` (team/routes.py:325,332); terminal router `/v1/rooks/team/lead[/{rid}]`
  (team/routes.py:429,434, bridge key).
* UI: `frontend/src/team/LeadRuns.tsx` (calls `/team/lead?limit=20`), imported in `team/Team.tsx:14`.
* Tests: `tests/test_team_lead_subagents.py` (4 tests: dispatch via tool, read-only sub-agent tool set at :95). Passed.
* Gap: **no code in rooks-code calls `/v1/rooks/team/lead`** (grep of rooks_code for "rooks/team" or "lead": nothing). The route
  says "rooks reads the sub-agent run tree" but the terminal never reads it -> disconnected. Terminal cannot start a lead run.

### 1c. Jobs board (background agents) - STATUS: works
* `jobs.py`: table `jobs` :33 (kind chat|browser|computer|files|playbook|automation, status queued|running|waiting|paused|done|
  failed|stopped, channel), `job_notices` :53. `create` :137, `run_job` :277, `tick` :345 (slot logic, `exclusive` :333: computer
  one at a time), `pause/resume/stop/retry` :189-226, `_deny_pending` :248, `recover` :378, `loop` :384.
* Routes: `v02_api.py` `/api/jobs` (GET terminal-readable :136, POST :141, notices :146, `/{jid}/{action}` :175), phone `/api/mobile/jobs`.
* UI: `/jobs` rail page (`registry.ts:61`, `v02/Jobs`). Terminal: `rooks_code/workroom.py:208` reads `/api/jobs`. Phone: yes.
* Tests: `tests/test_v02_automations.py`, `test_v02_integration.py`. Passed (automations file).

### 1d. Goals (durable objectives, auto-continue) - STATUS: works backend; UI missing
* `goals.py`: table `goals` :26; `create` :112, `can_continue` :229, `maybe_continue_goal` :264 (complete only via verified
  `complete_goal` receipt `receipts.py:126`; never continues past a pending approval; `HARD_MAX_ROUNDS = 50`).
  Called from `assistant._run_turn` :1587. Restart resume: `restart.py:110 _resume_goal`, :142.
* Routes: `/api/goals` CRUD + cancel/pause/resume (`assistant_api.py:250-303`).
* Tests: `tests/test_goals.py` (13 tests incl. max rounds, unverified completion, pending approval, restart). Passed.
* Gaps: no frontend page or component calls `/goals` (grep of frontend/src: nothing); no terminal command; no phone.

### 1e. Terminal delegation - STATUS: works
* `rooks_code/extras.py:348` `task` tool -> `subagent` :361: explore/plan = read-only, build = writes under parent approvals
  (`_SubUI` :386 answers "n" for read-only modes).
* `rooks_code/delegate.py`: hand a job to the user's own `claude` / `codex` CLI (Manual permission mode, denials re-asked,
  `Session` :106). Tests: `rooks-code/tests/test_delegate.py` (passed).
* App side equivalent: `cli_agents.py` / `cli_agents_api.py` (tests `test_cli_agents.py`, 13 tests, passed).
* Gap: terminal sub-agents are in-process only; they do not show up on the app's Jobs board or as lead runs.

---

## 2. AI teammates and groups (and the human "Team")

Two different things share the word "team":

### 2a. Teammates (named AI assistants) + group chats - STATUS: works (backend, UI, phone page); terminal missing
* `teammates/store.py`: tables `teammates` :20 (persona, avatar, `memory_scope` own|shared, `tools` JSON list of tool groups,
  `model`, section, is_default), `tm_sections`, `tm_notes`, `tm_conversations`, `tm_routines`. `TOOL_GROUPS` dict
  (mail, calendar, web, browser, computer, files, sites, packs, projects, automations, team = "AI company"), `TEMPLATES`.
* Tool scoping: `teammates/hooks.py:39 filter_tools` (called at the end of `assistant.available_tools`), removes send tools
  (`SEND_TOOLS` :245) and, in groups, every external/persistent/confirm/always_ask tool. `hooks.py:252 as_draft`: in a teammate
  conversation a send becomes an outbox draft (called from `assistant._run_tool`).
* Groups: `teammates/groups.py` tables `tm_groups` :29, `tm_group_messages` :37, `tm_reactions` :46. @mentions, handoffs,
  `MAX_HOPS = 4`, `run_round` :193, `post` :222.
* Routes (`teammates/routes.py`, prefix `/api`, require_user): `/teammates` CRUD :55-77, `/teammates/{tid}/chat` :81 (stream),
  notes :122/:127, routines :164, sections, `/groups` :205-225, `/vault`, `/outbox`, `/pages`, `/channels/*` (slack, discord,
  telegram, matrix, signal, whatsapp, email), `/link/*` phone link; mobile `/api/mobile/link/*`.
* UI: `/teammates`, `/groups/:id`, `/channels`, `/vault`, `/pages` (registry.ts:92-96,126). Phone: `mobile/src/app/teammates.tsx`.
* Tests: `tests/test_grok_style.py` (13 tests: templates, persona+memory+tool scope, groups, vault, outbox...), `test_more_channels.py`,
  `test_discord.py`, `test_assistant.py:~130` default teammate rename. One teammate test FAILED in the combined run (passes alone).
* Data model: per-teammate identity (id, persona, model), tool-group allowlist = a per-agent policy; no budget; no per-teammate
  approval policy beyond "never sends; group = no outbound tools".
* Gaps:
  - Teammate memory is a local `tm_notes` store. `teammates/memory.py:19 _backend()` is a swap point for `knowledge.scoped`
    which now exists (`knowledge/__init__.py:70`) but `_backend()` is never called and `knowledge.scoped` has no caller ->
    disconnected from the shared memory core.
  - No terminal access to teammates or groups (grep rooks_code: nothing). AGENTS.md "terminal, browser and app must match" is not met here.
  - Teammates are not linked to Company agents (separate tables, separate budgets/none).

### 2b. Team (human staff managed by a lead, feat/team-lead) - STATUS: works (backend, UI, phone)
* `team/store.py` tables `team_members` :25 (role, skills, encrypted contact, channel, hours, away), `team_tasks` :44,
  `team_updates` :75, `team_suggestions` :87, `team_outbox` :98, `team_channel_ok` :112, `team_notices` :118; `team/replies.py`
  `team_seen`, `team_pending`. Engine `team/engine.py` (suggest_assignee :76, rebalance :209, risk :241, check :263, today_plan :296).
  Messages to people go through `team/outbox.py` (waiting for approval unless auto-notify).
* Routes: `/api/team/*` (team/routes.py:104-382), `/api/mobile/team/*` (:388-425). Gated by `features_v02.require("team_tasks")`.
* Tools: `team_assign`, `team_status`, `team_today_plan`, `team_update_task`, `team_dispatch` (team/tools.py).
* UI: `/team` (`frontend/src/team/Team.tsx`). Tests: `test_team_lead.py` (8), `test_team_replies.py` (7). Passed.
* These are humans, not AI agents. Terminal: missing.

---

## 3. Tool execution and permission enforcement - STATUS: works (app); works (terminal); partial across surfaces

* Where tools run: `assistant.run_tool` :852 (repeat guard, `REPEAT_LIMIT = 3`) -> `_run_tool` :896: lookup (`_tool_for` :731,
  MCP via `mcp_client.resolve`), teammate draft conversion, arg parse, `hold_reason`, duplicate-held check, idempotency
  (`actions.last_change`), `v02_hooks.before_tool/after_tool` (undo history), timeout `TOOL_TIMEOUT_S = 180`, untrusted
  tainting, `receipts.verify` (check_failed when the change is not there). Terminal tool delegation: `DelegationRequired` :38.
* Tool model: `Tool` dataclass :91 with `effect` read|write|external|persistent, `untrusted`, `confirm`, `always_ask`.
* Approval decision: `hold_reason` :757 in this order: always_ask; knowledge "ask before" rules (`knowledge/improve.hold_reason`);
  `confirm` callback (send email, invites, MCP tools); tainted + external/persistent; channel `automation` + external/persistent;
  learned-routine guard (`adapt/hooks.guard`). `UNATTENDED = ("schedule", "agent")` :740 -> refused instead of held.
* Held call -> `actions` row outcome "held" with encrypted payload, push to phone (`push.approval_needed`), message to model.
  Answer: `assistant.decide` :1638 (`actions.decide` 409 on second answer; terminal-origin requests run on the terminal).
* Needs you inbox: `needs_you.py` (router `/api/needs-you`, :37; GET "" :239, POST `/{item_id}/{answer}` :245). Aggregates
  `a:` held actions, `j:` jobs waiting to start, `d:` Rooks Desk approvals, `b:` Rooks Browser approvals. Terminal can use it
  (require_user_or_terminal). Titles in plain words (`TITLES` :43).
* Security module `security.py`: auth (session cookie, CLI token, bridge key, tool key), Fernet `encrypt/decrypt` :51/:55,
  `scrub_env` :229, `throttle` :243. Not a permission policy engine.
* Terminal: `rooks_code/agent.py` `trusted_effect` :181 (trusted MCP servers / trusted folder skip asks), `Plan` effects;
  `rooks_code/shared_approval.py` `Link` :26, `ask` :81: one approval in two places, posts to `/v1/rooks/approvals`
  (`rooks_link.py:386`, GET :412, POST :425); first answer wins. Wired in `cli.py:121-138`, `tui.py:253-273`.
* Tests: `test_needs_you.py`, `test_actions.py`, `test_idempotency.py`, `test_receipts.py`, `test_hardening.py`,
  `test_auth_boundaries.py`, `test_route_auth.py` (fails if an /api route ships without auth), `test_rooks_shared_loop.py`,
  `test_mcp_client.py:207` (MCP waits for approval), `test_connect_mail_calendar.py:538` (send/invites always wait);
  terminal `test_extras.py`, `test_shared_loop_e2e.py`, `test_delegate.py`. All run ones passed.
* Data model: policy is per tool (effect + confirm) and per channel; no per-user or per-agent approval policy table; no
  allow-always store in the app (terminal has "a"/always per session). Knowledge "ask before" rules can only make it stricter.
* Gaps:
  - The app's own MCP server (`mcp_server.py`) calls services directly: `create_task`, `update_task`, `create_event`,
    `create_note`, `append_to_note`, `save_email_draft`, `run_skill_script` run without `hold_reason`/Needs you. Any client with
    the tools key (`check_bearer`) acts without a held yes. Same for the OpenAPI tool server in `tools.py`. (By design "drafts
    never send", but calendar/task writes bypass the gate.)
  - Company `agent` channel refuses held calls rather than queuing them for the user, so company agents cannot do any gated work.
  - Untainted external tools without `confirm` (run_skill_script, generate_image, delegate_task, schedule_task, save_skill,
    remember, watch_site) run with no yes on every channel.

---

## 4. MCP clients, servers and integrations

### 4a. App as MCP client - STATUS: works (backend + UI)
* `mcp_client.py` (559 lines): `StdioServer` :65, `HttpServer` :184 (streamable HTTP), `SseServer` :240 (legacy), `ensure_started`
  :403, `tool_specs` :455, `resolve` :469, `call` :486, `save_server` :514 (secrets encrypted), `public_row` :545.
  Protocol 2025-06-18. Tools join the loop as `mcp__<server>__<tool>` in `assistant.available_tools` :806-821: always untrusted
  (taints), effect external + `confirm=MCP_ASK_REASON` unless the server marks `readOnlyHint`.
* Table `mcp_servers` (db.py:414). Routes `mcp_client_api.py` prefix `/api/mcp`: GET/POST `/servers`, PUT/DELETE `/servers/{id}`,
  POST `/servers/{id}/toggle`, `/servers/{id}/test`, GET `/catalogue`, GET `/tools` (:83-159).
* UI: `pages/McpServers.tsx` ("Extra tools", Advanced, registry.ts:117) and `pages/ConnectSection.tsx` (:160, :218-219).
* Tests: `tests/test_mcp_client.py` (9 tests: stdio, http+sse, egress recorded, secrets encrypted, approval, failure),
  `test_auth_boundaries.py:164` (no app secret handed to a user MCP server). Passed.

### 4b. App as MCP server - STATUS: works, thin tests
* `mcp_server.py` (141 lines): tools search_notes, read_note, create_note, append_to_note, list_tasks, create_task, update_task,
  get_agenda, list_events, create_event, search_email, read_email, save_email_draft, list_skills, load_skill, read_skill_file,
  run_skill_script. Mounted at `/mcp`, bearer `config.TOOLS_API_KEY` (main.py guard; `security.check_bearer` :207).
* Tests: only indirect - `test_skills_hub.py:62-70` (`mcp_server.list_skills`), `test_skill_scan.py:81`, `test_mobile.py:259`
  (route auth). No test exercises the MCP protocol endpoint or the write tools. -> untested as a server.
* Gap: no approval gate (see section 3).

### 4c. Terminal MCP client - STATUS: partial
* `rooks_code/mcp.py`: `StdioServer` :22, `MCPManager` :111 - **stdio only**; a `url` server is skipped with a warning (:118-120).
  Config from rooks.toml `[mcp.servers]`, project file, plus auto desk/room servers (`config.py:309-320`). `trusted` flag per server.
* Calls run as `Plan("external", ...)` (agent.py:571-576, `_mcp` :689) -> asks unless trusted.
* Tests: `rooks-code/tests/fake_mcp_server.py` used by test_e2e, test_units, test_extras, test_calm, test_workroom.
* Gaps: app supports streamable HTTP and SSE; terminal does not. Terminal does not read the app's `mcp_servers` table, so a
  server connected in the app is not available in `rooks` (and vice versa). Different trust semantics (terminal `trusted`
  vs app `readOnlyHint`).

### 4d. Integrations: Connect Google/Microsoft, cloud mail - STATUS: works in code + tests; not configured in this build
* `connect.py`: OAuth code flow with PKCE and loopback listener (`start` :179, `complete` :242, `access_token` :358 refresh,
  `disconnect` :394 revoke). Routes `/api/connect/providers|accounts|{provider}/start|status/{state}|complete|accounts/{aid}|
  {provider}/client` (:446-477). Tables `mail_accounts` (db.py:126), `linked_accounts` (:143), `calendars` (:97).
* `cloud_mail.py`: Gmail + Graph `list_messages` :152, `get_message` :183, `send` :221, `create_draft` :249, `list_events` :282,
  `create_event` :326.
* `oauth_clients.py`: `GOOGLE_CLIENT_ID = ""`, `MICROSOFT_CLIENT_ID = ""` -> one-click connect shows "not set up in this build"
  unless env vars or a user-pasted registration. Tests mock providers.
* UI: `pages/ConnectMailCalendar.tsx`, `ConnectSection.tsx`. Tests: `tests/test_connect_mail_calendar.py` (~20 tests). Passed.

---

## 5. Work packs and skill installation

* Skills hub (GitHub skills behind a gate) - STATUS: works. `skills_hub.py`: `pipeline` :276 (fetch pinned SHA -> static scan ->
  injection scan -> permissions -> risk -> sandboxed trial), `install` :401, `set_enabled` :460, `uninstall` :470, `run_script`
  :500, `decide` :521 (runtime permission requests), `mcp_config` :540. Routes `/api/hub/*` (:571-688). Tables `hub_skills`
  (db.py:265), `skill_audit` (:285), `skill_permission_requests` (:293), `skills` (:252). Sandbox: `skill_sandbox.py`
  (Seatbelt on macOS, bwrap/unshare on Linux, fail closed; Windows not wired). Scanner: `skill_scan.py`.
  UI: `pages/Skills.tsx` (calls `/hub/*`). Tests: `test_skills_hub.py`, `test_skill_scan.py` (with test_packs: 39 tests). Passed.
* Packs (Trade, Legal, Study) - STATUS: works. `packs/registry.py`: `PACK_IDS` :22, `add` :102 (every bundled skill through
  `skills_hub.review_folder`; low risk and no extra permissions or nothing installs; rollback on failure), `remove` :158.
  Bundles in `packs/bundles/{trade,legal,study}`. Tables `packs_installed`, `pack_settings`, `trade_docs`, `trade_reminders`,
  `legal_clauses`, `study_cards`, `study_refs`, `lab_entries` (packs/store.py). Routes `/api/packs` (`packs/routes.py:12`) +
  phone routes. UI: `pages/Packs.tsx`, `PackTrade/Legal/Study.tsx`. Terminal: `rooks_code/pack_cli.py` via `/v1/rooks/packs`
  (`rooks_link.py:440,448`). Tests: `tests/test_packs.py`, `rooks-code/tests/test_pack_cli_e2e.py`. Passed.
  Note: the pack catalogue is closed (three hard-coded ids); no third-party pack format/registry.
* Skill store (curated starter skills) - STATUS: works, minimal. `skill_store.py` static `SKILLS` tuple, `listing` :102, `add` :149;
  routes `/api/skills/store` GET/POST (`assistant_api.py:440,447`). UI calls `/skills/store`. Test: `test_chat_and_store.py`.
* Terminal skills: `rooks_code/learning.py` reads `/v1/rooks/skills/{name}`, `/skills/check` (shared with app).

---

## 6. Model providers, routing and subscriptions - STATUS: works

* `llm.py`: `PRESETS` :26 (ollama, openai[responses], anthropic[messages], openrouter, gemini, groq, xai, mistral, deepseek,
  nvidia, cerebras, together, fireworks, claude-plan / codex-plan / copilot-plan [cli_plan], opencode-go/zen, compatible),
  `seed_connections` :110, `adapter` :165, `default_model_ref` :180, `list_models` :298, `context_chars` :319, `list_price` :333,
  `_record` :352 (run log + cost), `chat` :367, `stream` :400. Model refs "<connection_id>/<model>". Table `connections` (db.py:23).
* `adapters.py`: protocols `ChatCompletions` :271, `OllamaNative` :375, `Responses` :466, `AnthropicMessages` :596, `CliPlan` :719
  (runs the user's own claude/codex/copilot CLI, tools described in prompt, parsed back from text), `Adapter` :936,
  `parse_text_tool_calls` :1146, `_oauth_access_token` :146.
* `router.py` ("auto"): tiers fast/strong (`pick_tier` :266), fallback across connections (`classify` :339, `note_fail` :370,
  `_cool` :326), daily quota awareness (`quota` :388, `next_reset` :280), vision routing (`choose_vision_model` :253), `chat` :464.
  Table `router_state` (db.py:43).
* `bridge.py` `/v1` (bridge key): POST `/chat/completions` :68 (stream and not), GET `/models` :153, `/desk/handoff` :178,
  `/desk/send_email` :195. Used by rooks (`providers.py` provider "workbench", config.py:24), rooks-browser, rooks-desk.
* Subscriptions: plan sign-in `plan_signin.py` (install/sign in Claude Code / Codex from the app); app plan/billing `account.py`
  (Ed25519 entitlement; not enforced until billing live).
* Tests: `test_router.py` (31), `test_bridge.py` (9, uses the OpenAI SDK), `test_free_providers.py` (3), `test_cli_agents.py`
  (13), `test_plan_signin.py` (14), `test_harness_*`, `test_catalog_default_off.py`. Run ones passed.
* Data model: per-call cost/tokens in `actions`; per-agent budget only for Company agents; no per-teammate or per-job budget;
  no global spend cap found.
* Gap: terminal has its own provider list (`rooks_code/config.py:24-45`) duplicated from the app presets; it reaches CLI plans
  only via `-P claude-code/codex` delegate, not via the app's `cli_plan` adapter unless it goes through the workbench provider.

---

## 7. Persistent memory and shared knowledge - STATUS: works, but split across several stores (partial unification)

* Stores:
  1. `adapt_facts` (adapt/store.py:11, encrypted) via `adapt/knowledge.py` - this is what the `remember` tool writes
     (`assistant._remember` :347), what `search_memories` :393 reads, and what the terminal's `/v1/rooks/memory` (`rooks_link.py:44`),
     `/remember` :164, `/forget` :175 use. UI "About you" / "What I know about you".
  2. `kn_*` memory core (knowledge/schema.py: `kn_entities` :30, `kn_aliases`, `kn_edges`, `kn_memories` :70 with tier, scope,
     privacy, provenance, supersede/conflict; `kn_docs`, `kn_vectors`, `kn_conflicts`, `kn_filings`, `kn_changes`,
     `kn_improvements`). Mirrors adapt_facts (`knowledge/adapters.py:61 sync_adapt_facts`, `live.py:274`). Recall into the prompt
     `knowledge/live.py` + `recall.py:124`; graph tool `explore_graph` (assistant.py:374). Background loops: live index, nightly
     improve, daily backup (main.py lifespan). Routes `/api/knowledge/*` (`knowledge/routes.py`), phone read-only.
     UI: `/knowledge` "Memory" (`memory/Knowledge.tsx`).
  3. Legacy `memories` table (db.py:231) - migrated by `knowledge.migrate_legacy()`.
  4. `tm_notes` per teammate (teammates/store.py:37), not in the memory core.
  5. Terminal local fallback `memory.json` when not linked (`rooks_code/learning.py`).
* Scopes: `kn_memories.scope` defaults 'shared'; `knowledge.scoped()` (`knowledge/__init__.py:70`) exists but has no caller.
  `team/memory.py` writes team-task notes into the core.
* Tests: `test_knowledge.py` (10; `test_api` FAILED in combined run, passes alone: FTS5 index corruption reported by integrity
  check), `test_knowledge_data.py`, `test_knowledge_graph_traverse.py`, `test_knowledge_improve.py`, `test_knowledge_live.py`,
  `test_adapt.py` (16), `test_rooks_link.py` (11), `test_rooks_migration.py`; terminal `test_model_picker_learning.py`, `test_app_link.py`.
* Gaps: two sources of truth (adapt_facts vs kn_memories) kept in step by sync; teammate memory not scoped through the core;
  no per-agent (Company) memory at all; FTS5 integrity failure in a combined test run deserves a look.

---

## Cross-cutting gaps (summary)
1. Three unrelated agent models: Company `agents` (budgets, org chart), `teammates` (persona, tool groups), team-lead sub-agents
   (anonymous read-only jobs). No shared identity, budget or policy across them.
2. Terminal parity missing for Company, Teammates, Groups, Goals, lead runs (route exists, unused), HTTP MCP servers.
3. Goals have API + tests but no UI.
4. App MCP server and OpenAPI tool server bypass the approval gate for writes; MCP server has no protocol-level test.
5. No multi-user / workspace / owner model anywhere; every table is install-wide.
6. Two order-dependent backend test failures (teammate default rename; knowledge FTS integrity).
