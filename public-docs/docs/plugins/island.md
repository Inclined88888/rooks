---
title: Island content
sidebar_position: 7
---

An island content plugin supplies the body of a workspace tab. Users can open
it beside their current page, move it between islands, or add it to a stack of
tabs. Rooks supplies the frame, tab bar, resize gaps and keyboard controls.

Declare **`apiVersion: 8`**, **`kind: "island"`** and
`client.slots: ["island.content"]`. Keep React and `@rooks/ui` external. No host
entry or permission is needed for a browser-only content. Data access still
requires the permissions and authentication of the API it calls.

The supplied **`examples/plugin-island`** package is a complete browser-only
template. Its manifest ID is `example-island`; its registered key is `board`,
so the content type is **`example-island:board`**. The npm package name does
not determine this ID.

## Register the type

Inside `apply(ctx)`, register a component without props:

```js
return ctx.slots.register({
  slot: 'island.content',
  key: 'board',
  island: {
    title: 'Board',
    parseParams(raw) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      return typeof raw.id === 'string' && /^[a-z0-9-]{1,40}$/.test(raw.id)
        ? { id: raw.id } : null
    },
    params: { id: { type: 'string', required: true, maxLength: 40 } },
    singletonBy: 'id',
  },
}, Board)
```

`parseParams` validates and cleans incoming or saved params; `null` refuses
them. `params` describes fields to agents composing layouts: type (`string`,
`number`, `boolean`), `required`, `nullable`, `enum`, `maxLength`, `min`, `max`
and `description`. Without `params`, an agent's proposal is accepted with a
warning and only `parseParams` judges it, when the user applies it: declare
them. Validation in the browser still runs. Persist identifiers,
never secrets or business data: params must be flat and fit within 1 KiB.
Read the actual data through your authenticated plugin API.

Registration makes the type available; it does not open a tab automatically.
Return the slot disposer so unloading releases the type. Saved tabs remain as
unavailable placeholders while the plugin is disabled and recover when it returns.

## Read the tab context

Import `useIslandContent` from `@rooks/ui` inside your component:

```js
const { params, setParams, setTitle, close, focused, active, primary } = useIslandContent()
```

The hook also returns `islandId`, `tabId` and `type`. `setParams(next)` passes
through your parser before saving, in a docked island or a popup alike; params
your parser refuses change nothing, with a console warning and a notice. `setTitle(null)` restores the registered
title; `close()` closes this tab. The hook throws outside island content.
`primary` is useful for an `exclusive` group sharing a single resource.

Inactive tabs unmount by default: clean up requests, subscriptions and other
effects. Declare `keepMounted: true` only when hiding the content must preserve
its mounted instance. The context's `active` tells a kept instance when to pause.

## Open or drag content

From a button or menu already in one of your declared slots:

```js
import { openInIsland, startIslandDrag } from '@rooks/ui'

const content = { type: `${ctx.id}:board`, params: { id: 'demo' } }
const opened = openInIsland(content, { edge: 'right' })
```

Edges are `right` (default), `left`, `top`, `bottom`, and `center` (a tab in the
focused island). Narrow views open tabs. An already open identity is activated;
`false` means no workspace is ready or the opening was refused. Show a useful
message on refusal. Limits are 8 islands, depth 3, 12 tabs per island and 32 in total.

For a draggable source, call `startIslandDrag(event, content, { label,
onDropped })` in `onDragStart`. Set your own `dataTransfer` types first; they
are preserved. `onDropped` runs only after acceptance. Optional `hold: element`
keeps the workspace drop layer down while the pointer is inside a source that
has its own drop targets. Always supply a click or menu action too, for keyboard
and touch users; drag and drop is unavailable in narrow workspaces.

To bootstrap the supplied template, ask your agent to use `islands_get` and
`islands_propose` to open `example-island:board` with `{"id":"demo"}`, then
apply the proposal card. Its button opens or drags a second board. A launcher
outside island content needs another declared surface, such as a widget; list
both kinds and both slots in that case.

## Other content options

`IslandContentOptions` and `IslandParamSpec` are exported by `@rooks/sdk`.
`singletonBy` accepts one param name or a list identifying a resource; absent,
identical params identify the same content. With a list, the first param must
be set, and a later one left out on both sides counts as the same value. `minWidth` and `minHeight` default
to 280 and 160 pixels. `icon` is SVG markup. `exclusive` names a group with a
single primary instance. `detach(params)` supplies an action to reopen the
content in its own window. `volatileParams` names fields to omit from named
presets. `groupBy` names a param whose value groups tabs of the type in one
island (a terminal's scope); `newTab(params)` makes the "+" of the tab bar
return the params of one more tab; `onClose(params, tabId)` runs once the tab
is closed, by the user, the content or Rooks, to end what it held.

`beforeClose(params, tabId)` lets a content keep its tab when the user asks to
close it (its ×, a middle click, Delete, the tab menu or the island's close):
return `false` to keep it, or a promise to ask first, for example about unsaved
changes. Closing an island asks each of its tabs and closes none if one says
no. Moving a tab, or a close made by the content itself (`close()`) or by Rooks,
does not ask. An arrangement that replaces the tab (a recalled arrangement or
preset, a preset applied to every project, an agent's card) asks too, and a no
cancels the whole arrangement. That holds for a page that is not on screen as
well: the tab is not mounted then, so `beforeClose` and `onClose` run without
your component. An error or a rejected promise keeps the tab, and Rooks shows a
notice: the check guards unsaved work. Saying yes does not close the tab yet, as
a later tab of the same island may still keep them all: discard state in
`onClose`, never in `beforeClose`. An inactive tab is unmounted: keep the state
your check reads outside the component.

`island.content` admission is exact: a `.widget` slot does not grant it.
The `host:route` type belongs to the page host. Use the slot contract instead
of creating a second content registry or a nested workspace.
