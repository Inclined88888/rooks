# ROOKS inventory B (areas 8 to 14, plus onboarding)

Read-only research on Inclined88888/rooks, branch main at 4ccddba, 2026-11-07. Paths are relative to the repo root.
"Tests ran here" means I ran them in this sandbox. Provider keys were unset and no model was called.

Tests ran here:
- Backend subset: automations, needs_you, presence, pulse, room, mobile, account, auth_boundaries, route_auth, telegram, reliability, desktop, packs, siwc_onboarding. Result: **166 passed, 1 failed** (`test_room.py::test_a_private_desktop_has_a_real_screen`, screenshot returned 500).
- rooks-try: **26 passed, 2 failed**, both `ModuleNotFoundError: mss`.
- Frontend node tests: not run, because `node_modules` is not installed in this checkout.

Cause of the failures: `mss` is declared only in `rooks-try/pyproject.toml:13`. `scripts/test-all.sh` installs only the backend requirements into `~/.venvs/aiw`, so on any machine that has Xvfb, the Room screenshot tests fail under `test-all.sh`. This is an environment and harness gap, not a logic bug I could show.

---

## 8. Browser and computer control. STATUS: works (helpers), partial (integration and local harness)

### rooks-browser (`rooks-browser/rooks_browser/`)
- Playwright drives the installed Chrome or Edge, or Chromium, or attaches over CDP. Each run gets a throwaway profile: `browser.py:1-27`, `installed_browsers()` at :29.
- Site allow and deny lists are checked on every frame. Sensitive actions (`submit`, `purchase`, `message`, `login`, `download`) need a yes: `policy.py:1-27`, `CATEGORIES`. The agent never fills password fields.
- HTTP job server with token auth: `server.py` `class Jobs` :42, `make_handler(jobs, token)` :219, `serve()` :343.
- Also in the package: `mcp_server.py`, `recorder.py` (used by "Show me how"), `receipts.py`, `redact.py`.
- Tests: `rooks-browser/tests/`, about 64 tests (`test_e2e.py` 16, `test_units.py` 18, `test_server.py` 7, `test_mcp.py` 4, and others). They run in CI (`.github/workflows/ci.yml:151-178`) but are **not in `scripts/test-all.sh`**.

### rooks-desk (`rooks-desk/rooks_desk/`)
- Agent loop: screenshot, then the accessibility tree, then a policy check, then one action. Each step writes a receipt and a screenshot: `agent.py:1-11`.
- Backends: `backends/linux.py`, `macos.py`, `windows.py`, `fake.py`.
- Kill switch: hotkey, mouse in the corner, a STOP file, or Ctrl+C. `killswitch.py:1-30`, `class KillSwitch`.
- `policy.py` (`NEVER_PREAPPROVED`, `classify_gui`), `server.py`, `mcp_server.py`, `shell.py`.
- Tests: `rooks-desk/tests/`, about 44 tests, plus real-desktop end-to-end tests in CI (`ci.yml:181-268`). **Not in test-all.sh.**

### rooks-try, the Room (`rooks-try/rooks_try/`)
- `room.py` `class TryRoom` picks a driver. The driver order is qemu, then nested (Xvfb), then display, then shell: `room.py:17-36`, `drivers/`.
- Tests: `rooks-try/tests/test_room.py` has 28 tests. Two failed here because `mss` is missing (see above).

### App side
- `workbench/backend/app/room.py` exposes `/api/room` (`router` :35, plus a `terminal` router for the rooks terminal at :37). Routes: status, up, down, checkpoint (:493), reset (:499), run, click, drag, scroll, type, key, handoff (:536), screenshot (:547).
- A hand-off waits as a held action in Needs you and copies only after a yes: `request_handoff` :348, `approved` :395, `perform_handoff` :401. Every call is audited (`_audited` :450).
- Tests: `workbench/backend/tests/test_room.py` has about 26 tests covering honesty, handoff, auth and remote helper behaviour. One failed here (environment, see above).
- Proxies:
  - `browser_proxy.py`: `/api/browser`. It needs `BROWSER_URL` and `BROWSER_API_KEY`, and answers 503 without them.
  - `desk_proxy.py`. Tests: `test_desk.py` (9), `test_surfaces.py` (2).
