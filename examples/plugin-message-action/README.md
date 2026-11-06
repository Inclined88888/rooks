# plugin-message-action

Adds a button under each chat bubble (slot `chat.message.action`) that copies
the message's reference — its conversation and event id — next to Copy,
Copy as Markdown, Reply and Read aloud.

`chat.message.action` is a list slot the chat declares while it is on screen:
a plugin adds a button, it replaces none. The component takes no props: it
reads the bubble with `useChatMessage()` from `@timon/ui` (client API 15) —
`role` (`agent` or `user`), `eventId` (null when no stored event backs the
bubble), `missionId`, `markdown` and `html` — and draws its button with
`MessageActionButton`, so it looks like the product's, tooltip included.

`useComposerReply()` reads and sets the reply the composer is about to send:
`setReply({ eventId, role, excerpt })` arms it from an action, exactly as the
product's Reply button does.

Details in [Slots](../../public-docs/docs/plugins/slots.md), under `chat.message.action`.

The package deliberately ships no `SIGNATURE` file.
