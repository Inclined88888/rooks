---
title: Timon tools for a remote agent
sidebar_position: 13.5
---

An agent running on another machine — behind a gateway your provider plugin drives, for example — does not get Timon's local MCP server, so it cannot see the Kanban, message other agents or write memory rules. Timon serves the same tools over **MCP Streamable HTTP**, and your plugin hands the remote agent a **restricted token** for it. Requires `apiVersion: 7` and the `mcp:issue` permission.

```json
"timon": { "id": "acme-gateway", "apiVersion": 7, "permissions": ["mcp:issue"] }
```

```js
const { id, token, path, expiresAt } = await ctx.mcp.issueToken({
  missionId,                                   // a running mission
  scopes: ['kanban_*', 'agent_send_message', 'memory_rule_add'],
  ttl: 30 * 60_000,                            // milliseconds, 1 minute to 24 hours, default 1 hour
});
// Give the remote agent: the address where it reaches Timon + `path`,
// and the header `Authorization: Bearer <token>`.
await ctx.mcp.revokeToken(id);                 // optional: the token dies with the mission anyway
```

## What the token allows

- **The tools you list, nothing else.** `scopes` names tools (`kanban_add`) or families (`kanban_*`). A bare `*` is refused, and so is a scope that matches no tool. `tools/list` only shows what is in scope; calling another tool returns a JSON-RPC error without running anything.
- **Acting as the mission.** A tool runs with the mission's identity and the same rights a local agent of that mission has. Messages, tasks and memory rules are attributed to that mission's agent.
- **One mission, for a short time.** The token is bound to one running mission and its agent. It expires after `ttl`, and is deleted when the mission ends. Your plugin can revoke the tokens it issued, and only those. It is checked again before every tool call, batches included: once it has expired, been revoked or lost its mission, the next call returns the JSON-RPC error `-32001` without running.

## Which missions

A mission your caller can see (in a request, the user's own missions; in a background job, the missions your plugin started), or a mission running on a backend your plugin registered with `ctx.backends`. Any other mission is answered as if it did not exist.

## What the token does not allow

- It is **not** an API key: every other Timon endpoint answers `401` to it.
- It cannot read files on the machine where Timon runs: give `agent_set_avatar` a `data_url`, give the browser tools a `slug`.
- Treat it as a secret: send it in the `Authorization` header only, never in a URL, never in a log.

## Reaching Timon from another machine

The endpoint listens where Timon's daemon listens, which is the local machine only by default. Do **not** open Timon to every network interface for this. Instead, use one of:

- **Tailscale** (recommended): `tailscale serve` pointing at the daemon port.
- **An SSH tunnel** from the remote machine: `ssh -L 8765:127.0.0.1:<daemon port> you@timon-host`, then `http://127.0.0.1:8765` + `path`.
- **A reverse proxy with TLS** in front of the daemon, forwarding the `Authorization` header.

The web app's own address does not serve this endpoint: point the remote agent at the daemon.

## Protocol notes

- `POST` only, `application/json` in and out, no session id; `GET` and `DELETE` answer `405`.
- Protocol versions `2025-06-18` and `2025-03-26`.
- A request carrying an `Origin` header from another site is refused.