- The desktop sidecar starts `rooks-browser serve` and sets `BROWSER_URL`: `desktop/sidecar/workbench_server.py:19,259,412`.
- Frontend: `pages/Browser.tsx` and `pages/Computer.tsx` are hidden unless the helper is running (`registry.ts` `addon`, `allowed()`). `pages/Room.tsx` and `room/*`. Test: `tests/workroom-room.test.mjs`.

### Gaps
- There are two browser agents:
  - `browser-agent/` is the older one, built on browser-use. It is used only by the Docker `browser` profile (`docker-compose.yml:193-215`) and has its own CI job (`ci.yml:105-120`).
  - `rooks-browser/` is the one used by the desktop and install.sh.
  - Both speak to `browser_proxy`. Which one is canonical is undocumented, and the duplication can drift.
- `scripts/test-all.sh`, which AGENTS.md treats as the gate before pushing, skips rooks-browser, rooks-desk, browser-agent and mobile. It also does not install the `mss` dependency the Room needs.

---

## 9. Scheduled tasks, triggers and background execution. STATUS: partial (works, but three overlapping schedulers and no webhook trigger)

### A. "Scheduled tasks" (`workbench/backend/app/scheduler.py`)
- Table `schedules` (`db.py:304`): `cron`, `prompt`, `deliver` (inbox or telegram), `agent_id`, `enabled`, `next_run` (UTC ISO), `last_run`, `last_status`.
- Timezone: cron is read in the workspace timezone (`_tz()` :17 uses `assistant.timezone_name()` at `assistant.py:118`), and `next_run()` :24 stores UTC.
- Missed runs: a late job runs **once**, not once per missed slot. `run_schedule` :58 books the next slot first. Docstring at :1-2.
- Retries: **none**. Booking the next slot first is deliberate, so a failure never loops. Errors go into `last_status`.
- One-time runs: **none**. The only scheduling form is a 5-field cron (`validate` :31). "Run now" exists: `POST /api/schedules/{sid}/run` (`assistant_api.py:520`).
- Pause and resume: the `enabled` flag, via `PATCH /api/schedules/{sid}` (`assistant_api.py:505`).
- Run history: **no history table**. Only `last_run` and `last_status`, plus each run's output as an `inbox` row (`db.py:318`), a new conversation, and the `actions` run log.
- Loop: `scheduler.loop` polls every 30 s (`main.py:78`).
- Tests: `test_assistant.py:84` `test_schedule_runs_and_delivers_to_inbox`. **No test found** for timezone handling, missed-run collapse in this module, or `loop()`.
- UI: `pages/Automations.tsx` (schedules, presets, inbox).

### B. Trigger automations (`workbench/backend/app/automations.py`, 755 lines)
- Table `automations` (:34): `trigger_kind`, `trigger`, `action_kind`, `action`, `ask_first`, `enabled`, `state`, `fired`, `last_fired`, `last_checked`, `last_result`, `last_error`.
- Triggers (:56): email, calendar, site, folder, schedule, share.
- Actions (:57): task, playbook, analyse_file, draft_email, add_event.
- Check intervals: `CHECK_EVERY` (:58). Safety cap: `MAX_FIRES_PER_HOUR = 10` (:59), enforced in `fire()` :512.
- Plain English parser (`parse()` :312), no model needed.
- First check only primes state, so nothing fires for the past. Folder: `_folder_events` :612. Email: `check` :663-693.
- Event data is marked untrusted in the prompt (`UNTRUSTED`, `build_prompt` :490).
- A schedule trigger uses `scheduler.next_run` (timezone aware) and also collapses missed runs (`_schedule_events` :648).
- Free-plan limit: `_within_plan` :696 and `create` :383 (402 error).
- Loop: `automations.loop` runs every 20 s (:749, wired in `main.py:80`).
- Routes (`v02_api.py:68-124`): list, offer, from-habit, parse, create, patch, delete, test, check, share.
- Pause and resume: `enabled`, via PATCH. The UI checkbox is at `v02/TriggerAutomations.tsx:145`.
- Run history: each firing is a `jobs` row with `automation_id`. The automation keeps `last_result` and `last_error`.
- Tests: `test_v02_automations.py`, 20 tests. They cover parsing, the free limit, folder priming plus ask-first, untrusted email, a due schedule (`:139`), the hourly cap (`:147`), share needing pairing, pause, resume, stop, retry, and the single-job rule on Free. All passed here.

