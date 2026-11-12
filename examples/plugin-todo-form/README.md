# plugin-todo-form

Replaces the form of a TO DO idea (slot `todo.form`, the twin of
`task.form`) — opened from the Kanban's TO DO column and the TO DO widgets —
with a plain form laid out on the product's `DetailShell`: the title, the
description, the project, the type and the progress. The product's form comes
back as soon as the plugin is removed.

The component takes no props: it reads `useTodoForm()` from `@rooks/ui`
(client API 15). The host keeps the modal frame (`DetailFrame`: the focus held
inside it and given back on close, Escape) and the daemon's calls:
`submit(body)` creates or updates the idea and hands back its id,
`handoff()` hands it to its project's orchestrator (`null` for a new idea or
one without a project), `refresh()` re-reads the screen, `finish()` re-reads
and closes, `close()` closes without saving, and `attachments` lists, uploads
and removes the idea's files (this template leaves them to the product). What a replacement must respect
is in [Slots](../../public-docs/docs/plugins/slots.md),
under `todo.form`.

The package deliberately ships no `SIGNATURE` file.
