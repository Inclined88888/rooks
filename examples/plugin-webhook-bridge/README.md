# Signed webhook bridge — an SDK 3 example

This standalone package uses `PluginContext` and `node:crypto`, with no import
from Rooks's core and no npm dependency at runtime. It provides:

- the transport `webhook-bridge:signed-webhook@1`;
- the business event `webhook-bridge:message.received@1`;
- the trigger `trigger.webhook-bridge:signal@1`;
- the executor `plugin.webhook-bridge:uppercase@1` (port `out`).

Messaging and business events are two separate entries: a message received by
the transport creates a mission, while `/events` starts the subscribed
workflows. This text example is not a Slack or Telegram adapter.

## Installation and permissions

From the root of the repository:

```sh
rooks plugin add ./examples/plugin-webhook-bridge
```

The example is not signed with a Rooks distribution key. For a local test,
turn on the developer mode for unsigned plugins in the settings; to distribute
it, use the product's signing mechanism. Do not publish this private package
under the Rooks npm scope.

The manifest targets `apiVersion: 3`. The account that creates the connection
must be active and allowed `plugin:webhook-bridge`, `connections:read` and
`connections:write`. For messages, it also needs `missions:spawn`,
`missions:read` and `secrets:read`. For `/events` and `/signals`, add
`events:publish`. The plugin's registrations are made at load time with its
declared permissions.

In `rooks.config.json`, set the callback destination and the mission budget
(adapt the host name and the budget as needed):

```json
{
  "pluginPolicy": {
    "http": { "allow": ["receiver.example.com"] },
    "spawn": { "approved": ["webhook-bridge"], "max": 5, "windowMs": 3600000 }
  }
}
```

The `spawn.approved` entry only serves the **unsigned** plugin (developer
mode): signed, it declares `missions:spawn` and its signature is the approval;
the `max` / `windowMs` quota applies in both cases.

The manifest declares this host in `http.hosts`: the install sheet offers it as
a checkbox, which opens it to this plugin alone, without editing
`pluginPolicy.http`. A plugin made from this template replaces
`receiver.example.com` there with the host of its own service.

Put two secrets in the vault: `BRIDGE_SIGNING` (at least 24 random characters)
and `BRIDGE_CALLBACK`. Grant each one to `agent:plugin:webhook-bridge`. The
first authenticates incoming messages; the second is the bearer sent to the
callback. No secret goes into a URL, a connection file or a message body.

The administration routes below require the usual authentication of a **Rooks
account**. They use its identity; a daemon token with no account does not pick
an owner in its place.

## Connection and signed message

Call `POST /api/plugins/webhook-bridge/connections` with this JSON:

```json
{
  "agent": "assistant",
  "config": { "room": "support", "replyUrl": "https://receiver.example.com/replies" },
  "secretRefs": { "signing": "BRIDGE_SIGNING", "callback": "BRIDGE_CALLBACK" }
}
```

The `201` response holds `connection` and `inboundPath`. Resolve that path
against the URL **of the daemon**, for example
`https://daemon.example.com/api/integrations/<UUID>/inbound`. This entry needs
no Rooks session: the transport checks the signature and the room.

The body is `{ "id": "provider-event-1", "room": "support", "text": "Hello" }`.
The id stays the same across attempts. Sign the **exact bytes** with
HMAC-SHA256, prefixed with the Unix timestamp in seconds and a dot:

```js
import { createHmac } from 'node:crypto';
const body = Buffer.from(JSON.stringify({ id: 'provider-event-1', room: 'support', text: 'Hello' }));
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = createHmac('sha256', signingSecret).update(`${timestamp}.`).update(body).digest('hex');
await fetch(inboundUrl, {
  method: 'POST', body,
  headers: { 'content-type': 'application/json', 'x-rooks-timestamp': timestamp, 'x-rooks-signature': signature }
});
```

`signingSecret` and `inboundUrl` are the values the provider holds. The allowed
window is five minutes. For a late retry, compute the signature again with a
recent timestamp and keep the same `id`. A `202` means the receipt is
persisted; it does not mean the mission is over. A `429` or `503` asks for a
retry with backoff.

## Replies and recovery

The callback is only the one recorded in the connection. A `replyUrl`,
`reply_url` or `identity` field received in a message changes neither its
destination nor its owner. HTTPS is mandatory and redirects are refused. For a
local test only, the operator setting `plugins.webhook-bridge.allowLocalHttp: true`
allows HTTP on `127.0.0.1`, `localhost` and `::1`; the domain must still be in
the HTTP policy.

Each outgoing POST carries `Authorization: Bearer <BRIDGE_CALLBACK>` and
`Idempotency-Key: integration:<receipt_id>:<fragment>`. Its JSON holds `room`,
`text`, `fragment` (zero-based index) and `total`. Fragments are at most 2,000
Unicode code points; an emoji is never cut in two. The callback must
**deduplicate this key atomically before its business effect** and answer with
a 2xx status, including for a fragment it already handled.

The daemon persists the next fragment after the HTTP success. If it goes down
after the callback accepted a fragment but before its checkpoint, the same
fragment is sent again with the same key. Without deduplication on the callback
side, a duplicate remains possible. Requests have a ten-second network timeout
and use the SDK's abort signal.

`PATCH /api/plugins/webhook-bridge/connections/<id>` with `{ "enabled": false }`
suspends a connection. Turning the plugin off removes its routes and
registrations, but keeps its receipts for when it is turned on again. A
configuration change does not redirect messages already accepted. Recovery
after a crash may wait for the claim to expire (six minutes).

## Workflows

Create a workflow with a `trigger.business` node configured with
`{ "event": "webhook-bridge:message.received@1" }`, followed by
`plugin.webhook-bridge:uppercase@1` (configuration `{}`), then an `output` node
using `{{nodes.upper.output.text}}` if the executor has the id `upper`. Link the
`out` ports to the `in` inputs.

Then publish through `POST /api/plugins/webhook-bridge/events`:

```json
{ "id": "business-1", "text": "hello" }
```

The `202` response holds the ids of the runs created. The expected output is
`HELLO`. Replaying this id creates no extra run for the same subscribers.

For the registered trigger, replace the entry with
`trigger.webhook-bridge:signal@1`, configured with `{ "topic": "support" }`.
Call `POST /api/plugins/webhook-bridge/signals` with
`{ "id": "signal-1", "topic": "support", "text": "hello" }`. Only the triggers
of the calling account and of the matching topic receive the signal. The
runtime arms the persisted triggers again after the plugin reloads.

## Checking it in the repository

```sh
node orchestrator/node_modules/typescript/bin/tsc -p examples/plugin-webhook-bridge/tsconfig.json
cd orchestrator
npm test -- src/plugins/integration-example.test.ts
```

The test installs the package with npm in offline mode and loads it with a
temporary Ed25519 signature. It uses a real HTTP callback server, SQLite,
Cordis, the daemon's authentication and the workflow engine. Only mission
creation is replaced by a local backend with no AI; no provider account is
contacted. The general guarantees, and the retention and export limits, are in
[Business events, workflow nodes and messaging](../../public-docs/docs/plugins/integrations.md).
