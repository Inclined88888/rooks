---
title: Business events, workflow nodes and messaging
sidebar_position: 14.55
---

Your plugin can feed Rooks's workflows with events from another system, add nodes to the workflow editor, and connect a messaging service so that an outside message starts a mission and the agent's answer goes back. Requires `apiVersion: 3`. The complete template is `examples/plugin-webhook-bridge` ([cookbook](examples.md#webhook-bridge)).

| Call | Permission |
| --- | --- |
| `ctx.businessEvents.register(definition)` | `events:register` |
| `ctx.businessEvents.publish(type, input, options?)` | `events:publish` |
| `ctx.workflows.registerTrigger(definition)` | `workflows:triggers:register` |
| `ctx.workflows.registerExecutor(definition)` | `workflows:executors:register` |
| `ctx.transports.register(definition)` | `transports:register` (sensitive) |
| `ctx.connections.create(input)`, `update(id, patch)` | `connections:write` |
| `ctx.connections.get(id)`, `list()`, `inboundPath(id)`, `receipts(id, options?)` | `connections:read` |

Each `register` takes a local `name` and a `version` and returns a function that removes the registration; unloading your plugin removes them all and cancels the calls in progress. Elsewhere (a workflow, a publication, a connection) a registration is named in full: `<plugin id>:<name>@<version>`, for example `acme-tickets:issue.created@1`. Two versions of the same name can coexist. A name contains no `:`, `@` or path.

Schemas (`payloadSchema`, `configSchema`) are objects with a `parse(value)` method that returns the value or throws: a Zod schema fits, so does a small function of your own. Values are JSON, bounded (256 KiB, 32 levels deep). A callback has 30 seconds by default (`timeoutMs`, from 1 ms to 5 minutes); Rooks may shorten it, never lengthen it. Cancellation is cooperative: honour `signal`.

## Business events

A business event is something that happened in your system and that a workflow can start from.

```js
const issueSchema = { parse: (v) => { if (typeof v?.title !== 'string') throw new Error('title'); return { title: v.title, priority: Number(v.priority ?? 0) } } }

ctx.businessEvents.register({ name: 'issue.created', version: 1, payloadSchema: issueSchema })

// Later, in a request or a webhook handler:
const runs = await ctx.businessEvents.publish(`${ctx.id}:issue.created@1`, { id: 'ISSUE-42', payload: { title: 'Login fails', priority: 3 } })
```

- Only the enabled workflows **of the same account** receive the event: in a request, the signed-in user; in a background job, your plugin. The account is never read from the payload: an `identity` or `ownerUserId` field in it grants nothing.
- `id` is the event's stable id in your system. Publish again with the same `id` after an error: the workflows already started are not started twice, and `publish` returns the runs it created (an empty list on a deduplicated retry).
- Rooks keeps no queue of events to deliver: if `publish` fails, retry it yourself.

## Workflow nodes

A **trigger** node watches a source and emits events while its workflow is published and enabled. A trigger does not run once: `start` arms it and returns the function that disarms it.

```js
ctx.workflows.registerTrigger({
  name: 'signal', version: 1, configSchema: topicSchema,
  start(context) {
    // context.config, context.workflowId, context.nodeId, context.signal
    const stop = watch(context.config.topic, (item) => context.emit({ id: item.id, payload: item }))
    return stop
  },
})
```

Republishing, disabling or deleting the workflow, or unloading your plugin, disarms the trigger and makes the old `emit` refuse. `timeoutMs` bounds `start`, not the life of the armed trigger.

An **executor** node does one step of a run:

```js
ctx.workflows.registerExecutor({
  name: 'uppercase', version: 1, configSchema: emptySchema, outputPorts: ['out'],
  execute: ({ input, idempotencyKey }) => ({ output: { text: String(input.text).toUpperCase() }, port: 'out' }),
})
```

It returns its output and one of its declared ports; the run continues from that port. `idempotencyKey` stays the same across the retries of this node in this run: pass it to the service you call. `config.retries` (0 to 10) is read by Rooks itself; accept the field in your schema if you use it. A failure follows the `failed` port when the workflow draws one.

Callbacks run as the workflow's owner, who must be an active account allowed to use your plugin, and read only that account's data, for an administrator too.

## Messaging transports

A transport connects a messaging service: an incoming message starts a mission of the connection's agent, and the agent's first answer is sent back.

```js
ctx.transports.register({
  name: 'chat', version: 1, configSchema: roomSchema,
  async receive(context, request) {
    // Authenticate request.body (exact bytes) and request.headers BEFORE decoding.
    const signing = await context.secret('signing')
    if (!verify(request, signing)) throw new Error('Invalid signature')
    const message = JSON.parse(new TextDecoder().decode(request.body))
    if (message.type === 'ping') return null                       // authenticated, ignored
    return { externalId: message.id, text: message.text, replyContext: { room: message.room } }
  },
  async send(context, reply) {
    // reply.text, reply.replyContext, reply.idempotencyKey, reply.checkpoint
    await post(reply.replyContext.room, reply.text, { idempotencyKey: reply.idempotencyKey })
    return { done: true, checkpoint: null }
  },
})
```

A **connection** binds a transport to an agent for one account:

```js
const connection = await ctx.connections.create({
  transport: `${ctx.id}:chat@1`, agent: 'acme.support',
  config: { room: 'support' }, secretRefs: { signing: 'ACME_CHAT_SIGNING' },
})
const path = await ctx.connections.inboundPath(connection.id)   // give the service this address
```

- **The account** is the one making the request (or your plugin, in a job); it cannot be chosen in the input. Id, plugin, account and transport never change afterwards; `update` takes `agent`, `config`, `secretRefs` and `enabled`.
- **Secrets** are vault names in `secretRefs`, never values in `config`. `context.secret(name)` resolves only a name the connection declares, granted to your plugin, with `secrets:read`.
- **The incoming address** is public: knowing it is not authentication. `receive` must check the signature, its freshness and the allowed senders. Throwing answers `401` without your error's text; `null` acknowledges an event you ignore. `inboundPath` is a path of the daemon: resolve it against the address your service can reach, not against your plugin's routes.
- **Reception is durable**: a valid message is stored before the service gets its `202`, and the same `externalId` never starts two missions, even after a restart. Bodies are limited to 256 KiB and texts to 64 000 characters; a connection accepts 30 new messages a minute.
- **Sending is at least once.** `send` does one bounded step and returns `{ done, checkpoint }`; Rooks stores the checkpoint before calling it again, so a long answer can go in fragments. If the daemon stops after your service accepted a fragment but before the checkpoint, that fragment is sent again: pass `idempotencyKey` to the service, or deduplicate.
- **What it needs**: starting the mission needs `missions:spawn` and the operator's approval in `pluginPolicy.spawn`; reading the answer needs `missions:read` ([Permissions](permissions.md)).
- Text messages and the first answer of each mission only: no attachments.

### Following a connection's messages

`ctx.connections.receipts(id, options?)` (`apiVersion: 14`) tells your plugin what is still on its way for one of its connections, so it can show a "3 messages failed" badge of its own:

```js
const { counts, receipts } = await ctx.connections.receipts(connection.id, { status: 'failed', limit: 20 })
// counts: { queued, retrying, failed }
// receipts: [{ id, externalId, stage, status, attempts, lastError, missionId, preview, createdAt, nextAt, failedAt }]
```

- **Read-only.** Replaying or discarding a message stays in **Settings → Secrets → Connections**, done by a signed-in person: a replay starts a mission under the account's identity, which plugin code may not decide.
- **Only your connection, of the current account**: in a request, the signed-in user's; in a background job, your plugin's own. Another account's connection, even for an administrator, answers `Connection not found`, like one that does not exist. Per-user connections ([Per-user connections](connections.md)) have no messages and are not concerned.
- **Bounded.** `receipts` lists only messages retrying or failed, failed first, newest first. `status` is `'failed'` or `'retrying'`; `limit` goes from 1 to 200, 50 by default. Any other option is refused. `counts` counts every message not delivered yet, whatever the limit.
- **What you get of a message** is a 200-character preview of its text and the reason of its last failure, both with the vault's values masked, including a value added since the failure. Never the full message, the reply, the reply context nor the delivery checkpoint.

For a service each user connects with their own address and key, without messages, see [Per-user connections](connections.md).
