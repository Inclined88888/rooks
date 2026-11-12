# Rooks

Rooks is a local-first AI workspace you run on your own computer. Agents work through the CLI subscriptions and API keys you already use. No paywalls, no caps. Browser, desktop, and terminal surfaces share one product.

This branch is a **Nova-body takeover**: the open-source Nova (AGPL-3.0) kernel, desktop shell, plugin system, and UI are the product body, fully rebranded to Rooks, with Rooks’ stronger surfaces ported in.

## Licence warning (read before merge)

**The combined product would need AGPL-3.0 distribution.** The previous Inclined88888/rooks `main` line was proprietary. Nova’s `LICENSE`, `NOTICE.md`, and `THIRD_PARTY_NOTICES.md` are kept intact. Do not merge or publish a release until the owner decides on AGPL-3.0.

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
| `integrations/work-suites/` | Microsoft 365 + Google Workspace (from Rooks 1.1 / PR #31) |
| `ports/installers/` | Frictionless curl / irm installers from Rooks |

## Requirements

- Node.js 22 or newer, with npm
- Git
- At least one authenticated agent CLI (`claude` or `codex`), or API keys for models used by the ported agents

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

## Comparison report

See the draft PR and `/cursor/stores/.../docs/nova-takeover-report.md` for the area-by-area Nova vs Rooks (incl. PR #31) comparison and open questions.
