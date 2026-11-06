# TIMON App

Single Next.js service that fronts the orchestrator. Hosts three concerns
that used to live in two separate Next.js apps:

1. **UI** — the static maquettes from `public/` served at `timon.localhost`,
   with a same-origin `/api/ui/*` proxy so the static pages can talk to the
   orchestrator without crossing origins.
2. **Channels** — inbound endpoint `POST /api/channels/[name]/inbound`
   exposed at `channels.timon.localhost`. Authenticates webhook calls via
   HMAC-SHA256 and Telegram worker messages via a timestamped signature plus
   chat-id allowlist, then stores receipts before acknowledging them.
3. **Remote control** — bearer-auth REST at `/api/remote/*` with short-lived
   HS256 tokens, audit trail, rate limit, and an OpenAPI spec at
   `/api/remote/openapi.json` ready to paste into Claude.ai mobile.

Two background workers run in their own containers using this same image:

- `worker:telegram` — long-polls every configured Telegram bot and forwards
  each message to `POST /api/channels/<name>/inbound`.
- `worker:reply` — processes durable receipts, creates missions and polls their
  completed turns to send replies with persistent retries.

See [communication operations](../docs/COMMUNICATION.md) for channel configuration,
service identities, deduplication, shared storage and rollback.

## Layout

```
src/
  app/
    api/
      channels/[name]/inbound/    # inbound (Telegram envelope, signed webhook)
      health/                      # healthcheck
      remote/                      # bearer-auth REST + OpenAPI + sessions
      ui/                          # same-origin proxy used by the maquettes
    agents.js/                    # dynamic data layer for the static UI
    remote/sessions/              # operator view of issued tokens
    page.tsx                      # redirects /  →  /dashboard
  lib/
    paths.ts                      # shared paths (TIMON_HOME etc.)
    orchestrator.ts               # REST client for the orchestrator
    channels/                     # channels-specific logic + transports
    remote/                       # token signing, audit, rate limit, auth
    ui/                           # proxy helpers
  workers/
    telegram-poll.ts
    mission-watcher.ts
public/                            # the 8 maquette HTML files + _demo-data.js
```

## Endpoints (summary)

```
POST /api/channels/[name]/inbound      # webhook / Telegram envelope
GET  /api/health                       # list configured channels

POST /api/remote/issue-token           # master-bearer; mints a token
POST /api/remote/missions              # bearer; spawn a mission
GET  /api/remote/missions/:id          # bearer; status
GET  /api/remote/missions/:id/output   # bearer; markdown or JSON
DELETE /api/remote/missions/:id        # bearer; kill running mission
GET  /api/remote/openapi.json          # public OpenAPI spec
POST /api/remote/sessions/:id/revoke   # master-bearer

GET  /api/ui/agents                    # proxy (no auth, local-only)
POST /api/ui/agents
GET  /api/ui/agents/:name
DELETE /api/ui/agents/:name
GET  /api/ui/missions
POST /api/ui/missions
GET  /api/ui/missions/:id
DELETE /api/ui/missions/:id
POST /api/ui/missions/:id/send
GET  /api/ui/missions/:id/stream       # SSE passthrough

GET  /agents.js                        # demo stubs + live overlay
GET  /                                  # → /dashboard
```

## Run locally

```bash
npm install
TIMON_REMOTE_MASTER="$(openssl rand -hex 32)" npm run dev
```

In production this app is served either by the daemon itself, as a supervised
child process (`app.enabled: true`), or by the `app` container of
`../docker-compose.yml` — one or the other, never both, they bind the same
port. The daemon always runs on the host, never in a container. See
`../GETTING-STARTED.md` §3.
