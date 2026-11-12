# Discord connector

Keeps the TO DO notebook and the Discord bot (`rooks-discord`) in step. Built
into Rooks, shipped **off**; written with the public SDK only, so it is also the
model for a GitHub Issues, Jira or Slack connector (`examples/plugin-todo-connector`).

| Direction | What happens |
|---|---|
| bot → Rooks | `ticket.created` / `suggestion.created` on the webhook `events` → an idea `<public_id> · <title>` tied to its thread by an **external reference** (`provider: discord`), then an investigation task. A ticket gets the **bug** badge, a suggestion **idea**. The images (png, jpg, gif, webp) and text files (logs, markdown, json, yaml, source and config files; never html or sh) of a ticket's `attachments`, Discord CDN only, 10 MB each, at most 5, checked by their magic bytes, are **attached to the idea** (`ctx.kanban.todos.attachments`, API 15): the notebook shows them, a promotion copies them into the task, and the investigation is told to read them with `project_todo_attachments_list`. A file that fails is counted, never blocking. `*.reply_added` (a detail added later in the thread) is appended to the idea's notes, fenced as untrusted, once per Discord message, with its files attached the same way; an analysed idea goes back to `todo`, a closed one is left alone, no new investigation starts. `*.status_changed` and anything else answer 2xx and do nothing. |
| Rooks → bot | `todo_resolved`, then `todo_done`, posted through `ctx.outbox` (durable, one FIFO lane per idea, Standard Webhooks signature). Bodies and signature are those of `rooks-discord/docs/rooks-webhook.md`. |

Public path: `POST /api/plugins/hooks/todo-connector-discord/events`.

## Settings

| Key | Default |
|---|---|
| `workerUrl` | empty: outcomes are not sent |
| `signingSecret` | name of the vault entry (`DISCORD_WORKER_SIGNING`), a `whsec_…` the Worker accepts in `ROOKS_INBOUND_SECRET`; scope the entry to this plugin |
| `referencePattern` | `^(TIM\|SUG)-\d{4,6}$` |
| `investigationAgent`, `project` | `rooks.researcher`, `rooks` |
| `investigationPrompt` | empty = the prompt of the former `Discord: new TIM/SUG` trigger |

The Worker's host must be in `pluginPolicy.http.allow`: it is a setting, so the manifest cannot name it. The manifest does declare `cdn.discordapp.com` and `media.discordapp.net`, for the ticket files: tick them on the install sheet, or allow them in `pluginPolicy.http` (without them, the files are counted as not fetched).

An investigation is a mission, so `todo-connector-discord` must also be in `pluginPolicy.spawn.approved` (it opens tasks through `kanban:write` and does not declare `missions:spawn`, so being built in does not approve it), and it shares that policy's quota (`max` per `windowMs`). Until it is approved, a ticket still becomes an idea, but its investigation is refused: an action card asks for the approval, the settings section names the ticket waiting (`awaitingApproval` in `/status`), and the delivery answers `502` so the bot's next retry starts the investigation once approved.

## Switching from the hand-made triggers

Enabling the plugin does not touch them: `discord-events` keeps receiving while
the new path is tried. Once the settings page shows events received, **Retire the
hand-made triggers** disables (never deletes) `discord-events`, `Discord: resolved
TIM/SUG` and `Discord: closed TIM/SUG`. Two sources active for a few minutes are
harmless towards the bot.

## Files saved by older versions

Before API 15 the files were saved under `<plugin data>/attachments/<public_id>/` and their paths written in the notes. The ideas belong to the account that opened the webhook, so the connector moves each such folder onto its ticket's idea in that account's scope: at start through `ctx.webhooks.asOwner('events', …)`, without waiting for the bot to call, and again before each delivery. A ticket is marked done once each of its files has moved or been refused for good; a file Rooks refuses (an old `.html` or `.sh`) stays in place, named in the log. A failure that may pass (full idea, disk) leaves the ticket for the next run. The paths in old notes are left as they were.
