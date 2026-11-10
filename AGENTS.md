# AGENTS.md: working on AI Workspace

AI Workspace is a personal AI assistant you run yourself: a web app (workbench) also shipped as a desktop app window,
plus three command line agents: `rooks` (terminal coding agent), `rooks-browser` (browser agent), `rooks-desk`
(computer use). All three can use the app's models, keys and plans through its OpenAI-shaped `/v1` bridge.

## Layout

- `workbench/backend/app/` FastAPI app (Python 3.12). `main.py` wires routers. Models: `llm.py`, `adapters.py`
  (one class per protocol, `CliPlan` runs the user's own `claude`/`codex`/`copilot` CLI), `router.py` (Auto).
  `/v1` bridge: `bridge.py`; terminal link (memory, skills, search): `rooks_link.py`. Mail: `mail.py` (IMAP/SMTP),
  `cloud_mail.py` (Gmail and Microsoft Graph), `connect.py` (Google/Microsoft OAuth sign-in), `mail_autodetect.py`.
  Database and migrations: `db.py` (SQLite, schema version in `SCHEMA_VERSION`). The Workroom: `presence.py`,
  `needs_you.py`, `room.py`, `restart.py` (a restart reported honestly: the cut off turn gets a note, the next turn says
  `resumed`, goals that opted in continue). A prompt that does not fit is compacted and retried in `assistant._run_turn`
  (`compacted` event), never fatal at once.
- `workbench/backend/tests/` pytest suite (about 940 tests, about 5 minutes).
- `workbench/frontend/src/` React + Vite + TypeScript. The Workroom shell: `pages/registry.ts` (the one page list:
  routes, rail, flyouts, More sheet, palette), `shell/` (rail, presence strip, stage host, phone bar), `ui/`
  (primitives), `chat/` (thread, events, turns), `room/` (the Room page and stage), `stage/` (surfaces), `needs/` (the
  Needs you sheet); tokens in `tokens.css`. Pages in `pages/`, shared helpers in `util.tsx`, API client in `api.ts`,
  styles in `styles.css` and `connect.css`.
- `rooks-code/rooks_code/` the `rooks` terminal: `agent.py` (loop), `tools.py` (file and command tools), `extras.py`
  (todo, web, background jobs, sub-agents, project instructions), `learning.py` (memory and skills shared with the
  app), `tui.py` (interactive terminal), `cli.py` (commands, plain mode), `config.py`, `providers.py`.
- `rooks-browser/`, `rooks-desk/` the browser and computer agents. `rooks-try/` the Room: the assistant's own computer on
  this machine (a private desktop on Linux, a Linux guest with QEMU, else a private folder and shell); the app side is
  `workbench/backend/app/room.py` (`/api/room`, the `use_room` tool). Honesty rule: a screen is shown only when a real
  display exists, status says `screen`, `pointer`, `isolation` and a plain label, the drawn terminal is never picked on
  its own, and a file leaves the Room only after a yes in Needs you. `desktop/` launcher and native shell.
- `install.sh` installs everything; `scripts/test-all.sh` runs every suite that runs on one computer (see Commands).

## Commands

- Everything: `./scripts/test-all.sh` (needs uv, node and npm; docker for the compose check). Must end with "All
  passed." before pushing. It runs the backend, `cli/ws`, Rooks Code, the Try Room, Rooks Browser (and its Electron
  preview when npm and xvfb-run are there), Rooks Desk, the CLI launcher, the frontend, the VS Code add-on, the phone
  app, the scorecard selftest and the compose files (`--quick` skips the frontend, the add-on and the phone app). Only
  the online checks run the security scan, the one-command install on Linux, macOS and Windows, the Docker images, the
  desktop and native window builds, and the real-screen runs, so watch them after pushing.
- Backend only: `cd workbench/backend && env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u NVIDIA_API_KEY ~/.venvs/aiw/bin/python -m pytest -q -p no:cacheprovider -W ignore`
  (provider keys unset, or tests call real providers).
- Rooks only: `cd rooks-code && ~/.venvs/rooks/bin/python -m pytest -q -p no:cacheprovider`
- Try Room only: `cd rooks-try && ~/.venvs/aiw/bin/python -m pytest -q -p no:cacheprovider tests`
- Frontend: `cd workbench/frontend && npx tsc --noEmit -p . && npm run build && npm test`
- VS Code add-on: `cd vscode-extension && npm ci && npm test`; phone app: `cd mobile && npm ci && npm run typecheck && npm run lint && npm test`

## Rules

- The install repo is `Inclined88888/rooks`, version 1.0.6, branch `main`. The old `ai-workspace` repo is not the install line. Do not merge that old `main` unless the owner says so.
- Every user-facing string is plain words for non-technical people: no URLs, ids, "cli://", "OAuth", "MCP", "UTC",
  "Workbench" or stack traces on normal screens. Technical detail only under "Advanced".
- The terminal, the browser and the app must match: same features, names and behaviour. A feature added in one is
  added (or reachable) in the others.
- Never fake results. A test that guards a fix must fail on the old code first.
- Secrets never go in logs, commits or chat. Keys live in the app; the terminal gets them from `app.json`.
- Mail connects through the provider's own sign-in (Google, Microsoft) or app passwords; never scripts another app.
