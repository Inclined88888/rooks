# plugin-kanban-card

Replaces the tiles of the Kanban (slot `kanban.card`) — the TO DO ideas and
the tasks of the board, and the idea lines of the TO DO widgets — with plain
cards laid out on the product's `BoardCard`. The product's tiles come back as
soon as the plugin is removed.

The component takes no props: it reads `useKanbanCard()` from `@rooks/ui`
(client API 15), a union on `kind`:

- `kind: 'todo'` — `item` (the idea), `show` (`id`, `author`, `project`: the
  widget's display options), `toggleDone`, `handoff` (hands the idea to its
  project's orchestrator; `null` without a project) and `remove` (`null` where
  the host offers no such gesture);
- `kind: 'task'` — `task`, `board` (every task by id, unfiltered), `now`,
  `agent`, `agentRole`, `todo` (the idea it carries out), `needsAction`,
  `dragging`, `modelTarget`, `drag` (spread it on the card's root), `stop`,
  `markMerged`, `openGraph`, `refresh`.

Both carry `density` (`card` on the board, `row` in a widget's list) and
`open()`, which opens the item's popup. The host keeps the data and the
gestures; a replacement never calls the daemon for them. What a replacement
must respect is in [Slots](../../public-docs/docs/plugins/slots.md), under `kanban.card`.

The package deliberately ships no `SIGNATURE` file.
