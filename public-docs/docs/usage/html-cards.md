---
title: HTML cards in the chat
sidebar_position: 3.5
---

An agent can show you more than text: a table, a chart, a preview or a form appears as an **HTML card** in the mission's conversation. When the agent asks for it, the card waits for your answer and sends it back to the agent. The agent creates the card with its `ui_render` tool; you do not install or enable anything.

## What you see

The card shows the document's title, then the document itself. Its height follows the content; it never scrolls the conversation under you while you use it.

| Control | What it does |
| --- | --- |
| **Interact with the document** | Puts the keyboard focus in the document. `Tab` from this button does the same. |
| **Full screen** | Shows the document over the whole app, without reloading it (what you typed stays). **Exit full screen**, or `Esc` once the focus is outside the document, brings it back. |
| **Close without answering** | Shown while an answer is expected. The agent is told you closed it. |

A card that expects an answer is marked *answer expected*, and a notification leads you to it from anywhere in the app. Once you answered, the card shows **Your answer**: what was sent.

## Answering

A form in the card sends your answer when you click its button. Only a real click or key press counts: a document cannot answer on its own, and it cannot answer twice. The answer reaches the agent in its current turn, or as a message as soon as it is free.

If the agent has finished in the meantime, the card says *The agent has finished: the answer is kept, not transmitted.*

When a mission runs unattended (a Kanban task, a routine), the agent does not wait: the card stays for you to answer later, and your answer reaches the agent only if the mission is still running.

## What a document can ask

| The document… | What happens |
| --- | --- |
| wants to send a message in your name | A banner shows the exact text, with **Send** and **Cancel**. Nothing leaves until you click **Send**. The message is posted as yours, prefixed with the document's title, and waits its turn if the agent is still speaking. |
| opens a link | Only `https://` links, after a click in the document. On the desktop app the link opens in your system browser. |
| asks for full screen | Only after a click in the document. It never covers a card that waits for you (a permission, a question, a command): full screen gives way to it. |
| closes itself | The card shows *The document closed itself.* — **Show** loads it again. |

## Safety

A document runs isolated from Timon:

- it has no network access: it cannot load anything from the internet or reach Timon's own interface, your files or your session;
- it cannot read your cookies or what other cards show;
- if it navigates away from its page, the card removes it (*This document left its page*).

**An answer in a card is never an approval.** An agent writes the page and its buttons, so a button labelled "Approve the deployment" proves nothing. Pushing, publishing, sending or deleting still go through a permission card or a proposed terminal command, as before.

**Focus guard.** A document is not allowed to grab the keyboard while you type elsewhere. If it tries, the focus goes back where it was and Timon announces it. After three attempts the card is frozen — still shown, no longer usable — under *This document tried to take the focus*, until you click **Reactivate**. When you move from the message box straight to a document, one extra click (*Click to use the document*) arms it; on a touch screen, the first tap does.

## Who sees and answers

Everyone who can read the mission sees its cards and the answers sent. Only the account that owns the mission can answer or close a card.

Cards are kept as long as the mission's chat attachments: they are removed with them once the mission has been over for the retention period, and the card then reads *This document is no longer kept*.

## Card states

| Message on the card | Meaning |
| --- | --- |
| *answer expected* | The agent waits for your answer. |
| *answered* | You answered; **Your answer** shows what was sent. |
| *This document was closed.* | Closed without an answer, by you or by the agent. |
| *This document is no longer kept* | The mission ended a while ago and the card was removed. |
| *Documents are switched off on this Timon* | The documents module is disabled on this install. |

## For agents and prompt writers

An agent uses `ui_render` when text cannot render what it wants to show. The document is a single self-contained HTML page: inline `<style>` and `<script>`, pictures as `data:` URLs, no external file, no network.

| `ui_render` parameter | Meaning |
| --- | --- |
| `title` | One line shown above the document, up to 120 characters. |
| `html` or `path` | The whole document (up to 512 KiB), or the absolute path of an `.html` file inside the mission's working folder. Exactly one of the two. |
| `reply` | `true` to wait for the user's answer. |
| `height` | Initial height in pixels (80–2000), until the document reports its own. |

Inside the page, `window.timon` offers:

```js
await timon.ready;                         // the card is connected, the theme applied
await timon.submit({ slot: 'tuesday' });   // the answer: a JSON object, up to 16 KiB
await timon.message('Book Tuesday 10:00'); // proposes a message the user confirms
await timon.openLink('https://example.com');
await timon.fullscreen(true);              // false to come back inline
```

With `reply: true`, the tool waits a short while and returns the answer, or `status: "pending"`: the answer will then come back as a message, and the agent should not show the document again. `ui_document_get` reads a document's state (`shown`, `pending`, `answered`, `dismissed`). Inside a mission the same is available as `timon ui-doc render <file.html> [--title TEXT] [--reply]` and `timon ui-doc get <id>`.

A plain decision or a choice between a few options is better asked with the `question` tool, which needs no page at all. Plugins can show cards too: see [HTML documents from a plugin](../plugins/ui-documents.md).
