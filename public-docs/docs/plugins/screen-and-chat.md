---
title: The screen and the chat
sidebar_position: 13.8
---

Your plugin can read how a user arranged their screen, ask them to change it, send them to a page, show a media in a conversation and propose a command for them to paste into their terminal. **Nothing is ever applied by your plugin.** Every change is a card in one of the user's own missions, shown as coming from `plugin:<your-id>`, that only they can accept — the same cards an agent raises with its `widgets_propose`, `islands_propose`, `nav_propose`, `ui_navigate` and `terminal_propose` tools. Requires `apiVersion: 10`.

```json
"timon": {
  "id": "acme-guide",
  "apiVersion": 10,
  "permissions": ["layout:read", "layout:propose", "chat:media"]
}
```

| Permission | Surface |
| --- | --- |
| `layout:read` | `ctx.layout.widgets.get`, `islands.get`, `nav.get` |
| `layout:propose` | `ctx.layout.widgets.propose`, `islands.propose`, `nav.propose`, `ctx.ui.navigate`, and reading back your own cards with `ctx.layout.proposals` |
| `layout:presets` | `ctx.layout.widgets.presetSave`, `islands.presetSave` — saves the current arrangement as a named preset of the user's Layouts menu |
| `chat:media` | `ctx.chat.showMedia` (sensitive: Timon fetches an address or reads a file for you; an https source also needs `http:outbound`) |
| `chat:command` | `ctx.chat.proposeCommand`, `ctx.chat.commandRequests.get` (sensitive: the user may paste the command into their terminal) |
| `onboarding:read` | `ctx.onboarding.profile()` |

## Whose screen

The screen belongs to **the account of the request**. Call these from a route handler or a request-driven callback; in a background job there is no account and every call throws `PluginLayoutError` with the code `no_owner`.

A proposal, a media or a command also names a mission, and that mission must be the calling account's own. Another account's mission, an absent one and a mission an administrator can see without owning all answer `not_found`.

## Read the arrangement

```js
const widgets = await ctx.layout.widgets.get({ view: '/chat' });   // zones, placed widgets, the catalog this user may use
const islands = await ctx.layout.islands.get({ view: '/chat' });   // the island tree and the content types
const nav = await ctx.layout.nav.get();                            // the side menu: hidden pages, order, footer
const { profile } = await ctx.onboarding.profile();                // 'developer' | 'automation' | 'beginner' | null
```

You only read what that user may see: a widget of a plugin they were not granted is not in the catalog. When the user has not opened Timon in a browser since this version, titles and content types are unknown and a read says so (`note`, `warning`).

## Ask them to change it

```js
await ctx.layout.widgets.propose({
  missionId,                                  // one of the caller's own missions
  view: '/chat',                              // default: the cockpit
  zones: { 'chat.right.widget': ['plugin:acme:Notes'] },
  note: 'Notes next to the chat',             // up to 300 characters, shown on the card
});
await ctx.layout.islands.propose({ missionId, open: { content: { type: 'acme:viewer' }, edge: 'right' } });
await ctx.layout.nav.propose({ missionId, hidden: ['/kanban'] });   // the complete list of hidden pages
await ctx.layout.nav.propose({ missionId, order: ['/', '/growth', '---', '/agents'], footer: ['/plugins'] }); // order, separators ('---'), bottom of the menu
await ctx.ui.navigate({ missionId, path: '/settings', params: { tab: 'plugins' } });
```

Each call returns `{ id, status: 'pending' }` and puts a card in that mission's conversation. The same checks as the agent tools apply: ids and zones from the matching `get`, a widget or content of a plugin the user cannot use is refused (`invalid_proposal`, with the problems in `error.details`), and the card is checked again at the click. `ctx.ui.navigate` always raises a card, even while the user runs a guided tour with an agent: that shortcut belongs to the agent's mission. Your browser half keeps its own direct `navigate`.

Read the answer back, for your own cards only:

```js
const card = await ctx.layout.proposals.get(id);                    // { status: 'pending' | 'applied' | 'dismissed', … }
await ctx.layout.proposals.list({ missionId, status: 'applied' });
```

The mission's agent is not told: it proposed nothing.

## Save a preset

```js
await ctx.layout.widgets.presetSave({ name: 'Focus', view: '/chat' });   // direct, changes nothing on screen
```

The current arrangement of the view becomes a named preset in the user's Layouts menu (12 per view, names up to 40 characters; an existing name is refused unless `replace: true`). Islands and widgets share one preset per view. The menu deletes it in a click.

## Show a media

```js
await ctx.chat.showMedia({ missionId, src: '/path/inside/the/mission/chart.png', caption: 'Weekly chart' });
```

`src` is an https address, a PNG/JPEG/GIF/WebP `data:` image or a file inside the mission's working directory. Timon checks it, keeps its own copy and shows it in the owner's chat; nothing else about it reaches the browser. Rejected sources throw `refused`.

An **https address makes Timon fetch on your behalf**, so it is `ctx.fetch` under another name: declare `http:outbound` too, and the host must be allowed for your plugin, in the operator's `pluginPolicy.http.allow` or `pluginPolicy.http.byPlugin` ([Permissions](permissions.md)); otherwise the call throws `PluginPermissionError` or `PluginPolicyError` before anything is fetched. A local file or a `data:` image needs neither.

## Propose a command

```js
const { id } = await ctx.chat.proposeCommand({ missionId, command: 'brew install ffmpeg', note: 'Needed for the export' });
const request = await ctx.chat.commandRequests.get(id);   // status: 'pending' | 'paste' | 'deny'
```

The command is one line of printable text (up to 2000 characters). The card offers the owner **paste** (typed into their terminal without the final Enter, so they read it and run it) or **dismiss**; there is no "run it for me": no agent raised it. The call never waits. The command text is kept out of the audit trail, like an agent's.

## `ctx.ui.token()`

The host half's `ctx.ui.token()` returns a signed token that names your plugin and expires after ten minutes. It needs no permission. No Timon route accepts it today: your browser half calls your own routes with `ctx.api`, which carries the signed-in user's session, and that is the way to reach them. Do not hand the token to a third party as a credential.

## Errors

They throw `PluginLayoutError` with a `code`: `invalid` (a field the schema refuses), `invalid_proposal` (the owner cannot see what you named), `no_snapshot` (the user never opened Timon in a browser, so no catalog exists yet), `too_large`, `conflict` (a preset name already used), `no_owner` (no account: a job), `not_found` (a mission that is not the caller's), `refused` (a source, a terminal or a module that is not available). A permission you did not declare throws `PluginPermissionError` before anything is read.
