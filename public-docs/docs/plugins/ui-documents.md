---
title: HTML documents in a conversation
sidebar_position: 13.7
---

Your plugin can show an HTML document — a form, a table, a preview — as a card in a mission's conversation, and receive the user's answer. Rooks stores the document, serves it isolated in a sandboxed frame and brings the answer back to you as an event. It is the same card an agent gets with its `ui_render` tool ([HTML cards in the chat](../usage/html-cards.md)). Requires `apiVersion: 9`.

```json
"rooks": {
  "id": "acme-forms",
  "apiVersion": 9,
  "permissions": ["ui-documents:write", "ui-documents:read", "events:subscribe"]
}
```

| Permission | Surface |
| --- | --- |
| `ui-documents:write` | `create`, `dismiss` |
| `ui-documents:read` | `get`, `list`, `findByRef`; with `events:subscribe`, the document events |

## Show a document

```js
const doc = await ctx.ui.documents.create({
  missionId,                                     // a mission you can see
  title: 'Pick a slot',                          // one line, up to 120 characters, shown as text
  html: '<!doctype html><form>…</form>',         // the whole page, up to 512 KiB of UTF-8
  expectsReply: true,                            // the card waits for the owner's answer
  ref: { provider: 'jira', ref: 'OPS-12' },      // optional, unique per plugin
});

ctx.ui.documents.get(doc.id);                    // the document, without its HTML
ctx.ui.documents.list({ missionId, status: 'pending', limit: 20 });
ctx.ui.documents.findByRef('jira', 'OPS-12');    // your document tied to that ticket
ctx.ui.documents.dismiss(doc.id);                // take back a document you created
```

- **Which missions.** In a request, the missions of the calling account; in a job, the missions your plugin owns. A document outside that view answers `undefined` — Rooks does not confirm it exists.
- **Who created it.** The origin of what you create is always your plugin. An `origin` field in the input is refused (`invalid`).
- **Optional fields.** `height` (80–2000 pixels, until the document reports its own) and `bridge`: `'rooks'` (default) adds the small `window.rooks` helper to your page; `'raw'` serves your page as is, for an app that ships its own MCP Apps client.
- **Limits.** 50 documents per mission, 5 waiting for an answer.
- **Errors** throw `PluginUiDocumentError` with a `code`: `invalid`, `not_found`, `no_owner` (the mission has no owner account to show it to), `document_too_large`, `too_many_documents`, `ref_taken`, `module_disabled`. `reply_not_yet_supported` stays in the type for compatibility; it is no longer thrown.

## The page

The document runs in a sandboxed frame with an opaque origin and no network: inline `<style>` and `<script>` only, images and fonts as `data:` URLs, no fetch, no external file, no cookie, no storage. Write it self-contained.

With `bridge: 'rooks'`, the page gets `window.rooks`:

```js
await rooks.ready;                          // connected, theme applied, height followed
await rooks.submit({ slot: 'tuesday' });    // the answer: a JSON object, up to 16 KiB
await rooks.message('Book Tuesday 10:00');  // a message the user confirms before it is sent
await rooks.openLink('https://example.com');// https only, opened outside the app
await rooks.fullscreen(true);               // false to come back inline
```

The answer, a link or full screen are accepted only after a real click or key press in the document, and only once per document for the answer. A click on an `<a href>` goes through `openLink`: the frame itself never navigates. The page receives a `rooks:teardown` event on `window` just before the card removes it. Theme colours arrive as CSS variables (`--color-background-primary`, `--color-text-primary`, `--font-sans`…), the names of the MCP Apps specification.

`window.rooks` lives inside your page: it is a convenience, not a security boundary. Rooks checks every message the frame sends.

## Receive the answer

```js
ctx.events.on('ui_document_resolved', (ev) => {
  if (ev.status !== 'answered') return;            // 'answered' | 'dismissed'
  const answer = ev.document.reply;                // present on YOUR documents only
  // ev.origin: who caused it — the user who answered, the agent or plugin that closed it
});
ctx.events.on('ui_document_created', (ev) => { /* ev.document, ev.creator */ });
```

The answer of a document you created reaches you through this event and through `get`, never the mission's agent. Answers given to an agent's document or to another plugin's never reach you: on those, the `reply` key is absent (`PluginUiDocument`), while your own documents are `PluginOwnUiDocument`, with `reply` (`null` until answered).

**An answer is not an approval.** It comes from a page and its buttons. Do not treat it as the user's consent to push, publish, send or delete on their behalf.

## Replace the card

The card is the `chat.document` slot (`single`); Rooks's own card is its default occupant. Declare the slot in `client.slots` and register a component: it replaces the card in every conversation, whether a document is on screen or not.

```js
import { useUiDocument, UiDocumentFrame } from '@rooks/ui';

function MyCard() {
  const { document, missionId, src, bridge } = useUiDocument();
  return (
    <section aria-label={document.title}>
      <h3>{document.title}</h3>
      <UiDocumentFrame />
    </section>
  );
}
```

`UiDocumentFrame` (no props) keeps everything that protects the user: the sandboxed frame, the bridge, the height that never moves the reader, the focus guard and the approvals. Render it inside your own layout to change how the card looks without rewriting any of that. Show `document.title` as text, and load nothing but `src` (`uiDocumentUrl(id)`).

## See also

- [Permissions](permissions.md)
- [Slots](slots.md)
- [UI kit](ui-kit.md)
- [Live updates](realtime.md)
