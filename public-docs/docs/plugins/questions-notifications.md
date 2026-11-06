---
title: Questions and notifications
sidebar_position: 13.8
---

An inbox plugin needs two things the conversation does not give it: every question an agent is waiting on, across all projects, and the notification centre. Both are plain facades on the plugin context. Requires `apiVersion: 10`.

```json
"timon": {
  "id": "acme-inbox",
  "apiVersion": 10,
  "permissions": ["questions:read", "questions:answer", "notifications:read", "notifications:write", "events:subscribe"]
}
```

| Permission | Surface |
| --- | --- |
| `questions:read` | `ctx.questions.list`, `get`; with `events:subscribe`, `question_pending` and `question_resolved` |
| `questions:answer` | `ctx.questions.resolve` |
| `notifications:read` | `ctx.notifications.list` |
| `notifications:write` | `ctx.notifications.dismiss` |

:::warning `questions:answer` is a sensitive permission
Answering unblocks the agent as if the user had clicked, and answering a Kanban plan has the agent apply it. Declare it only when your plugin really answers on the user's behalf — and show the user what is being sent.
:::

## Questions

A question is a form an agent opened with its `question` or `kanban_plan` tool and that waits for a person. A tool-use approval (Allow / Deny) is **not** a question: it is neither listed nor resolvable here.

```js
const waiting = await ctx.questions.list({ kinds: ['question'], project: 'acme' });
const one = await ctx.questions.get(waiting[0].id);

await ctx.questions.resolve(one.id, {
  answers: {
    'Which database?': 'Postgres',
    'Which checks?': ['lint', 'types'],
    'Ship it now?': { choice: 'Wait', text: 'after the demo on Friday' },  // a pick and a remark
  },
});
await ctx.questions.resolve(other.id, { cancel: true });     // the form is closed, not refused
await ctx.questions.resolve(plan.id, { plan: { mode: 'kanban-full', roles: {} } });
```

- **What you read.** `PluginQuestion`: `id`, `missionId`, `agent`, `kind` (`question` or `series_plan`), `questions` (text, `header`, `options` — each with `label`, `description` and `actor`, `'agent'`, `'user'` or `null`, saying who carries an action out —, `multiSelect`, `placeholder`), `plan` (the Kanban planner's title and steps, for `series_plan`), `createdAt`, `expiresAt`. Nothing else of the agent's request reaches you.
- **Which questions.** In a request, those of the calling account's missions; in a job, those of the missions your plugin owns. A question outside that view answers `undefined` (or `not_found` for `resolve`) — Timon does not confirm it exists.
- **The answer.** Keyed by the text of each question, like the chat form: every question needs a non-empty answer, a list only on a multi-select question, and a free-text answer is accepted on any question. To add a remark to a pick, as the free-text field of the chat form does, answer that question with an object: `{ choice, text }`, `{ choices, text }` on a multi-select, or `{ text }` alone. The former top-level `note` is deprecated: it still reaches the agent, but put the text in the answer of its question. A Kanban plan is checked as the chat checks it. A wrong answer throws `invalid` and the card keeps waiting.
- **Once.** The first answer wins; a second one, or one after the card expired, throws `not_found`.
- **Errors** throw `PluginQuestionError` with a `code`: `invalid`, `not_found`.

### Events

```js
ctx.events.on('question_pending', (ev) => { /* ev.question, ev.origin = the agent */ });
ctx.events.on('question_resolved', (ev) => {
  // ev.status: 'answered' | 'cancelled' | 'expired'
  // ev.origin: { kind: 'user' | 'plugin' | 'system', id } — who closed it
  // ev.decisionOrigin: 'ui_form_submit', 'plugin', 'auto_timeout', 'mission_end'…
});
```

Both need `events:subscribe` and `questions:read`. They reach your plugin for the missions you can read, in the identity of the account that owns them, one at a time and in order. The event of your own answer comes back to you with `origin: { kind: 'plugin', id }`, so you can ignore your own echo.

## Notifications

```js
const unread = await ctx.notifications.list({ type: 'action_required' });   // active: true by default
const archive = await ctx.notifications.list({ active: false });            // dismissed ones
await ctx.notifications.dismiss(unread[0].id);                              // true if it was open
```

- **What you read.** `PluginNotification`: `id`, `type` (`action_required`, `alert`, `report`), `urgent`, `title`, `body`, `taskId`, `missionId`, `anchor` (the id of the question it points at, for `action_required`), `source` (`plugin:<id>` when a plugin raised it), `agent`, `createdAt`, `readAt`, `dismissedAt`.
- **Which notifications.** In a request, the calling account's (an account holding `notifications:read:all` sees everyone's); in a job, those your plugin owns. A notification outside that view answers as if it did not exist: `dismiss` returns `false`.
- **Dismissing** closes the system notification on the user's devices too, like the button in the centre. Raising a notification stays `ctx.notify` (permission `notify`).
- **Errors** throw `PluginNotificationError` with a `code`: `invalid`, `module_disabled` (the notification centre is switched off).
