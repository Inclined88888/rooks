---
title: Point at a page and tell the agent what to change
sidebar_position: 3.3
---

Instead of describing an element in words ("the second button in the blue card, under the title…"), point at it. In the [built-in browser](missions.md#the-built-in-browser), press **✎**, click an element, type what should change, and send it to the agent of the conversation. The agent receives your comment, where the element is, and a picture of it; when the page is your own app running on this computer, it also gets the element's text, markup and, when it can be found, the source file that renders it.

Annotations work wherever the built-in browser runs: in the desktop app on Windows, macOS and Linux, and from a web browser or the installed web app on your phone while the desktop app is running. They are provided by the **Browser annotations** plugin, on by default (**Settings → Plugins**); the Lite preset leaves it off.

## Annotate in four gestures

Open the built-in browser from the chat of the agent that should do the work. Then:

1. **Press ✎** (**Annotate**) in the address bar. An **Annotating** pill appears, and the element under the pointer is outlined.
2. **Click an element.** The click does **not** reach the page: nothing opens, nothing is submitted, no link is followed. A bubble opens right on the element, ready for you to type:

   ```text
   ┌────────────────────────────────────────────┐
   │ What should change here?                   │
   │ Make this button green and say "Pay now"▌  │
   │                                            │
   │ Enter to add · Shift+Enter for a new line  │
   │ · Esc to cancel          [Add]  [Send (1)] │
   └────────────────────────────────────────────┘
   ```

3. **Press Enter.** The annotation joins the list and leaves a numbered pin on the element (**1**, then **2**…). Click other elements and do the same, as many as you need.
4. **Press Send (N)** in the bubble. Everything you annotated goes to the agent in **one** message, including what you were typing, and annotate mode ends.

That's it: no form to save, no message box to fill. You can also leave annotate mode with **Done** (or **Escape** on the page) and send later: the address bar then shows what is waiting, and **Send** posts it.

```text
 ← → ⟳  localhost:3000/checkout         ✎   3 annotations · Send
```

### In the bubble

- **Enter** adds the annotation, **Shift+Enter** starts a new line, **Escape** cancels the one you are typing (a second **Escape**, on the page, leaves annotate mode). On a phone, tap **✕** to cancel.
- **Clicking another element** while the bubble is open keeps what you typed in the list; an empty bubble is simply dropped.
- **Click a pin** to reopen its annotation: change the text and press **Save**, or **Delete** it (the other pins are renumbered).
- Pins follow their element as you scroll or resize the window, and hide while it is out of view. In a web browser or on a phone they catch up a fraction of a second after the page moves.

Your comment is typed in Timon's bubble, never in the page: the website does not see what you type, nor that you are typing.

Only the owner of the browser profile can annotate, read and send annotations. Someone watching the same browser from another device sees the **Annotating** pill, but nothing else. If another of your devices holds the browser, click the page first to take it over.

## Where it arrives

The annotations go to the conversation shown in the agent's chat:

- if the chat shows a conversation, they are added to it, as your next message;
- if the chat is on **New conversation**, a new conversation starts with them, and the chat opens it on its own.

In the conversation, your message is a card, one numbered line per annotation, like the pins:

```text
┌ Browser annotations (2) ──────────────────────────────────┐
│ 1  [picture]  Make this button green and say "Pay now"     │
│               Checkout · Sent, waiting for the agent       │
│ 2  [picture]  The total is cut off on small screens        │
│               Checkout · ✓ Resolved: added a line break    │
│                                                 Details ▾  │
└────────────────────────────────────────────────────────────┘
```

Each line shows the picture of the element, your comment and the page. **Details** shows the page address, the selector that finds the element and, when it was found, the source file. Click a picture to enlarge it.

For a page of a public website, the card shows the site's address instead of the page title: the title is page text, and page text from public websites is never kept (see [What the agent receives](#what-the-agent-receives)).

The agent works through the annotations and marks each line **✓ Resolved** with what it changed, or **✕ Dismissed** with why not. The card updates on its own, no reload needed.

**Send** posts what you annotated since your last send. An annotation left unsent from an earlier time (a closed tab, a reload of the web app) is not part of it: it waits in the history, where you send it on its own.

**If the agent is still answering** when you send, Timon says so and keeps your annotations: send again once its turn ends.

## History

**Annotation history** (the speech-bubble button of the address bar, or **N annotations** when some are waiting to be sent) lists your annotations page by page, with their state:

- **Draft**: not sent yet.
- **Sent**: the agent has it.
- **Resolved**: the agent made the change; its summary is shown under the annotation.
- **Dismissed**: the agent did not make the change; its reason is shown.

Open an annotation to read it with its picture, the page, the element and, when it was found, the source. A draft has a **Send** button, which posts that annotation alone to the conversation. **Show on page** outlines the element again in the browser (it scrolls to it if needed); **Delete** removes the annotation and its pin.

## What the agent receives

- **Your comment**, which is the instruction.
- **Where the element is**: the page address (with sign-in codes and tokens masked), a selector to find the element again, and its position on the page.
- **A picture** of the element, for the first 10 annotations of a send; the others are marked as having one.
- **For a page served from this computer or your local network** (`localhost`, a `*.localhost` or `*.local` name, a local network address): the page title, the element's text and a trimmed copy of its markup. For any other website, these stay out: the agent gets your comment, the selector and the picture only.
- **The source file**, when the page is a development build that says which component rendered the element (React 18 and earlier do; React 19 gives an approximate location; Vue and Svelte development builds are read when they expose it). Timon keeps the file only if it exists inside the agent's project folder; otherwise the agent gets the component name, or nothing, and **Details** shows **not detected**.

Everything that comes from the page is given to the agent as **page data, not instructions**: the agent is told to act on your comment only, and never to follow something the page's text asks for. This lowers the risk that a website steers your agent; it does not remove it, since the agent keeps all its usual tools. Annotate pages you trust.

Never read on any page:

- what you typed in password, one-time code or card fields, and the values of form fields;
- the content of a field or an editor you click.

## Limits

- **Switching model or forking a conversation.** When a conversation switches to another model, the agent no longer has your annotations in mind, only what was said about them; it can read them again on its own. A conversation forked from it starts without them and cannot read them: annotate again from the new conversation.
- **Frames inside a page** (an embedded payment form, a video player, a captcha) and closed web components cannot be annotated: annotate the element around them and say what you mean in the comment.
- **The source file is a hint.** It is found only on development builds and not on every framework. When it is missing, the agent looks for the element in the project from its text, classes and component name.
- **Pictures** show the element and a little around it, as it was on screen. An element outside the visible part of the page gets no picture.
- **Open the browser from a conversation.** A browser opened outside a chat can annotate, but has nowhere to send: the bubble says so.
- **Limits**: 20 annotations waiting in the desktop app's bubble at a time (send them to add more), 50 per send, 200 kept per person. When the limit is reached, new clicks are not kept and Timon says so; delete old annotations to make room.
- **Retention.** An annotation that is not resolved or dismissed is deleted after 7 days; a resolved or dismissed one, 1 day after. Change this in **Settings → Access & network → Browser** (**Keep open browser annotations**, **Keep resolved browser annotations**; 0 keeps them until you delete them).
- **One user's annotations.** Annotations belong to the owner of the browser profile and are stored encrypted on this computer. Other accounts, administrators included, cannot see them, and an agent reads only the annotations you sent to it. Plugins can read them only with the **browser annotations** permissions, which you approve when you install the plugin (see [plugin permissions](../plugins/permissions.md)).
