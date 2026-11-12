# Rooks

Rooks is a local-first AI workspace you run on your own computer. Agents work through the CLI subscriptions and API keys you already use. No paywalls, no caps. Browser, desktop, and terminal surfaces share one product.

## Licence

Proprietary — Inclined88888 / Rooks, all rights reserved. See `LICENSE`, `NOTICE.md`, and `THIRD_PARTY_NOTICES.md`.

## What you get

| Piece | Role |
| --- | --- |
| `orchestrator/` | Daemon, CLI (`rooks`), agent missions, Cordis plugins |
| `app/` | Web UI (Next.js) — desktop-class chrome, not a website feel |
| `desktop/` | Electron shell (tray, service, packaging for Mac/Windows/Linux) |
| `packages/sdk/` | Plugin and provider contracts (`@rooks/sdk`) |
| `plugins/`, `examples/` | Built-in and example plugins |
| `rooks-code/` | Terminal coding agent (any model) — CLI entry `rooks-code` |
| `rooks-browser/` | Browser agent on your Chrome or Edge |
| `rooks-desk/` | Computer-use agent |
| `rooks-try/` | The Room — the assistant’s own computer on this machine |
| `integrations/work-suites/` | Microsoft 365 + Google Workspace |
| `ports/installers/` | Frictionless curl / irm installers |

## Requirements

- Node.js 22 or newer, with npm
- Git
- At least one authenticated agent CLI (`claude` or `codex`), or API keys for models used by the agents

## Run from source

```bash
cd orchestrator
npm ci
npm run build
npm run install:cli      # puts `rooks` on your PATH
cd ../app
npm ci
npm run build
```

Point `daemon.installDir` at this checkout’s `orchestrator/` directory, then:

```bash
rooks service install --dry-run
rooks service install
rooks doctor
```

Config and data live under `~/.rooks/`. See `GETTING-STARTED.md` and `HOST_MODE.md`.
