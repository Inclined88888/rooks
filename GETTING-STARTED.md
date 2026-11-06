# Running Timon from this repository

For **installing Timon**, use the packaged desktop build and follow
<https://docs.timon-ai.com/installation/overview> — per-OS instructions, the
configuration reference and the first-run walkthrough live there, and they are
kept up to date with the product.

This file covers the other case: you have a checkout of this repository and you
want to run it. Nothing here duplicates the public documentation; it says what
is specific to working from source.

---

## 1. What you need

- Node.js 22+ with npm
- Git
- One authenticated agent CLI — `claude` or `codex` — signed in under the OS
  account that will run the daemon
- A supervisor for the daemon: systemd user services (Linux), launchd (macOS),
  a scheduled task (Windows)

Timon drives your CLI subscriptions. It never calls a token-billed API for
ordinary agent work.

---

## 2. Build and install

From the root of the checkout:

```bash
cd orchestrator
npm ci
npm run build
npm run install:cli      # puts `timon` in ~/.local/bin — follow its PATH hint
cd ../app
npm ci
npm run build
cd ..
```

Point `daemon.installDir` at the **absolute path of this checkout's
`orchestrator/` directory** (see the
[configuration reference](https://docs.timon-ai.com/installation/configuration)),
then install the service:

```bash
timon service install --dry-run   # read it before applying it
timon service install
timon service status
timon doctor                      # what the daemon can and cannot reach
```

---

## 3. Serving the web app

Two ways, never both at once — they listen on the same port.

**Daemon-managed (no Docker).** Set `app.enabled: true` in
`~/.timon/timon.config.json`; the daemon runs the built Next app as a child
process and supervises it.

**Docker.** Leave `app.enabled` at `false` and start the container explicitly —
the `docker` profile means a bare `docker compose up -d` will not:

```bash
docker compose --profile docker up -d app
```

The container publishes `127.0.0.1:3100` and is also routed by Traefik on
`timon.localhost` when you already run a Traefik stack.

> Do not use the `dev` profile. It recompiles each page on demand, which makes
> the UI unusable, and it carries the same Traefik labels as `app`.

---

## 4. Reaching Timon from your phone, over Tailscale

Run both commands **on the machine hosting Timon**:

```bash
tailscale up
tailscale serve --bg --https=443 http://127.0.0.1:3100
# → https://<machine>.tail<XXXX>.ts.net
```

Nothing is exposed publicly: `tailscale serve` only answers inside your tailnet,
and the app itself listens on the loopback. Substitute your own port if you
changed `app.listen.port`.

The onboarding panel in the app prints these same two commands — the screen and
this file must never disagree.

---

## 5. Where your data lives

Everything is under `~/.timon` (the home is read from the service definition,
never assumed — `systemctl --user cat timon-orchestrator` settles it):

```
~/.timon/
   timon.config.json       — configuration, see the public reference
   timon.db                — missions, events, users, sessions, Kanban
   integrations.db         — third-party integrations
   agents/<name>/          — config.json, system-prompt.md, memory/
   projects/<slug>/        — roles pinned for that project
   plugins/                — installed third-party plugins
   skills/<id>/SKILL.md    — reusable instruction files
   worktrees/              — git worktrees of dispatched tasks
   uploads/                — attachments received and sent
   browser-profiles/       — one isolated browser identity per profile
   daemon-token            — bearer for CLI, MCP and agents (0600)
   secret-key              — master key; never regenerated once it exists
   secrets.env             — secrets read at daemon startup
   license.key / .jwt      — activation key and the token it earned
```

Not exhaustive: per-backend sandboxes (`codex-runs/`), the runtime directory
(`run/`) and other working folders appear as the features that own them are
used.

To start over, stop the service and remove that directory — this deletes every
agent, mission, user and token. There is no undo.

---

## 6. Next

- The plugin contract: [docs/PLUGINS.md](docs/PLUGINS.md), with one template per
  kind in [`examples/`](examples/)
- Running Timon without Docker at all: [HOST_MODE.md](HOST_MODE.md)
- Working on Timon itself: [AGENTS.md](AGENTS.md)
