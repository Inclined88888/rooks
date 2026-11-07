# Rerun (rerun-build/rerun @ ab3def9): research report

Read-only study of an AGPL-3.0 codebase (plus `ee/` dirs under a separate commercial licence). No code was copied; everything below describes mechanisms in my own words. I read the source and tests but ran nothing, so "implemented with tests" means tests exist, not that they pass.

Paths are relative to the root of github.com/rerun-build/rerun at commit ab3def9. ENG = `apps/engine/src`, UI = `apps/ui`, C = `packages/contracts/src`.

## 0. Architecture in one paragraph

There are two processes plus Supabase. **App/hub** (`apps/ui`, Next.js) holds users, workspaces, Boxes (`spaces`), the agent rows the board shows, notifications, the service catalogue and OAuth flows, all in Supabase (Postgres, auth, storage, realtime). **Engine** (`apps/engine`, Hono + Vercel AI SDK + libSQL) is **one Docker container per workspace**, and it runs every coworker of that workspace. Each agent is a folder under `/data/agents/<id>/` (SOUL.md, INSTALL.md, config.json, a 0600 `.env`, workspace/, skills/, memory/*.md) with per-agent SQLite files for transcripts, runs and telemetry (ENG/db/schema.ts). The engine calls the hub back over HTTP (`/api/hub`, `/api/webhooks/engine`, `/api/embed`) with one shared bearer key per engine. The mobile app (`apps/mobile`, Expo) talks to the same hub API.

---

## 1. Foreman orchestrator and coworker creation

- **Source:**
  - ENG/agents/foreman.ts:20-56. The Foreman is a built-in agent that `ensureForeman` (l.50) rewrites from code on every boot. Its tool keys are a fixed allowlist (l.20): no memory, skills, schedules, triggers or connectors. Only its model pin survives a restart.
  - ENG/http/foreman-guard.ts:8-41 lets HTTP reach only a fixed list of routes for it (chat, sessions, runs, cancel, files). A PATCH is accepted only when it touches the model fields; everything else gets 403.
  - ENG/tools/builtin/foreman.ts: the Foreman's account tools are not defined in the engine. The hub sends them as JSON-schema specs inside a per-request "brief". The engine converts each spec to a tool that calls back to the hub. Hub calls can be forced to run one at a time, with a long timeout of 180 s. "Intent" tools are UI gestures sent as transient stream parts.
  - UI/lib/foreman/tools.ts:28-73 and UI/lib/foreman/phases/spec.ts: the onboarding Foreman runs in the app. Its tool belt is **gated by phase**: a phase declares both its instructions and its reachable tools, and `activeTools` is recomputed every step. For example, `show_plan` does not exist before the interview phase.
  - UI/lib/foreman/build-team.ts:78-131+: once the user confirms the plan, the team is built **without any model call**. Boxes and agents are created in parallel. Each agent gets a draft SOUL (`onboardingSoul`) and an INSTALL script (`onboardingInstall`, l.101). That script tells the agent to set itself up with the user: connect apps via `suggest_service`, ask via `ask_user`, do the job once, rewrite its SOUL, create a schedule, then call `install_complete`.
  - UI/app/api/_services/agent.service.ts:144-195 `createAgent` checks Box permission, then the plan slot (no free slot means the agent is created disabled), then scaffolds on the engine, then mirrors a row in Supabase. If the database insert fails, the engine agent is rolled back.
  - Hub side: UI/app/api/_services/foreman-hub.service.ts:18-38 re-checks every tool name against the same allowlist the brief carried. UI/app/api/hub/route.ts:28-60: a Foreman call must carry an HMAC-signed Foreman token that names the member it speaks for (`FOREMAN_HUB_TOKEN_REQUIRED` defaults to on).
- **Dependencies:**
  - Supabase (service-role client), the engine HTTP API and a model provider.
  - OpenRouter is used for the guided onboarding (optional).
  - Firecrawl/Apify are used for website analysis (optional).
- **Security:**
  - Good defence in depth: the Foreman's allowlist is enforced on both sides, and its signed token carries the member's identity.
  - Caveat: ordinary coworkers authenticate to the hub with the shared engine key plus a self-declared agent-id header (`x-rerun-agent`, hub/route.ts:28). Any process holding the key can therefore pose as any coworker of that workspace.
- **Maturity:** implemented with tests (ENG/agents/foreman.test.ts, ENG/http/foreman-guard.test.ts, ENG/tools/builtin/foreman.test.ts, UI/lib/foreman/*.test.ts including build-team.test.ts, UI/app/api/hub/route.test.ts). `agent.service.ts` has only side tests (agent-placement, agent-rename). The README claim "answers your coworkers by your rules while you are away" was **not located** in code: documented only.

## 2. Coworker configuration, instructions and model selection

- **Source:**
  - C/agent.ts:1-170 defines the config schema:
    - a kind (user or foreman), an `enabled` flag, display name and description
    - `connectionId` / `provider` / `model` (a null model means "follow the Box default")
    - verbosity, about 26 boolean tool families (all **default on**, shell included), an MCP server list
    - self-improvement flags (tool install, SOUL edit, auto-memory)
    - a three-valued `setup.required` (null means the author never answered).
  - ENG/agents/systemPrompt.ts:261-320: the system prompt is assembled from tagged sections and split into a **stable** part (identity from SOUL, environment, operating notes, asking rules, language) and a **volatile** part (skill index, schedules, triggers, memory index, database schemas, connected services, current time). The split serves prompt caching. Relevant memories are injected into the user turn and de-duplicated against the history (l.323-345).
  - ENG/agents/availability.ts resolves the run model: the agent's pin, else the Box default, with repair when a connection disappears. Schedules and triggers can pin their own model (`automationModel`).
  - ENG/agents/factory.ts:18-30 creates the folder and writes config with mode 0600. Keys are validated before the folder exists.
- **Dependencies:** files and libSQL only.
- **Security:**
  - Every capability defaults on, including shell, self-install and MCP self-registration.
  - SOUL self-editing is allowed by default (`allowSoulEdit`).
- **Maturity:** implemented with tests (systemPrompt*.test.ts with snapshots, availability.test.ts, soul.test.ts, setup.test.ts).

## 3. Agent registration, lifecycle and execution runtime

- **Runtime:**
  - **One container per workspace, all coworkers inside it, one Unix user (`rerun`).** The Dockerfile installs Chromium (patchright), Xvfb, openbox, x11vnc, xdotool and the Codex CLI. There is **no per-agent container or sandbox**.
  - ENG/tools/sandbox.ts:7-62 jails the file tools to the agent's `workspace/`, with real-path and symlink resolution. The comment states plainly that this is defence in depth, not a boundary between users.
  - The shell (ENG/tools/builtin/shell.ts) uses `exec` with cwd set to the workspace, but it is **not confined**. Its only guard is an 8-regex denylist (sandbox.ts:64-70: `rm -rf /`, mkfs, shutdown, `dd if=`, fork bomb, ...), which is trivially bypassed.
  - The child environment is an **allowlist** of harmless variables plus the agent's `.env` (ENG/lib/child-env.ts:5-29), so engine secrets are not inherited by spawned processes.
- **Loop:** ENG/runtime/loop.ts:400-500 uses `streamText`.
  - It stops only when a HITL card has been delivered (`stopWhen` → `hitlTurnIsOver`, l.488). **There is no general step cap**; only computer actions are capped (200 per run, 60 for a CLI run, computer.ts:32-33).
  - Budget and plan-limit latches skip runs when the managed credit or the subscription is exhausted (runtime/budget-latch.ts, connections/plan-limits.ts).
- **CLI subscription providers:**
  - Claude runs through the Agent SDK with `bypassPermissions` (providers.ts:286).
  - Codex runs with `danger-full-access` and `approvalPolicy: never` (providers.ts:339, 356).
  - For both CLIs, Rerun's own tools are bridged in as an in-process MCP server.
- **Lifecycle:**
  - Agents are cached in a registry (agents/registry.ts) and can be enabled or disabled.
  - Templates are imported from tar archives under an entry allowlist, with entry-count limits and reissued webhook tokens (agents/import.ts:29-50).
  - The data-dir has a numbered migration ladder (datadir/migrations.ts). Shipped steps are frozen and snapshot-tested, and each step must be re-runnable.
  - Interrupted runs are failed at boot (runtime/reconcile.ts:17-50).
- **Security (inferred, not verified):**
  - All coworkers share one uid and one `/data` volume, so a coworker's shell can read every other coworker's `.env`, MCP OAuth tokens and SQLite files.
  - The same shell can very likely read the engine process's own environment (`/proc/<pid>/environ`, same uid) or `/data/engine.key`. That would yield the engine key and therefore hub access as any coworker of the workspace.
  - Engine API auth compares the key with plain `!==` (http/auth.ts:9; not constant-time) and is **open when no key is set**.
- **Maturity:** implemented with tests (loop.*.test.ts, sandbox.test.ts, shell tests, reconcile.test.ts, import.test.ts, datadir ladder tests).

## 4. Agent communication and delegation

- **Sub-agents (`delegate_tasks`):** ENG/tools/builtin/delegate.ts:27-130.
  - Creates **ephemeral** clone agents. Each inherits the model and keys, but these are switched off: further delegation (`delegate=false`, l.62), every HITL tool (ask, approve, secret, service), hub, schedules, triggers, call_agent, notify and self-improvement.
  - Up to 4 run concurrently. Results come back as text, files go to the shared space.
  - The clone folder, index entry and databases are deleted in `finally`.
  - **Depth limit = 1**, enforced structurally.
- **Peer messages (`call_agent`):** ENG/tools/builtin/call-agent.ts.
  - Runs the target persistent coworker headless in a new session that records its origin agent and session. It is fire-and-forget by default, or waits when `wait` is set.
  - Targets are filtered by the caller's reachable agents (`callableAgentIds` from the hub).
  - The callee only loses self-improvement (l.65) and **keeps `call_agent`**, so A→B→A chains are possible. **No depth or hop counter was found.**
- **Team view:** ENG/tools/builtin/team.ts gives read-only `team_*` tools (status, schedules, triggers, runs) through the hub. Webhook URLs are not shared.
- **Security and cost:** without a hop limit and without a step cap, loops are bounded only by budget latches and timeouts.
- **Maturity:** implemented with tests (delegate.test.ts, two call-agent tests, sub-run-watch.test.ts, team.test.ts).

## 5. Workspace and team organisation

- **Model:** workspace → Boxes (`spaces`, rectangles on a board grid) → agents. Members have `role` (admin or member) and `box_scope` (all or assigned).
  - `space_members` grants `use` (talk to it) or `manage` (configure it) on a Box.
  - A Box's `visibility` is either workspace or restricted.
  - Source: supabase/migrations/20261105121000_workspace_member_roles.sql and 20261105130000_space_access.sql:1-189.
- **Application layer:** UI/app/api/_auth/access.ts (`assertSpaceAccess`, `assertAgentAccess`, `hasAccess` use < manage).
- **Shared surfaces:**
  - a workspace "company brain" (§6)
  - a shared SQLite database (`shared_db_*`) and a shared file space (`shared_*`)
  - shared conversations, in which each turn is signed with its author (runtime/message-authors.ts).
- **Maturity:** implemented with tests (access.test.ts, ownership.test.ts, supabase/tests/space_access.test.sql).

## 6. Individual and shared memory

- **Per-agent memory:**
  - Stored as markdown files with frontmatter and mirrored into libSQL: vector top-k (1536-dimension text-embedding-3-small, computed by the hub's `/api/embed`) merged with FTS5. Without embeddings it falls back to keyword search only.
  - Ranking: cosine leads, and the keyword hit only adds a bonus (memory/store.ts:52-60). Automatic recall needs a minimum similarity of 0.25.
  - Decay: half-lives differ by kind (preference 90 days, fact 45, note 21, task 3). Access stretches the half-life logarithmically. Memories go dormant below 0.15 strength and are archived below 0.05 (memory/decay.ts:1-31; maintenance sweep in memory/maintenance.ts).
  - Write reconciliation: an exact duplicate is skipped. Otherwise a cheap model decides whether the new note updates an existing one, choosing only among ids it was shown (memory/reconcile.ts:19-48).
  - A post-run "curator" (runtime/curator.ts) proposes one durable memory per exchange. The prompt pushes how-to knowledge into skills, not memory.
- **Shared memory:**
  - The "company brain" is a set of markdown pages, chunked, embedded and linked (brain/*.ts).
  - Coworkers **propose** edits (brain/proposals.ts). Each proposal carries a content fingerprint so a dismissed one is never proposed again, plus the base hash of the page as it was read, which flags proposals that have gone stale.
  - A person accepts or dismisses each proposal, through the Foreman or the UI. A direct write is refused when no person is in the conversation (tools/builtin/brain.ts, "NO_PERSON_HERE").
  - Pages written by the seed stay marked "unconfirmed" until a person touches them (brain/pages.ts:13-43).
- **Maturity:** implemented with tests (memory/*.test.ts, brain/chunks/pages/search tests, http/routes/brain.test.ts, curator tests). `brain/proposals.ts` has no dedicated unit test; it is covered via the route test.

## 7. Skills and tool permissions

- **Skills:**
  - Each skill is a `skills/<slug>/SKILL.md` with frontmatter plus bundled files (skills/loader.ts, frontmatter.ts).
  - Only an index goes into the prompt; the agent loads a skill on demand (`skill_read`).
  - `skill_propose` (tools/builtin/skill-propose.ts) does not pause the turn: the user approves a small row in the chat, and then a background pass writes or edits the skill (skills/apply-proposal.ts). Proposals left half-done when the engine stops are failed on boot.
- **Tool permissions:**
  - Granularity is the tool **family**: the booleans in config (C/agent.ts:23-50), applied in ENG/tools/registry.ts:36-86.
  - There is no per-tool or per-MCP-tool allowlist and no permission rules by argument.
  - Self tools (`tool_install` = npm into the workspace; `mcp_register` with stdio, sse or http) are gated only by self-improvement flags that default on.
- **Security:** an agent can give itself arbitrary code execution (stdio MCP, npm install), although shell is already arbitrary.
- **Maturity:** implemented with tests (skills/*.test.ts, skill-propose.test.ts, three self.*.test.ts files).

## 8. MCP and external service integration

- **Catalogue:**
  - Service manifests are stored as JSONB in a Supabase `services` table, seeded from the 4.6 MB `supabase/seed.sql` ("200+").
  - Each manifest lists auth methods (API key form, OAuth, managed, Composio, paid app) (UI/lib/services/manifest.ts, UI/app/api/_services/services.service.ts:402-466).
  - `installService` compiles a manifest into MCP server entries, env keys and skills on the agent. When credentials are missing it returns `needs_config` or `needs_auth`, and the UI shows a card.
- **MCP OAuth:**
  - The hub runs authorization-code + PKCE + dynamic client registration (UI/lib/mcp-oauth.ts). PKCE state goes in an httpOnly cookie.
  - The token is handed to the engine token store: a 0600 JSON file per server (ENG/tools/mcp-auth.ts:165, 189). It is **never stored in Supabase**.
  - Device-code sign-in is also supported for MCP servers that agents register themselves (tools/builtin/self.ts).
- **Credentials:**
  - Plain-text 0600 files on the engine volume (agent `.env`, connection `.env`, MCP tokens). There is no encryption at rest.
  - API keys for the hub's own MCP server (UI/app/api/mcp/account) are stored only as hashes (UI/lib/mcp/api-keys.ts).
- **Placeholders:**
  - Configs reference secrets as `${KEY}`, which is resolved only from the **agent's** env, never the engine's, except the public hub URL (ENG/tools/mcp-resolve.ts:11). This stops a template archive from exfiltrating the engine key.
  - MCP connections are pooled across runs (mcp-pool.ts). npx servers are installed once and refreshed daily unless pinned (mcp-packages.ts).
- **External hosted dependencies:** Composio (Google and Microsoft families) and "managed" OAuth (Rerun-owned clients, cloud).
- **Rerun as an MCP server:** the same account toolset the Foreman uses is exposed to external MCP clients (UI/lib/mcp/account-tools.ts).
- **Maturity:** implemented with tests (mcp*.test.ts in ENG/tools, UI/lib/mcp-oauth.test.ts, services tests, mcp-account.service.test.ts).

## 9. Browser and computer execution

- **Browser:**
  - Patchright Chromium with a persistent profile per agent, on a virtual X display (ENG/tools/builtin/browser.ts, tools/virtual-display.ts).
  - **Every request is filtered** to public http(s) hosts, judged by DNS resolution and cached per hostname (`publicRequestsOnly`, browser.ts:50). This is an SSRF guard; it is weaker against DNS rebinding than per-connection pinning.
  - Cookie-consent auto-click; bot-wall detection (tools/bot-wall.ts).
- **Computer use:**
  - Xvfb + openbox + xdotool + maim screenshots, with a fixed action vocabulary (computer.ts:22). Screenshots are settled before capture.
  - One screen per agent with an owner lock, so other runs wait. Scheduled runs skip when the coworker is busy and needs the screen (scheduler.ts).
- **Watching and takeover:**
  - x11vnc is reached over a WebSocket bridge (desktop/bridge.ts) with **one-minute HMAC tickets** that name the agent and the mode, watch or drive (desktop/ticket.ts:18). This keeps the engine key out of the browser.
  - `request_takeover` (a HITL card) hands the browser to a person for captchas and sign-ins. A click from the person pauses the agent; staying on the screen sends it away (computer.ts:101-103, desktop/takeover.ts).
- **Maturity:** implemented with tests (browser.test.ts, computer.test.ts, desktop/*.test.ts).

## 10. Scheduled jobs and webhook triggers

- **Scheduler:** ENG/runtime/scheduler.ts.
  - 30 s tick over agents on disk, with schedules stored as files (schedules/loader.ts, cron.ts).
  - **At-most-once**: an occurrence is stamped as fired *before* launch (l.45), so a crash loses that occurrence rather than repeating side effects.
  - Firing collapses on an in-flight key per agent/schedule. Runs skip and stay due when a budget or plan latch is set or the coworker is busy.
- **Triggers:** ENG/http/routes/triggers.ts:62-77 and UI/app/api/t/[agentId]/[slug]/[token]/route.ts.
  - The public URL embeds a **random bearer token in the path**, compared in constant time on the engine.
  - Every failure answers 404 so trigger existence cannot be probed. Methods are allowlisted, token rotation exists, and the body is capped (hub cap, then 64 KB into the prompt with escaping, triggers/message.ts).
  - "Passive visits" (link unfurlers, mail scanners, clipboard previewers, detected via Sec-Fetch and user-agent) never fire a run (UI/lib/triggers/passive-visit.ts). HEAD and OPTIONS never fire.
  - **No HMAC signature, no timestamp or nonce replay protection, no rate limit, no dedupe**; this is deliberate (trigger-runner.ts:12-13: each call is a distinct event).
- **Maturity:** implemented with tests (scheduler.test.ts, schedules/*.test.ts, triggers tests, trigger-runner.test.ts, two route tests, the t/... route.test.ts).

## 11. Checkpointing, approvals and resumption

- **HITL tools:** ENG/tools/builtin/hitl.ts:9-318 defines `ask_user`, `request_approval`, `suggest_service`, `request_secret`, `request_mcp_sign_in` and `request_takeover`.
  - Their `execute` does nothing but return a "delivered, end your turn" acknowledgement. The loop stops on that step.
  - The pending card is found by scanning the transcript for the last unanswered HITL call (`findPendingHitl`, l.50). An invalid or failed call is not counted as pending.
  - The user's answer is serialized by a shared contract (C/chat-hitl.ts: answers, approval decisions, "cancelled" sentences, secret *names only*). It goes back as the next user message, and a new run continues from the full history.
- **Checkpoints:** the only checkpoint is a *compaction* summary checkpoint (db/repos/checkpoints.ts). There is no execution snapshot.
- **Resume after a crash:** interrupted runs are marked failed at boot and announced, limited to the last 24 h and at most 20 runs (runtime/reconcile.ts:12-13). There is no automatic continuation.
- **Duplicate side effects:**
  - There are **no idempotency keys** on tools.
  - Prevention is structural: (a) a HITL turn ends before acting and a fresh run replays history, so tools are not re-executed; (b) schedules are at-most-once; (c) an OpenRouter step is replayed only when the cut came before any irreversible part reached the run (agents/openrouter-stream-retry.ts:21-42).
- **Approvals are advisory:** nothing in the engine prevents a send, pay or delete tool from running without approval. Enforcement rests on prompt instructions (systemPrompt.ts:158, the hitl.ts:224 description), and "standing go-aheads" are explicitly allowed.
- **Maturity:** implemented with tests (hitl.test.ts, loop.settle.test.ts, reconcile.test.ts, contracts consumers, UI chat-hitl.test.ts). Approval *enforcement* does not exist.

## 12. Live execution monitoring and audit logs

- **Telemetry:** per-agent SQLite tables (ENG/db/schema.ts:34-91).
  - `runs`: status, trigger source and slug, model, tokens, cost, error.
  - `run_steps`: per-step tokens, cost, finish reason, duration.
  - `tool_calls`: **full input and result JSON**, error flag, duration, with no redaction seen (db/repos/telemetry.ts:10).
- **Live streams:** an in-memory per-run buffer lets the dashboard attach late and replay; it is evicted 3 min after the end (runtime/run-streams.ts). Sub-run progress is shown as stream parts (sub-run-watch.ts).
- **Hub mirror:** the engine posts session, run and terminal events to `/api/webhooks/engine`, authenticated with the engine key, which feeds notifications, the inbox and `team_status`. There is also a weekly "rewind" report (ENG/rewind, UI/trigger/weekly-rewind.ts).
- **Audit gap:** there is no tamper-evident or append-only audit log. The record is run telemetry plus `granted_by` on Box grants.
- **Maturity:** implemented with tests (run-streams, run-events, runs route, stats tests).

## 13. Workspace isolation and access control

- **Between workspaces:**
  - Separate engine containers and data volumes.
  - The hub authenticates each engine key to exactly one workspace (`authenticateEngineToken`), and agent ids are checked to belong to it (hub/route.ts:54-55).
- **RLS:**
  - About 60 `create policy` statements across 36 migrations that enable RLS.
  - The Box access model uses SECURITY DEFINER helper functions (`visible_space_ids`, `manageable_space_ids`, `visible_agent_ids`, `manageable_agent_ids`; space_access.sql:63-120) with fixed search_path and execute grants revoked from public.
  - The tables open to the browser are granted column by column.
- **The real gate is the server:** most server code uses the service-role client (about 490 call sites), which **bypasses RLS**. Authorization therefore lives in application code (`_auth/access.ts`), and RLS mainly protects browser and realtime reads.
- **Tests:**
  - One pgTAP file, `supabase/tests/space_access.test.sql` (28 assertions, admin / all / assigned scopes, rolled back).
  - CI (`.github/workflows/ci.yml:36-43`) starts the database and applies migrations but **does not run `supabase test db`**.
  - Sensible small details: the secret-answer path accepts only `use` access, and only the keys the engine's pending request names, re-read from the engine rather than taken from the client (UI/app/api/_actions/agent.actions.ts:271-291).
- **Inside a workspace:** coworkers are not isolated from each other (§3).
- **Maturity:** implemented with tests. The RLS tests exist but are not wired into CI.

## 14. Mobile notifications and remote access

- **Push:** Expo push service (UI/app/api/_services/push.service.ts; Expo holds the APNs credentials).
  - Limits per recipient: 3 pushes per hour per source and 20 per hour per user; over the cap they are dropped, never batched (UI/lib/notifications/push-limits.ts).
  - Recipients come from routing reasons (UI/lib/notifications/routing.ts). Presence heartbeats suppress email and push while someone is actually watching, and a visible but stale tab does not count (presence.ts).
  - Per-coworker modes: default, everything, muted.
- **Mobile app:** Expo app with chat, HITL cards (same contract), inbox, desktop viewer (apps/mobile/src/app/desktop.tsx) and phone or SMS sign-in.
- **Remote servers:** "pairing": a server started with a one-time pair token creates its own key, keeps it in its data-dir and hands it to the app, which calls back (ENG/pairing/pairing.ts).
- **Maturity:** implemented with tests (push-limits, routing, presence tests; about 52 mobile tests including notifications/push.test.tsx).

## 15. Subscription and API model providers

- **Providers** (C/agent.ts providerSchema): rerun (managed credit, `ee`), anthropic, claude (subscription via Agent SDK), codex (ChatGPT subscription via Codex CLI app-server), openai, google, openrouter, opencode, and custom (any OpenAI-compatible server, e.g. Ollama or vLLM).
- **Connections:** stored on the engine as `connections/<id>/config.json` plus `.env` (ENG/connections/store.ts), shared by every agent of the Box.
- **Subscription sign-in:**
  - Claude uses a PKCE flow that **reuses Claude Code's public OAuth client id**, which the code itself describes as undocumented and private (UI/lib/engine/claude-oauth.ts:1-31). The user pastes back a code.
  - Codex uses the OpenAI device-code flow (codex-oauth.ts).
  - Tokens are refreshed by the engine (connections/claude-token.ts, codex-auth.ts). Plan-limit latches read subscription limits.
- **Model tiers:** "Rerun" tiers are aliases resolved by the hub, so a model change is a hub deploy, not a fleet update.
- **Maturity:** implemented with tests (providers.test.ts and gaps tests, connections tests, opencode tests).

## 16. Self-hosted deployment requirements

- **Mandatory:**
  - Supabase with Postgres, GoTrue auth (email OTP via **custom SMTP**; anonymous sign-ins on), storage and realtime. Either supabase.com or `npx supabase start` (local stack, documented as single-user and not for internet exposure).
  - Docker Compose with `app` (Next.js) and `engine`. Node 22 and Git.
  - At least 6 GB of memory for Docker (the app build), 60 GB of disk (about 40 GB of images and cache), 16 GB if Supabase is co-hosted. The engine needs a 2 GB `shm_size` for Chromium.
  - Three generated secrets: the engine key, the Foreman hub token secret and the board image secret (`scripts/self-host-check.mjs`).
- **Optional:** OpenRouter (Foreman onboarding, embeddings), Composio, Brave, Firecrawl, Apify, PostHog, Turnstile/hCaptcha, Trigger.dev tasks (`apps/ui/trigger`, mostly cloud jobs).
- **Network:** Docker publishes ports past ufw, so the docs tell users to close 3000, 3001, 5432, 6543 and 8000 at the provider. The engine needs TLS through a reverse proxy.
- **Maturity:** documented (INSTALL.md, apps/docs/self-host/*.mdx) with a check script; CI builds the images.

## Questions, approval cards, app connections and credential collection

- **Questions** (`ask_user`): batched questions, each with an optional header, options (2 to 6, no "Other") or free text, and multi-select. The answers are serialized into a fixed sentence shape so web and iOS speak one protocol.
- **Approvals** (`request_approval`): 1 to 20 short action plus detail items in one card, so the user decides them together. The decisions go back as text. Declined means "do not do it, no workaround" (prompt-enforced only).
- **App connection** (`suggest_service`): the agent names catalogue slugs. The UI shows one setup card per app (key form, OAuth popup, Composio, account picker) with possible alternatives. The outcome per app (connected, skipped, reset, not-found, or a replacement) goes back as text.
- **Credentials** (`request_secret`): the agent names environment-variable keys (upper snake case) with label, help and docs link, max 8. The UI renders a **masked form outside the chat**. On submit, a server action:
  1. checks the caller has `use` on the conversation,
  2. re-reads the pending request **from the engine** and refuses any key it did not name,
  3. writes the values straight into the agent's `.env` on the engine.

  The agent's run resumes with **only the names** of the filled variables. The agent then refers to them as `${KEY}` in MCP configs or shell. The tool descriptions forbid asking for secrets in chat. The MCP sign-in card and takeover follow the same pattern: tokens never pass through the model.
- **Turn discipline:** a card must be accompanied by a message. A model that sent a bare card gets exactly one extra no-tool step to write it (`hitlStepLacksMessage`, then `toolChoice: none`).

---

## Mechanisms worth adapting (concepts only) for a FastAPI + SQLite single-user assistant

1. **HITL as "end-of-turn" tools plus transcript-derived pending state.** The tool only acknowledges, the loop stops, the pending card is recomputed from the last unanswered call, and the answer is a structured user message under one shared protocol for every surface (web, terminal, desktop). No separate state machine can drift from the transcript.
2. **Out-of-band secret form bound to the pending request.** The server accepts only the keys the stored request names, re-read server-side. Values go straight to the key store, the model gets names only, and configs use `${KEY}` placeholders resolved from the agent's own scope, never the app's own environment.
3. **Allowlisted child environment** for every spawned process (CLIs, MCP servers, shell): pass a small fixed set of harmless variables plus the agent's own keys, so app secrets never leak to tools.
4. **Phase- or state-gated toolsets** (recomputed per step): a tool that should not be called in this state is simply not offered, instead of being forbidden in the prompt.
5. **Structural delegation limits:** sub-agents get a copied config with delegation, questions, schedules and notifications switched off, a small concurrency cap, and guaranteed cleanup. Add the hop counter Rerun lacks for peer calls.
6. **At-most-once scheduling:** stamp an occurrence fired before launch, collapse in-flight duplicates, skip-but-stay-due when busy or over budget. Pair it with honest "interrupted by restart" notices at boot, capped by age and count.
7. **Memory hygiene:** decay with a half-life per kind, stretched by access; dormant and archive thresholds; an exact-duplicate skip followed by an LLM "does this update id X" choice restricted to shown ids; semantic score leading with a keyword bonus; inject memories once per conversation.
8. **Proposals for shared knowledge and skills:** agents propose, a person accepts. Use a content fingerprint so dismissed proposals never return, a base hash to flag stale ones, and refuse writes when no person is in the conversation.
9. **Webhook front door hygiene:** an unguessable path token compared in constant time, uniform 404s, method allowlist, body cap and escaping before the prompt, and **never firing on link-preview or scanner visits** (Sec-Fetch and user-agent heuristics, HEAD and OPTIONS). Add the HMAC signature, timestamp window and rate limit Rerun lacks.
10. **Short-lived signed view tickets** for live screen or desktop streams (HMAC, about 60 s, scoped to one agent and watch/drive mode) instead of putting the main key in a WebSocket URL. Also "a person's click pauses the agent".
11. **A stable versus volatile prompt split** for cache efficiency, with indexes only (skills, schedules, memories) and on-demand reads.
12. **Frozen, re-runnable migration ladders** with a test per step from the previous version, plus read-only "doctor" checks. This strengthens the existing `SCHEMA_VERSION` approach.

Also nice: a cheap SSRF guard for the browser (route every request through a "resolves to a public address" check); push limits per source and per user, plus presence-based suppression; untrusted template import through an entry allowlist with count limits and token reissue.

## Approaches to REJECT for this context

- **Supabase (Postgres + GoTrue + realtime + storage) and a two-tier hub/engine split.** Several GB of RAM, SMTP setup, and about 490 service-role call sites with RLS largely bypassed: a lot of complexity for one user. SQLite plus in-process auth fits better.
- **One shared container per workspace presented as isolation.** Same-uid coworkers can read each other's secrets, and a regex command denylist is not a security boundary. For a single user, either be honest that there is no isolation (like the existing Room honesty rule) or use real OS-level sandboxing per agent; do not imitate the denylist.
- **Prompt-only approvals.** For a "nothing leaves without a yes" rule, approvals must be enforced in the tool layer (side-effecting tools require a stored approval token). Rerun's advisory approvals and "standing go-ahead" interpretation are too weak.
- **CLI providers in `bypassPermissions` / `danger-full-access` mode.** Keep the CLIs' own permission systems, or run them in a real sandbox.
- **Reusing Claude Code's private OAuth client id** to mint subscription tokens. It is undocumented, revocable and a terms-of-service risk. Driving the user's own installed CLI (as `CliPlan` already does) is safer.
- **Unbounded agent loops** (no step cap, no call-agent hop limit). Add explicit caps.
- **Logging full tool inputs and results unredacted** in telemetry. This conflicts with "secrets never in logs"; redact or truncate.
- **Webhooks without signatures, replay windows or rate limits.** Adapt the front door, add the missing protections.
- **Composio, managed OAuth via a vendor-held client, and a 4.6 MB seeded catalogue with JSONB manifests.** Hosted third-party dependency and cost; for a single user, a small curated list plus provider-native sign-in (already the mail rule) is enough.
- **Expo push via Expo's service, a phone/SMS sign-in stack, Trigger.dev and PostHog.** Cloud services that do not fit a private, self-hosted single-user app.
- **Licensing:** AGPL-3.0 code, plus `ee/` dirs under a commercial licence. Adapt ideas only; do not port code or file structure verbatim into `Inclined88888/rooks`.