### C. Jobs board (`workbench/backend/app/jobs.py`)
- Tables: `jobs` (:33) and `job_notices` (:53).
- Statuses: queued, running, waiting, paused, done, failed, stopped.
- Controls: `approve_start` :172, `pause` :184 (cancels the task), `resume` :199, `stop` :208 (denies pending approvals), `retry` :222 (manual only).
- Limits: 3 parallel jobs on Pro, 1 on Free. Computer use is exclusive (`_slots_free` :343).
- Restart: `recover()` :380 sets running jobs to paused, and they are resumed by hand. Test: `test_reliability.py:182-191`.
- `MAX_TURNS = 6` continuation turns after approvals.
- Routes: `v02_api.py:141-175`. UI: `v02/Jobs.tsx`. Mobile: `mobile/src/app/jobs.tsx`.

### D. Other background loops (`main.py:78-101`)
- `sites.loop` (`sites.py:1052`, table `site_watches`)
- `company.loop` (`company.py:78`)
- `team_loop.loop` (`team/loop.py:23`)
- knowledge live, improve and backup loops
- teammates `background()` (`teammates/routes.py:608`)
- Mapping tables: `tm_routines` maps automation to teammate; `adapt_routines` maps schedule to playbook.

### Webhooks
- **No generic inbound webhook trigger.** `webhook` is not one of `TRIGGERS`.
- The only inbound webhook is WhatsApp: `POST /hooks/whatsapp` (`teammates/routes.py:497`, `more_channels.py:403`). It checks the HMAC-SHA256 `x-hub-signature-256` with `compare_digest` (:370-374).
- **No timestamp or nonce replay protection** on that webhook. Discord/Slack gateway messages are de-duplicated (`teammates/channels.py:355`). For WhatsApp I found no message-id de-duplication.
- Test: `test_more_channels.py`. I did not verify a signature test case line by line.

### Gaps
- Three overlapping mechanisms for timed work: `schedules`, `automations` with a schedule trigger, and site watches. The UI shows two of them on one page (`Automations.tsx:84`). Run history is split across `inbox`, `jobs` and `actions`.
- No one-time scheduling, no automatic retry or backoff, and no per-run history table for `schedules`.
- No test for DST or timezone handling.
- No user-facing webhook trigger, and no replay window on WhatsApp.

---

## 10. Mobile, desktop and browser applications. STATUS: mobile works with push only partial; desktop works (updater off)

### Mobile (`mobile/`)
- Stack: Expo SDK 58, React Native 0.88, React 19.3, Expo Router, TypeScript (`mobile/package.json`). Crypto from `@noble/*`, plus `expo-secure-store`, `expo-notifications` and `expo-speech-recognition`.
- Screens (`mobile/src/app/`):
  - tabs: index (Today), chats, approvals, runs, companion, settings
  - also: `chat/[id]`, `run/[id]`, jobs, knowledge, projects, teammates, `packs/{index,trade,study}`, pair, scan, history
