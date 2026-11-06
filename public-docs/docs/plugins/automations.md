---
title: Automations
sidebar_position: 13.8
---

Your plugin can schedule work without touching Timon's database: recurring **routines**, **triggers** (a schedule, a webhook or an internal event that runs actions), multi-agent **pipelines**, and runs of the user's **workflows**. Each is a facade on `ctx` with its own permissions, bounded by the caller, and announced to your plugin through events that say who made the change. Requires `apiVersion: 10`.

```json
"timon": {
  "id": "acme-reports",
  "apiVersion": 10,
  "permissions": ["routines:write", "kanban:write", "events:subscribe"]
}
```

| Facade | Permissions | Methods |
| --- | --- | --- |
| `ctx.routines` | `routines:read`, `routines:write` | `list`, `create`, `update`, `delete` |
| `ctx.triggers` | `triggers:disable`, `triggers:read`, `triggers:write`, `triggers:execute` | `list`, `disable`, `get`, `create`, `remove`, `test` |
| `ctx.pipelines` | `pipelines:read`, `pipelines:write`, `pipelines:run` | `list`, `get`, `create`, `delete`, `run`, `runStatus` |
| `ctx.workflows` | `workflows:read`, `workflows:run` | `list`, `get`, `status`, `run`, `cancel` |

Writing also lets you read. The powerful permissions — `routines:write`, `triggers:write`, `triggers:execute`, `pipelines:write`, `pipelines:run`, `workflows:run` — start work nobody is watching: ask for them only if you use them.

## What your plugin owns

Whatever your plugin creates belongs to it: its owner is `plugin:<your-id>`, in a request as in a background job. You read what the caller can see plus what you own, and you change only what you own. Anything else answers as if it did not exist (`not_found`, `false` or `undefined`), or fails with `forbidden` when you can see it without having created it. Rows that belong to the system — the nightly backup, anything made before owners existed — are visible to a superadmin only and are never yours to change.

The tasks a routine opens, and what a trigger's actions create, belong to your plugin too. An `event` trigger therefore reacts to the objects your plugin owns, not to another account's tasks or missions; to react to a user's events, listen with `ctx.events.on` in the host half.

In a request the caller's account needs the right the app would ask: `triggers:manage` for the trigger methods, `kanban:write` to create or update a routine or to run a pipeline, `workflows:run` to start a workflow. A request without an account is refused.

## Operator approval and quota

Work that runs with nobody in front uses this machine's AI subscriptions, so it needs approval (a signed plugin declaring `missions:spawn` has it; an unsigned one needs `pluginPolicy.spawn.approved`) and counts against the same quota as `ctx.missions.spawn` ([Permissions](permissions.md)):

| Call | Approval is checked | Quota |
|---|---|---|
| `ctx.routines.create`, or `update` with `enabled: true` | Always, even in a request: the routine ticks as your plugin | One per tick; over it, the tick is skipped |
| `ctx.triggers.create` with a `task` action | Always, even in a request | One per task opened at a run; none for a dry run |
| `ctx.pipelines.run` | In a background job, a webhook handler or an event handler | One per step, all or nothing |
| `ctx.workflows.run` | In a webhook handler or an event handler | One per run |

Until then the call fails with `code: 'forbidden'`, nothing is stored or started, and the operator sees a card naming the config line. A routine or a trigger left disabled can still be stored. A pipeline with more steps than `pluginPolicy.spawn.max` needs that limit raised to run outside a request. Tell your user the work is waiting rather than retrying in a loop.

## Routines

```js
const routine = await ctx.routines.create({
  name: 'Weekly digest',
  agent: 'worker',                 // an existing agent
  prompt: 'Summarise the week',
  cron: '0 8 * * 1',               // never more often than every 5 minutes
  project: 'acme',                 // optional, an existing project
})
await ctx.routines.update(routine.id, { enabled: false })
await ctx.routines.delete(routine.id)
```

A plugin owns at most 50 routines. `create` and `update` need `kanban:write` in your manifest too.

## Triggers

```js
const { trigger, secret } = await ctx.triggers.create({
  source: 'webhook',
  name: 'Orders',
  slug: 'acme-orders',
  config: { auth: 'standard' },
  actions: [{ type: 'notify', title: 'Order {order.id}' }],
})
const dry = await ctx.triggers.test(trigger.id, { payload: { order: { id: 7 } } })
```

