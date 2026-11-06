# plugin-confirm-dialog

Replaces Timon's confirmation dialog (slot `confirm.dialog`) — every « Are you
sure? » of the app: stopping a mission, deleting a task, a secret, an agent —
with a two-step version: a destructive question needs a second click on its
button, the first one arms it. The product's dialog comes back as soon as the
plugin is removed.

The component takes no props: it reads `useConfirmDialog()` from `@timon/ui`
(client API 15) — `title`, `description` (`null` when none), `confirmLabel`
and `cancelLabel` (translated, defaults filled in), `destructive`, and the two
answers `confirm()` / `cancel()`. The host keeps the frame (an `alertdialog`
named with the question, the focus held inside and given back on close,
Escape and a click outside answering no) and settles the caller.

A plugin that needs a confirmation of its own asks with `confirmAction()` from
`@timon/ui` — never the browser's `confirm()`. What a replacement must respect
is in [Slots](../../public-docs/docs/plugins/slots.md),
under `confirm.dialog`.

The package deliberately ships no `SIGNATURE` file.