- What it does: it is a remote for the desktop. It pairs by QR code and talks to `/api/mobile/*` with a scoped device token (`workbench/backend/app/mobile.py:1-22`, hmac check at :68). Streaming uses `src/lib/sse.ts`. There is also an encrypted phone link (`teammates/phonelink.py`, ChaCha20-Poly1305).
- Tests: 15 jest files in `mobile/src/lib/__tests__/` (api, sse, pairing, jobs, v02, link, link.e2e, packs, and others). They run in CI (`ci.yml:270-284`), **not in test-all.sh**. Backend: `test_mobile.py`, and `test_v02_core.py` for the share route.

### Push notifications
- Backend: `workbench/backend/app/push.py` sends through Expo's push service and is off until `mobile_push_enabled=1`. Callers: `notify` :63, `approval_needed` :78, `run_finished` :82, `jobs.notice` (`jobs.py:157`). Test: `test_mobile.py:200` `test_push_is_off_until_enabled_and_hooks_fire`, with the sender mocked.
- Phone side: `mobile/src/lib/push.ts` `registerForPush`. Lock-screen Approve and Decline come from `lockActions.ts`.
- **Gap:** `mobile/app.json:109` has `"eas": {}` with **no projectId**, so this build cannot get a push token (`push.ts` returns "This build has no EAS project id yet"). Push is not proven end to end; delivery is mocked in tests.
- Live Activity / Dynamic Island: **documented only, not implemented** (`mobile/COMPANION-LIVE-ACTIVITY.md`, "Not implemented").

### Desktop (`desktop/`)
- Tauri v2 shell, Rust in `src-tauri/src/`:
  - `sidecars.rs` (313 lines): supervisor with a free port, a launch token, a health check, kill on exit
  - `approvals.rs`: native approve/deny prompt
  - `anywhere.rs`: global shortcut, "Ask from anywhere"
  - `native.rs`, `commands.rs`, `updater.rs`
- Plugins (`src-tauri/Cargo.toml:19-26`): notification, deep-link, shell, dialog, opener, single-instance, global-shortcut. The updater is **optional and off by default** (`Cargo.toml:33-35`, needs a signing key).
- Sidecar: `desktop/sidecar/workbench_server.py` runs the backend frozen by PyInstaller, keeps secrets in the keychain, and listens on 127.0.0.1 only.
- `desktop/rooks-native/` is a separate iced (Rust) native window, v0.4.0, with no web view. It has its own CI (`rooks-native.yml`).
- Desktop notifications for jobs: `v02/JobNotifier.tsx` calls `desktop.notify` while the app is in the background, driven by the shell pulse.
- Tests:
  - Rust unit tests only in `native.rs:198-238` (5 tests)
  - `desktop/scripts/test_make_latest_json.py`
  - backend `test_desktop.py` (desktop session, welcome flag, keychain), `test_sidecar_build.py`, `test_sidecar_secrets.py`, `test_launcher*.py`
  - frontend `tests/tauri-native.test.mjs`
  - No test found for `sidecars.rs`, `approvals.rs` or `anywhere.rs`.
- Other clients: `companion/macos` (Swift package with Tests), `vscode-extension/` (has CI tests).
- **Gap:** `companion.py:3` names `companion/desktop`, which does not exist. Only `companion/macos` is present.

---

## 11. Notifications, approvals and live execution. STATUS: works (polling based); partial for Telegram and companion

### Needs you (`workbench/backend/app/needs_you.py`)
- One inbox for everything waiting on the person. Ids:
  - `a:` held tool call
  - `j:` job waiting to start
  - `d:` Rooks Desk step
  - `b:` Rooks Browser step
- Routes: `GET /api/needs-you` (:239) and `POST /api/needs-you/{id}/{answer}` (:245). Access is user or terminal key.
- Each item can be answered once (409 or 404 on a repeat). An unreachable helper gives 502. Helper answers are cached for a few seconds (`HELPER_CACHE_S`).
- Tests: `test_needs_you.py`, 8 tests, all passed.
- Frontend: `needs/NeedsYou.tsx`, `needs/store.ts`. Terminal: `/needs` in `rooks-code/rooks_code/tui.py:718`.