- What a trigger may do is capped by your manifest: `task` and `todo` actions need `kanban:write`, `notify` needs `notify`, `workflow` needs `workflows:run`, `webhook` needs `http:outbound`. In a request the caller must hold the same rights. A superadmin does not lift the cap. A plugin can never create a `script` action, which runs a program on the host: only a person sets one up.
- A `webhook` action must target a host allowed for your plugin (`pluginPolicy.http.allow`, or `pluginPolicy.http.byPlugin` under your ID), checked when you create the trigger and at every run. It must also be a public address: a private, local or cloud metadata address is refused even if the allow-list names it.
- A webhook trigger cannot be unauthenticated (`auth: 'none'` is refused).
- A `schedule` trigger runs at most once a minute (a routine: every 5 minutes); a cron whose seconds field holds several values is refused.
- Secrets (`secret`, `outboundSecret`) come back once, from `create`. They are never readable again.
- `test` is a dry run by default. `execute: true` runs the actions and needs `triggers:execute`.
- You can read a trigger you do not own, but only its identity: no action body, and a webhook action shows its host only. `remove` and `test` reach your own triggers. There is no `update`: remove and create again.
- A plugin owns at most 100 triggers.

## Pipelines

```js
const pipeline = await ctx.pipelines.create({
  name: 'Release',
  steps: [
    { id: 'plan', agent: 'worker', prompt: 'Plan {{input.feature}}', type: 'research' },
    { id: 'build', agent: 'worker', prompt: 'Build {{input.feature}}', type: 'code', deps_on: ['plan'] },
  ],
})
const run = await ctx.pipelines.run(pipeline.id, { feature: 'search' })
const status = await ctx.pipelines.runStatus(run.runId)
```

A run opens one task per step. In a request those tasks belong to the caller; in a job, to your plugin — and `runStatus` reads only those runs. Of a pipeline you do not own you see a summary (name, step count, the `{{input.x}}` keys), never its prompts. A step cannot carry extra skills, MCP servers or tools, nor a model or permission-mode override. Limits: 50 pipelines per plugin, 25 steps, 64 KiB of input, and 5 runs open at once — a run stays open while one of its tasks is pending or running (a blocked step keeps it open until resolved); a sixth is refused with a `quota` error. Deleting a pipeline deletes its run records, not their tasks.

## Workflows

```js
const workflows = await ctx.workflows.list()
const run = await ctx.workflows.run(workflows[0].id, { day: '2026-10-18' })
const status = await ctx.workflows.status(run.id)   // nodes, input and outputs
await ctx.workflows.cancel(run.id)
```

A plugin never creates, edits or publishes a workflow; it runs the **published** version of one the caller can see. A background job owns no workflow and therefore sees none.

## When your plugin is removed

Removing a plugin (`timon plugin remove`) switches off the routines and triggers it owned — they run unattended, and nobody answers for them once the plugin is gone. The rows stay, the command names them, and an administrator can delete or re-enable them from the Routines and Triggers pages. The pipelines it defined only run on request, so they are kept. Disabling a plugin without removing it changes nothing. Editing a plugin's trigger by hand (renaming, re-enabling) never gives it more rights than your manifest did.

## Errors

Failures throw a `PluginAutomationError` with a `code`: `invalid`, `not_found`, `conflict`, `forbidden`, `quota` or `unavailable`. A missing manifest permission throws `PluginPermissionError`; a caller without the right throws `PluginCallerError`.

## Events

Follow the lifecycle on the host half, with `events:subscribe` and a read permission of the entity:

| Events | Needs |
| --- | --- |
| `routine_created`, `routine_updated`, `routine_deleted` | `routines:read` |
| `trigger_created`, `trigger_updated`, `trigger_removed` | `triggers:read` |
| `pipeline_created`, `pipeline_updated`, `pipeline_deleted`, `pipeline_run_started` | `pipelines:read` |
| `workflow_run_started`, `workflow_run_cancelled` | `workflows:read` |

```js
ctx.events.on('routine_updated', (ev) => {
  if (ev.origin.kind === 'plugin' && ev.origin.id === ctx.id) return   // your own write
  console.log(ev.routine.name, 'changed by', ev.origin.kind)
})
```

`origin` is `{ kind: 'user' | 'agent' | 'plugin' | 'system', id }`: a change you make yourself carries `{ kind: 'plugin', id: ctx.id }`. The snapshot is the object as the write left it (as it was, for a delete) and is projected for your plugin. You receive the objects your plugin owns and those of users allowed to use your plugin, inside that user's identity; system rows and other plugins' objects never reach you. A workflow run's final status is the existing `workflow_run` event.
