---
title: Composer
sidebar_position: 10
---

The default chat input occupies `chat.composer`, a single slot. A replacement declares `kind: "composer"` and includes that exact slot, then registers its component there.

A replacement hides the product fallback. Disposing the registration restores the default input. A second replacement is refused: this is an exclusive surface.

:::note Page-scoped lifetime
The chat page declares this slot, so it exists only while chat is mounted. Do not assume a boot-time registration can target it before the page exists. Multichat shares the registration and renders a composer per cell.
:::

If you only need a button beside the existing input, declare `chat.composer.action`, a list slot, instead. A full replacement decides whether to render those satellite actions itself.

There is no standalone composer template among the supplied examples. The SDK's generic slot API does not document a message-send prop contract for a replacement input. Verify the runtime's chat integration before attempting a full replacement; do not invent send callbacks or props from the slot name alone.

## Replies

**Reply** under a message arms a reply that the default input shows above the text field. A replacement reads it with `useComposerReply()` from `@rooks/ui` (`apiVersion: 15`): show `reply.excerpt` while `reply` is set, offer to cancel with `setReply(null)`, and send `reply_to: { event_id: reply.eventId }` with the message, then clear it. See `chat.message.action` in [Slots](slots.md).

## Prompt history

The default input recalls the prompts already sent to the agent with ↑ / ↓. A replacement keeps the same history with `usePromptHistory(agentId)`, `canRecallPrompt` and `isTextareaWrapped` from `@rooks/ui` (requires `"apiVersion": 12`). The slot passes no props: your component has to find the agent id itself, the hook does not.

```tsx
import { canRecallPrompt, isTextareaWrapped, usePromptHistory } from '@rooks/ui'

const history = usePromptHistory(agentId)

// before sending
history.record(text)

// on ArrowUp / ArrowDown, without a modifier and with no menu of your own open
const direction = event.key === 'ArrowUp' ? 'older' : 'newer'
const ta = event.currentTarget
if (canRecallPrompt(direction, ta.value, ta.selectionStart, ta.selectionEnd, isTextareaWrapped(ta))) {
  const recalled = history.step(direction, ta.value)
  if (recalled !== null) {
    event.preventDefault()
    setText(recalled)
  }
}

// when the user edits the field
history.reset()
```

On a text shown on several lines — line breaks, or a long paragraph the field wraps — the arrows only recall from its start (↑) or its end (↓). `step` returns `null` when there is nowhere to go: leave the key to the browser. Going down past the newest entry gives back the draft that was in the field. The history stays in the browser (50 prompts per agent); nothing is sent to Rooks's service.