### Presence and pulse (`workbench/backend/app/presence.py`)
- `GET /api/presence` (:287), cached for one second.
- `GET /api/pulse` (:309) returns, in one answer: presence, the Needs you count, job notices after a cursor, and revisions.
- Frontend: `shell/presence.ts` polls adaptively (`PULSE_IDLE_MS` 10 s, quicker while something runs) and shows `shell/PresenceStrip.tsx`.
- Tests: `test_presence.py` (8), `test_pulse.py` (4).

### Event streaming
- Server-Sent Events (SSE):
  - chat via `api.py:30` `sse()`
  - the `/v1` bridge (`bridge.py:80`)
  - companion (`companion.py:430`)
  - mobile `src/lib/sse.ts`, with test `sse.test.ts`
- WebSocket only for the terminal PTY (`terminal_pty.py:123`), with an origin check, and for outgoing Slack/Discord gateways.
- **Jobs and Needs you are polled, not pushed.**

### Telegram (`workbench/backend/app/telegram.py`)
- Long polling, an allowlist of user ids, and delivery of schedules to Telegram.
- Approvals are **not answerable in Telegram**. The reply only says to "Approve or deny it in the workspace … or with: ws approve {id}" (:182-185). No inline buttons.
- Tests: `test_telegram.py`, `test_telegram_loop.py`.

### Companion (`workbench/backend/app/companion.py`)
- Hook-based approvals for external agents (Claude Code, Codex and others), with long-poll wait.
- **Companion requests are not part of Needs you.** `needs_you.py` has no reference to companion. They show on the mobile companion tab and its own SSE, which is a disconnection from "one inbox".
- Tests: `test_companion.py` (7), `test_companion_hooks.py`.

---

## 12. User profiles, accounts and permissions. STATUS: works for single owner; multi-user missing (by design)

### Local auth (`workbench/backend/app/security.py`)
- One owner password or PIN, hashed with scrypt (:35).
- Session token: HMAC-signed, expiring, with a generation counter. Changing the password logs out every session (`make_session` :131, `check_session` :139).
- Cookie: httponly, SameSite=lax (:19).
- `require_user` :152 also accepts `surfaces.bearer_ok`, the browser-extension tokens in tables `browser_pairs` and `browser_tokens` (`surfaces.py:27-32`).
- Scoped keys:
  - terminal or CLI token (`check_cli_token` :167)
  - bridge key (:173)
  - coding-job key (:179)
  - native key (:213)
  - tools key (:234)
  - mobile device tokens (table `devices`, `db.py:357`; `pairing_codes` :368)
- Tests: `test_auth_boundaries.py` (18), `test_route_auth.py` (5, every route must declare auth), `test_desktop.py`.

### Account and plan (`workbench/backend/app/account.py`)
- Optional cloud sign-in that returns an Ed25519-signed entitlement token. Offline grace is 7 days. `PRO_FEATURES` at :37. `GATES` path table, with `install` at :213.
- **`DEFAULT_CLOUD_URL = ""` and `BUILTIN_PUBLIC_KEYS = []` (:32-34)**, so billing is never live and every feature stays unlocked ("free while in beta").
- Tests: `test_account.py` (5) uses a fake cloud.

### Multi-user and roles
- **Missing.** No `users` table and no user id in the session. SECURITY.md:3-4 says it is "for one trusted owner … not a multi tenant boundary".
- `team_members.role` (`team/store.py:25`) is a free-text job title for people the owner delegates to, not a permission role.
- "Teammates" (`teammates/store.py:20`) are AI personas with tool groups (`TOOL_GROUPS`), not people.

### Profile
- `pages/AboutYou.tsx`, assistant name and workspace name settings, appearance.

---

## 13. Frontend architecture, navigation and animations. STATUS: works

