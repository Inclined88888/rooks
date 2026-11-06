# plugin-user-connection

Template for **per-user connections** (`apiVersion: 7`): each account registers
its own service URL and key; the plugin reads that account's connection and
calls the service once the destination is approved.

## What it shows

| Piece | API | Permission |
|---|---|---|
| Declare the connection type `user-connection-example:service@1` | `ctx.connections.registerType` | `connections:register` |
| Read the caller's connection and its key | `ctx.connections.forUser` / `userSecret` | `connections:users:read` |
| Call the approved host | `ctx.fetch` | `http:outbound` |
| Own form instead of the generic one, to add and to edit | slot `settings.connection.form` + `useConnectionForm()` (`mode`, `initial`) | — |

## Try it

1. Install and enable the plugin.
2. In **Settings › Secrets › Connections**, add an *Example service* with its URL
   and key. The key goes to the daemon's vault and is never shown again.
3. An administrator approves the address in the same pane (or the operator sets
   `pluginPolicy.http.connectionApproval: "owner"` to let users approve their own).
4. `GET /api/plugins/user-connection-example/status` answers for the signed-in
   account only.
5. **Edit** reopens the same form on the connection: the URL is prefilled, the
   key field stays empty and keeps the stored key unless you type a new one. A
   new address goes back to the administrator for approval.

The daemon refuses link-local and cloud metadata addresses, requires HTTPS
except towards loopback and Tailscale, and accepts loopback, LAN and Tailscale
addresses only when the connection declares *local network*. Every request and
every redirect is checked again against the resolved addresses.
