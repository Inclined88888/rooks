# plugin-task-form

Replaces the task form (slot `task.form`) — opened from the Kanban board, the
Agents page and the agents grid — with a one-screen quick form: a title, a
description, the agent and the priority. The product's form comes back as
soon as the plugin is removed.

The component takes no props: it reads `useTaskForm()` from `@timon/ui`. The
host keeps the modal frame (the focus held inside it and given back on close,
Escape) and the daemon's calls: `submit(body)` creates or updates the task and
hands back its id, `attachments.upload(id, file)` attaches a file, `finish()`
re-reads the screen and closes, `close()` closes without saving. The fields a
quick form leaves out keep the task's stored values: they are sent back as the
host gave them. What a replacement must respect is in
[Slots](../../public-docs/docs/plugins/slots.md), under `task.form`.

The package deliberately ships no `SIGNATURE` file.