### Registry (`workbench/frontend/src/pages/registry.ts`, 199 lines)
- The one list for routes, rail, flyouts, the More sheet and the palette (`PAGES` :59, `REDIRECTS` :124, `railItems` :163, `morePages` :180).
- Current main navigation:
  - Rail: **Chat, Room, Jobs, Day (Mail, Calendar, Tasks), Memory (Memory, Skills, About you, Show me how), Library (Files, Notes, Documents, Sites, Projects)**, with **Settings** at the bottom (`RAIL_ORDER` :134).
  - More sheet, Workspace: Home, Automations, Code, Terminal, Browser*, Computer*, Research, Meetings, Team, Pages, Teammates, Channels, Talk, Vault, Packs.
  - More sheet, Settings: AI models, Customize, Ask anywhere & voice, Appearance, Your plan, About, Privacy.
  - More sheet, Advanced: History, Run log, Insights, Compare models, Fine-tune, Company, System status, Extra tools.
  - Routes with no nav entry: the pack pages `/packs/{legal,study,trade}`.
  - (* shown only when that helper is running.)
- `/` and `/welcome` redirect to `/assistant`.

### Shell and design tokens
- Shell (`src/shell/`): `Rail.tsx`, `PresenceStrip.tsx`, `StageHost.tsx`, `MobileBar.tsx` (below 900px), `MoreSheet.tsx`, `ShortcutsSheet.tsx`. Assembled in `App.tsx:191-215`.
- Tokens: `src/tokens.css` (269 lines), v3 "restraint", with light, dark and high-contrast themes keyed on `html[data-mode]`. AA contrast is checked by `tests/premium-foundation.test.mjs`.

### Motion and reduced motion
- The one animation is `ui-fade` (opacity, 150 ms or less) in `ui/ui.css:8-9`.
- Global `@media (prefers-reduced-motion: reduce)` kills every animation and transition (`ui/ui.css:10-12`). A user "Motion off" setting does the same through `:root[data-motion="off"]` (:13).
- Runtime: `motion/index.tsx:11-15` `motionLevel()` honours the OS setting. Also `appearance.tsx:93,130,151`.
- A few component keyframes remain (in `styles.css`, `voice.css`, `v02.css`). They are covered by the global rule.
- Test: `tests/motion.test.mjs` (3 tests).

### Other frontend tests and gaps
- Shell tests: `tests/workroom-shell.test.mjs` (registry drives everything, 64px rail, mobile bar), `workroom-*.test.mjs`, `keyboard.test.mjs`. 34 node test files in total.
- **Gap:** CI (`ci.yml:72-86`) runs only `tsc` and the build for the frontend. **`npm test` for the frontend is not in CI**; it runs only in `scripts/test-all.sh`.

---

## 14. Data isolation, security and deployment. STATUS: works (single owner); some docs drift

### Secrets
- `config.APP_SECRET` is generated once into DATA_DIR (`config.py:38`). Tests: `test_config_secrets.py`.
- Fernet encryption of stored secrets (`security.py:30,51-66`). OS keychain on desktop (`seal` :69, `migrate_keychain_refs` :86, `keychain.py`). Tests: `test_desktop.py:110,178,244`.

### Outbound audit and redaction
- Every httpx, requests and IMAP/SMTP connection is an `actions` row of kind `egress` (`egress.py:1-15`). Test: `test_egress.py`.
- Redaction: `redact.py`, test `test_redact.py`.

### Hardening
- Taint and approval gating on untrusted content: `test_hardening.py`.
- Skill scan and sandbox: `skill_scan.py`, `skill_sandbox.py`, `seatbelt_skill_profile.sbpl`.
- Docs: `SECURITY.md`, `SECURITY_TOOLING.md`, `docs/security/THREAT-MODEL.md`, `docs/security/agent-credentials.md`. Test: `test_security_docs.py`.

