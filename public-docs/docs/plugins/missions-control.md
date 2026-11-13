---
title: Controlling missions
sidebar_position: 13.8
---

Beyond starting a mission, your plugin can act on one that already exists — send it a follow-up, stop it, summarise it, fork it, search the history, read its trace — and follow its life through events. Requires `apiVersion: 10`.

```json
"rooks": {
  "id": "acme-ops",
  "apiVersion": 10,
  "permissions": ["missions:control", "missions:read", "events:subscribe"]
}
```

| Permission | Opens |
| --- | --- |
| `missions:read` | `ctx.traces.get` without span payloads and without what was said (mission prompts, channel metadata, mission summaries, message bodies, task descriptions, reports and block reasons come back empty; ids, agents, statuses, costs, senders, recipients, kinds and timestamps stay); events `mission_started` and `turn_complete` |
| `missions:control` | `send`, `kill`, `fork`, `stopScope` |
| `missions:transcript` | `search`, `summarize`; the full `ctx.traces.get` (mission prompts and channel metadata, mission summaries, message bodies, task descriptions, reports and block reasons); span payloads; the summary returned by `fork`; events `event` and `event_delta` |

`missions:transcript` is separate because it reads everything an agent and its user said.

## What you can see

Every call is bounded by the caller. In a route, you act on the missions of the account that made the request, and that account needs the right too (`fork` needs `missions:spawn`; `stopScope` needs `missions:stop` or `missions:spawn`). In a background job, you act only on the missions your plugin started. A mission outside that view answers `code: 'not_found'`, as if it did not exist. A request with no signed-in account (before setup) can read but never act (`code: 'forbidden'`).

`send` and `kill` are limited to the missions you can see and do not check any further right on the account: whoever can see a mission through your plugin can redirect or stop it. Declare `missions:control` only if that is what you want to offer.

## Reading missions

`ctx.missions.get(id)` and `ctx.missions.list(options?)` need `missions:read` and see exactly what the section above describes: the requesting account's missions in a route, the missions your plugin started in a background job or an event handler.

```js
const mission = await ctx.missions.get(missionId);     // undefined outside your view
const running = await ctx.missions.list({ status: 'running', agents: ['acme.coder'], limit: 20 });
```

`list` returns the most recent missions first, 50 by default. `agents` keeps only the missions of those agents (an empty list returns nothing), `status` only one status (`running`, `completed`, `failed`, `terminated`…). Both return the mission as Rooks stores it, typed `unknown` in the SDK: read the fields you use (`id`, `agent_name`, `status`, `title`, `started_at`, `ended_at`…) defensively. Unlike `ctx.traces.get`, they also carry the mission's prompt (`mission`) and its `summary` under `missions:read` alone: never show them to another account.

## Acting on a mission

```js
// Follow-up turn. The chat shows it as coming from your plugin.
const { resumed } = await ctx.missions.send(missionId, 'Also run the linter.');

await ctx.missions.kill(missionId);                       // { outcome: 'killed' | 'closed' }, logged under your plugin's id

const { summary } = await ctx.missions.summarize(missionId);
const fork = await ctx.missions.fork(missionId, { to: 'acme.reviewer', message: 'Review this.' });

const { hits } = await ctx.missions.search('invoice 4412', { agent: 'acme.coder', since: '7d', limit: 20 });

// Technical stop of one agent or one project: running missions, inbox, open
// tasks and triggers. You stop your own rows only.
await ctx.missions.stopScope({ agent: 'acme.coder' });
```

- `send` takes up to 20 000 characters. If the agent is mid-turn it fails with `turn_in_progress`; if its process died, the mission is resumed in place (`resumed: true`) when its session is known, otherwise `not_running`. A backend out of quota fails with `backend_exhausted` — Rooks does not switch backend behind your back.
- `send`, `fork` and `summarize` use the machine's AI subscription, so they go through the operator's `pluginPolicy.spawn` approval and quota, shared with `spawn` ([Permissions](permissions.md)).
- `fork` returns `missionId` and `cached`; `summary` is there only with `missions:transcript`.
- `search` accepts `agent`, `project`, `since`, `until` (an epoch, a date or `2h` / `7d`) and `limit` (30 by default, 200 at most). While the search index is still being built, `progress` says so: zero hits then does not mean "nothing".

## Starting a mission with more options

`ctx.missions.spawn` also takes `model`, `backend`, `extraSkills`, `extraMcp` and `allow` (extra pre-approved tools):

```js
await ctx.missions.spawn({
  agent: 'acme.coder', mission: 'Fix the build.',
  model: 'sonnet', allow: ['Bash(npm test:*)'],
});
```

Without `agents:privileged-config` on the calling account, and always in a background job, these may only restate what the agent already declares, with a model from the backend's catalogue. Anything wider fails with `code: 'override_denied'` and a message naming the cause.

## Traces

```js
const trace = await ctx.traces.get(missionIdOrTraceId, { spanLimit: 200 });
```

Returns the missions, tasks, messages, spans and sums of the causal chain that the caller may see, or `undefined`. Span payloads (tool inputs and outputs) are left out unless you hold `missions:transcript` and pass `payload: true`.

## Events

```js
ctx.events.on('mission_started', (ev) => { /* ev.missionId, ev.agent, ev.origin */ });
ctx.events.on('turn_complete', (ev) => { /* ev.missionId, ev.outcome: 'completed' | 'failed' */ });
ctx.events.on('event', (ev) => { /* a complete transcript row: ev.type, ev.payload */ });
ctx.events.on('event_delta', (ev) => { /* a live fragment of the answer being written */ });
```

You receive the events of the missions your plugin started and of the users allowed to use it; a handler for a user's mission runs in that user's identity (`ctx.user()`). Handlers run one at a time, in order. `mission_started.origin` is `{ kind, id }`: `plugin`, `user`, or the channel that started it (`agent`, `fork`, `routine`…). `event_delta` fragments are not replayed, and the oldest are dropped first if your handler falls behind.

In the browser half, `ctx.events.subscribe` accepts `mission_started` and `turn_complete`, and `event` when the manifest declares `missions:transcript`. Live fragments (`event_delta`) are host-only.

## Errors

Failures throw `PluginMissionError` with a `code`: `invalid`, `not_found`, `forbidden`, `not_running`, `turn_in_progress`, `backend_exhausted`, `override_denied` or `failed`. A missing permission throws `PluginPermissionError`; the operator's approval or quota throws `PluginPolicyError`.
