---
title: Per-user connections
sidebar_position: 14.6
---

A plugin that talks to a service **each user runs or owns** — their own gateway, instance or account — declares a **connection type**. Every user then adds their own connection in **Settings → Secrets → Connections**: an address, the fields your type asks for, and keys that go to the vault. Nothing is written in `rooks.config.json`.

Requires `apiVersion: 7`.

## Declare a type

```json
"rooks": {
  "id": "acme-gateway",
  "apiVersion": 7,
  "permissions": ["connections:register", "connections:users:read", "http:outbound"]
}
```

```js
export function apply(ctx) {
  ctx.connections.registerType({
    name: 'gateway', version: 1,
    label: 'Acme gateway',
    configSchema: z.object({ workspace: z.string().optional() }).strict(),
    fields: [{ key: 'workspace', label: 'Workspace' }],
    secrets: [{ name: 'apiKey', label: 'API key', required: true }],
    // Optional: what the "Test" button does. `fetch` stays on this connection's address.
    async test({ connection, secret, fetch }) {
      const response = await fetch(new URL('health', connection.url), {
        headers: { authorization: `Bearer ${await secret('apiKey')}` },
      });
      return { ok: response.ok };
    },
  });
}
```

The type id is qualified: `acme-gateway:gateway@1`. It disappears when the plugin unloads; the connections users created stay.

## Use the connection of one account

```js
const [connection] = await ctx.connections.forUser(ownerUserId);
const key = await ctx.connections.userSecret(ownerUserId, connection.id, 'apiKey');
const response = await ctx.fetch(new URL('v1/runs', connection.url), {
  headers: { authorization: `Bearer ${key}` },
});
```

- `forUser` returns the connections of that account for your plugin, with the **names** of their secrets, never the values. Inside a request, it only accepts the signed-in caller.
- `userSecret` returns a key only for a connection that is **approved** and **enabled**.
- `ctx.fetch` reaches the address of an approved connection even when it is not in the operator's `pluginPolicy.http.allow`.

## Approval and network rules

A new connection waits for an administrator, who approves it in the same Settings pane. An operator can let users approve their own with `pluginPolicy.http.connectionApproval: "owner"`. Changing a connection's address, or its *local network* flag, asks again.

Rooks checks the address before each request and each redirect:

- link-local and cloud metadata addresses, multicast and `0.0.0.0` are never reachable;
- loopback, private network and Tailscale addresses only when the user ticked *This service is on my machine or local network*;
- HTTPS is required, except towards loopback and Tailscale addresses.

A refused address rejects with an error that names the rule, never a key. A connection address has no query string or fragment: keys go in the secrets. Only a signed-in person adds, changes, approves or removes a connection; an agent's token cannot.

## When your plugin is removed

`rooks plugin remove` keeps the connections but sends them back to approval and deletes their keys. After a reinstall, `forUser` returns them with `approval: "pending"` and no secret names, `ctx.fetch` refuses their addresses, and `userSecret` returns `undefined` until an administrator approves them again and each owner re-enters the key. Handle a connection with no key: say so to the user rather than sending an empty credential. A plugin updated in place keeps its connections. The same happens without that command when a different package takes your plugin's id, before the new package runs: a different npm name, or an unsigned copy of a signed package. The signed release of a package installed unsigned keeps its connections, like any update.

## Your own form

Without anything else, Settings builds a form from `fields` and `secrets`. To replace it, your browser half registers in the keyed slot `settings.connection.form`, under the type id, and reads `useConnectionForm()` from `@rooks/ui`:

```js
import { useConnectionForm } from '@rooks/ui'

function GatewayForm() {
  const form = useConnectionForm() // { type, mode, initial, approvalRequired, submit(input), cancel() }
  const initial = form?.mode === 'edit' ? form.initial : null
  // … your fields, prefilled from `initial` when editing, then:
  // await form.submit({ label, url, secrets: apiKey ? { apiKey } : {} })
}

export function apply(ctx) {
  return ctx.slots.register({ slot: 'settings.connection.form', key: `${ctx.id}:gateway@1` }, GatewayForm)
}
```

Declare `settings.connection.form` in `client.slots`. Only the plugin that declared the type is shown there.

The same form adds and edits a connection:

- `mode` is `create` or `edit`. A form that ignores it keeps working as a create form, and an older Rooks does not set it: read a missing `mode` as `create`.
- `initial` is the connection being edited, `null` when creating. It carries the names of its secrets (`initial.secrets`), never their values: leave the secret fields empty and tell the user that empty keeps the current key.
- On an edit, `submit` sends only what differs from `initial`; a secret left empty or absent keeps the stored one.
- `approvalRequired` says whether saving waits for an administrator. When it is true, warn before saving that a new address or a change of *local network* asks for approval again.