### Deployment
- `docker-compose.yml` services: ollama, searxng, open-webui, workbench, claude-code, codex, browser, paperclip, hermes. Ports bind to `${BIND_ADDRESS:-127.0.0.1}` (:51, :92, :226). Also `docker-compose.gpu.yml` and `docker-compose.prebuilt.yml`.
- Installers:
  - `install.sh`: per user, uv, no Docker. It downloads from `Inclined88888/rooks` (:5).
  - `install.ps1`, `install-server.sh`, `setup.sh`.
  - CI one-command install job (`ci.yml:309-337`).

### Migrations (`db.py`)
- `SCHEMA_VERSION = 4` (:446). `migrate()` :456 takes a backup `workbench.db.pre-v4-*.bak` before an upgrade (:462-465). Steps `migrate_v1..v4` each run in `BEGIN IMMEDIATE` with rollback, and foreign keys are off during the upgrade.
- `ADDED_COLUMNS` and `ensure_columns` add columns in place.
- **Most feature tables are not under SCHEMA_VERSION.** Each module creates its own tables with `CREATE TABLE IF NOT EXISTS` on first use: jobs, automations, sites, packs, adapt, teammates, team, knowledge (kn_*), goals, projects, meetings, finetune, history, compression, checked, surfaces. `db.py` itself holds only 27 core tables (lines 16-414).
- Tests: `test_actions.py -k migration` (with fixture `tests/fixtures/schema_v0.sql`, also run in CI at `ci.yml:34-35`), `test_rooks_migration.py`.

### Backup and export
- `knowledge/backup.py`: daily SQLite snapshots kept for 14 days, restore (snapshots before restoring), and `export_zip()`. Routes `/api/knowledge/export`, `/backups`, `/backups/{name}/restore` (`knowledge/routes.py:134,199-209`).
- `history.py:758,766`: CSV and PDF export.

### Gaps and drift
- `SECURITY.md:10` sends vulnerability reports to `Inclined88888/ai-workspace`, and the supported versions table names `integration/v0.3`. AGENTS.md says the install line is `Inclined88888/rooks` 1.0.0 `main`.
- No per-module schema versioning for the feature tables listed above.
- Data isolation is only the single-owner boundary.

---

## Onboarding, first launch, profession or pack picker

### First-run Welcome: exists and works
- `workbench/frontend/src/pages/Welcome.tsx` (472 lines). Steps, in order:
  1. "Sign in with the accounts you already use" (`AccountsStep` :123, labelled "Step 1 of 4")
  2. "Pick your look" (:414)
  3. "What should I be called?" (`NameStep` :352)
  4. "Choose how to think" (:424). Branches: Free cloud key (`FreeStep` :52), Subscription (:172), Keys (:214), Ollama (:285).
- Gating:
  - `App.tsx:178-187` shows Welcome while `status.welcome_pending`, or on desktop or with no model until `welcome_done`.
  - Backend flags: `api.py:69-71`. A new workspace sets `desktop_welcome_done=0` (`api.py:133`). `POST` done at `api.py:290`.
- Tests: `test_siwc_onboarding.py` ("Choose how to think"), `test_desktop.py:96` (welcome flag), `test_plan_signin.py`. Frontend: `assistant-name.test.mjs`, `premium-pages-b.test.mjs`.
- Terminal first run: `rooks-code/rooks_code/cli.py:590` `first_run_setup`, test `rooks-code/tests/test_pick_project.py:55`. Mobile first run: `mobile/src/app/pair.tsx`.

### Profession or pack picker in onboarding: missing
- No "profession" concept anywhere (grep found none).
- Packs exist but are separate: `workbench/backend/app/packs/registry.py`, with `PACK_IDS = ("trade", "legal", "study")` (:22). Each pack is installed through the skills-hub security gate. Tables `packs_installed`, `pack_settings` and others in `packs/store.py`.
- The pack gallery is `pages/Packs.tsx`, reached from More, then Workspace. Welcome.tsx never mentions packs.
- Tests: `test_packs.py` (19), `tests/packs.test.mjs`, mobile `packs.test.ts`.
