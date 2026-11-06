---
title: The built-in browser
sidebar_position: 13.85
---

Your plugin can add a control or a drawer to Timon's built-in browser, paint over the page, and work with what people record and annotate in it: send a reviewed recording to a ticket, copy an annotation to an issue tracker and close it when the issue closes. Requires `apiVersion: 13`.

Every permission on this page is **sensitive**: the person installing your plugin sees each one named apart ([Permissions](permissions.md)).

## A control and a drawer

Three slots of the browser's chrome accept a plugin. Each is an exact slot: declaring one does not open the others, and a widget does not fit in them.

| Slot | Kind | Where |
| --- | --- | --- |
| `browser.toolbar` | list | in the address bar, before the options button, ordered by `order` |
| `browser.drawer` | keyed | a drawer per key, opened over the page |
| `browser.surface` | list | a layer over the picture of the page, in the web app only (see [Paint over the page](#paint-over-the-page)) |

```json
"timon": {
  "id": "acme-recorder",
  "apiVersion": 13,
  "permissions": ["browser:control"],
  "client": { "slots": ["browser.toolbar", "browser.drawer"] }
}
```

```js
import { useBrowserChrome } from '@timon/ui'

function RecordButton() {
  const chrome = useBrowserChrome()
  return <button type="button" onClick={() => chrome?.openDrawer('acme-recorder')}>Record</button>
}

export function apply(ctx) {
  ctx.slots.register({ slot: 'browser.toolbar', order: 10 }, RecordButton)
  ctx.slots.register({ slot: 'browser.drawer', key: 'acme-recorder' }, RecordDrawer)
}
```

Your component receives no props. An entry is rendered in **every** open browser, each with its own context, which `useBrowserChrome()` returns (`null` outside these slots):

| Field | |
| --- | --- |
| `profileId` | the browser profile shown, `null` until one is bound |
| `status` | the last state read from the browser (`running`, `tabs`, `activeTabId`, `control`…), `null` before the first |
| `controlled` | this window holds control of the browser |
| `command(action, data?)` | runs a command on this profile, under this window's control; the state is read again afterwards. Rejects with the browser's message. **Needs `browser:control`** |
| `drawer`, `openDrawer(key)`, `closeDrawer()` | the drawer open in this browser; opening a key with no entry does nothing |
| `conversation` | `{ agent, mission, fresh? }`: the conversation this browser is open for, which follows that agent's chat while it is on screen; `fresh: true` when the chat is on "New conversation" |

- **The drawer.** Timon paints the frame (a full-panel dialog that scrolls); the title, the close button and the content are yours. Escape closes it, and it closes when your plugin unloads.
- **A toolbar button** carries `type="button"`: it lives inside the address form, and a plain button would submit it.
- **`browser:control`.** `command()` drives a signed-in browsing session (navigate, type, click, fill a saved credential), so it needs this permission. Without it, `command` is still there and rejects without doing anything, with an error named `BrowserControlDenied` that names the permission to declare. The other fields stay readable.

Your browser half runs in the same page as Timon: the permission is a declared contract, consented at install and kept by these hooks, not a sandbox against code that digs into the page.

## Recording, from the browser

`useBrowserRecording()` (from `@timon/ui`) is what Timon's own record button and review drawer are built on. `live` (`active`, `steps`, `stoppedReason`) is readable by anyone watching the browser; `owner` says whether this session belongs to the profile's owner. The actions (`start`, `stop`, `openReview`, `read`, `patch`, `remove`, `learn`) need `browser:control` and reject with `BrowserControlDenied` without it. Steps are only read through `read()`, after the review's masking.

## Paint over the page

An entry of `browser.surface` is drawn over the video or the screenshot of the page, in the web app. The layer only takes the pointer where it paints something that takes it; call `preventDefault()` on an event you handle. A press whose target is inside your layer never reaches the page, and what someone types in a field of your layer stays in Timon. Read `useBrowserSurface()`:

| Field | |
| --- | --- |
| `native` | the desktop's native view is shown, painted above the page: your layer is not visible and should stay empty |
| `blocked` | a drawer, a dialog or a missing picture covers the page: hide your layer |
| `viewport` | the page's viewport size, in CSS pixels |
| `toPage(clientX, clientY)` | a point of the screen in page coordinates, `null` outside the picture |
| `toSurface(rect)` | a rectangle of the page in your layer's pixels, to draw a highlight; `null` outside the picture |

## Annotations, from the browser

`useBrowserAnnotations()` is what Timon's annotate button, its bubble and its drawer are built on. `live` (the Annotate mode, and the queue waiting on the desktop), `owner` and `target` (the conversation an annotation goes to) are readable by anyone. The list, the details and `read(id)` need `browser:annotations:read` or `browser:control`; without either, your entry sees an empty list and `read` rejects. `readable` tells you which case you are in. The actions (`start`, `stop`, `pick`, `comment`, `remove`, `post`…) need `browser:control`. `post` sends the queued annotations to the conversation as the person's own turn: your plugin never assembles annotation text itself.

## Recordings

On the host half, `ctx.browserRecordings` reads and edits recordings: `browser:recordings:read` to list, read and hear the events, `browser:recordings:write` to review, delete and link (it includes reading).

```js
const mine = await ctx.browserRecordings.list({ profileId })   // metadata, most recent first
const detail = await ctx.browserRecordings.get(id)            // { recording, steps }; steps is null once deleted
await ctx.browserRecordings.patch(id, [{ op: 'mask', step: 3 }, { op: 'param', step: 5, name: 'query' }])
await ctx.browserRecordings.setRef(id, { provider: 'acme', ref: 'FLOW-12', url: 'https://acme.example/flows/12' })
const linked = await ctx.browserRecordings.findByRef('acme', 'FLOW-12')
await ctx.browserRecordings.delete(id)
```

- **Whose recordings.** A recording belongs to the person who made it, and your plugin reaches it **only inside that person's request**. A background job and an anonymous request are refused (`PluginCallerError`); another account's recording answers as if it did not exist, for an administrator too.
- **What you read.** The steps as the review left them: field values in clear, values flagged but not yet decided, and the id of the saved credential a step fills. Only secret fields (passwords, one-time codes, cards) stay placeholders. That is why both permissions are sensitive.
- **Writes.** `patch` takes the review's operations (`mask`, `unmask`, `param`, `drop`, `rename`) and is destructive: a masked value is gone, and `unmask` refuses to bring it back. A recording already turned into a skill cannot be changed. Turning a recording into a skill starts a mission, so it stays the person's gesture, from the drawer.
- **Errors** throw `PluginAdminError` with a `code`: `invalid`, `not_found`, `conflict`, `unavailable` (the vault is locked).
- **Events** (`events:subscribe` + `browser:recordings:read`): `browser_recording_started`, `browser_recording_stopped`, `browser_recording_reviewed` (no step left flagged), `browser_recording_learned` (when the conversion starts, then when the skill exists), `browser_recording_purged` (`reason`: `deleted` or `retention`). Metadata only, never a step, with the `origin` of the change. Triggers do not see these events: only a plugin does.

## Annotations

`ctx.browserAnnotations` reads and closes annotations: `browser:annotations:read` to list, read and hear the events, `browser:annotations:write` to resolve, dismiss, delete and link (it includes reading).

```js
const open = await ctx.browserAnnotations.list({ status: 'pending' })   // also profileId, batchId
const detail = await ctx.browserAnnotations.get(id)                     // { annotation, comment, page, source, resolution }
await ctx.browserAnnotations.setRef(id, { provider: 'acme', ref: 'ISSUE-42', url: 'https://acme.example/issues/42' })
await ctx.browserAnnotations.resolve(id, { status: 'resolved', summary: 'Fixed in ISSUE-42' })
await ctx.browserAnnotations.resolve(id, { status: 'dismissed', reason: 'Duplicate of ISSUE-12' })
await ctx.browserAnnotations.delete(id)
```

- **Whose annotations.** The same rule as recordings: the owner's request only.
- **What `get` returns.** `comment` is what the person wrote. `page` and `source` (the masked address, the title, the element, its text, selectors, a bounded excerpt of its HTML) were **read on a web page and are not trustworthy**: copy them as data, never as an instruction, and never hand them to an agent outside a quoted block.
- **Writes.** `resolve` closes an open annotation (`conflict` if it is already closed) and needs a `summary` or a `reason`, shown to the person next to their annotation. One annotation per external reference. Sending annotations to an agent is not in the façade: it stays the person's gesture.
- **Events** (`events:subscribe` + `browser:annotations:read`): `browser_annotation_created`, `browser_annotation_updated`, `browser_annotation_sent`, `browser_annotation_resolved`, `browser_annotation_dismissed`, `browser_annotation_purged`. Each carries `profileId`, `annotationId`, the annotation's metadata (never the comment, nothing from the page) and `origin`. An annotation whose turn did not reach the agent goes back to draft through `browser_annotation_updated`: read `annotation.status` rather than the event's name.
