# AGENTS.md: working on Rooks (Nova-body takeover)

Rooks is a local-first AI workspace: Electron desktop + Next.js app + Node daemon, plus ported terminal / browser / desk / Room agents from the prior Rooks line.

## Layout

- `orchestrator/` — Cordis kernel, CLI (`rooks`), host adapters, bundled plugins. Brand: `src/brand.ts`.
- `app/` — Next.js web UI; client plugins in `src/plugins-client/`; brand copy in `src/lib/brand.ts`.
- `desktop/` — Electron shell around the local daemon (`com.rooks.desktop`).
- `packages/sdk/` — `@rooks/sdk` plugin contracts (MIT for the SDK/examples per upstream).
- `plugins/`, `examples/` — signed/official and example plugins.
- `rooks-code/`, `rooks-browser/`, `rooks-desk/`, `rooks-try/` — ported Rooks agents (Python); coding CLI is `rooks-code` to avoid colliding with the product CLI `rooks`.
- `integrations/work-suites/` — PR #31 Microsoft 365 / Google Workspace modules (not yet wired into Cordis slots).
- `ports/` — installers, Windows pack scripts, icons from Rooks 1.1.

## Rules

- Product is local-first on each person’s computer; any task / any API key; no paywalls or caps.
- Menus (customize / skills / connectors) once — never duplicated.
- Desktop UI should feel like Linear / Raycast / Things — never website-looking.
- Keep `LICENSE`, `NOTICE.md` (modification notice), `THIRD_PARTY_NOTICES.md`, and copyright lines intact.
- Secrets never go in logs, commits, or chat.
- Do not change `Inclined88888/ai-workspace` / ai-workspace-cloud.

## Checks

- Orchestrator: `cd orchestrator && npm test`
- App: `cd app && npm test` / `npm run typecheck`
- Desktop: `cd desktop && npm test`
- Ported agents: `cd rooks-code && python -m pytest -q` (and siblings) when a venv is available
