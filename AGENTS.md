# AGENTS.md: working on Rooks

Rooks is a local-first AI workspace: Electron desktop + Next.js app + Node daemon, plus terminal / browser / desk / Room agents.

## Layout

- `orchestrator/` — Cordis kernel, CLI (`rooks`), host adapters, bundled plugins. Brand: `src/brand.ts`.
- `app/` — Next.js web UI; client plugins in `src/plugins-client/`; brand copy in `src/lib/brand.ts`.
- `desktop/` — Electron shell around the local daemon (`com.rooks.desktop`).
- `packages/sdk/` — `@rooks/sdk` plugin contracts (MIT for the SDK/examples).
- `plugins/`, `examples/` — signed/official and example plugins.
- `rooks-code/`, `rooks-browser/`, `rooks-desk/`, `rooks-try/` — agents (Python); coding CLI is `rooks-code` to avoid colliding with the product CLI `rooks`.
- `integrations/work-suites/` — Microsoft 365 / Google Workspace modules.
- `ports/` — installers, Windows pack scripts, icons.

## Rules

- Product is local-first on each person’s computer; any task / any API key; no paywalls or caps.
- First-run account, models, channels, and mail are optional — never block getting to the desk.
- Menus (customize / skills / connectors) once — never duplicated.
- Desktop UI should feel like Linear / Raycast / Things — never website-looking.
- Keep the proprietary `LICENSE`, one-line `NOTICE.md`, and Rooks-worded `THIRD_PARTY_NOTICES.md`.
- Secrets never go in logs, commits, or chat.

## Checks

- Orchestrator: `cd orchestrator && npm test`
- App: `cd app && npm test` / `npm run typecheck`
- Desktop: `cd desktop && npm test`
- Agents: `cd rooks-code && python -m pytest -q` (and siblings) when a venv is available
