import React from 'react'
import { BoardCard, Button, createTranslator, useKanbanCard } from '@timon/ui'

// A plugin ships its own strings: the product's keys are not part of the contract.
const t = createTranslator({
  en: { markDone: 'Mark as done', reopen: 'Open again', remove: 'Delete', stop: 'Stop', waiting: 'Waiting', running: 'Running', done: 'Done', blocked: 'Blocked' },
  fr: { markDone: 'Marquer comme faite', reopen: 'Rouvrir', remove: 'Supprimer', stop: 'Arrêter', waiting: 'En attente', running: 'En cours', done: 'Terminée', blocked: 'Bloquée' },
})

const STATUS = { PENDING: 'waiting', IN_PROGRESS: 'running', DONE: 'done', BLOCKED: 'blocked' }

const badge = (text) => React.createElement('span', { className: 'rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground' }, text)

/** A TO DO idea: its id in the corner, its type as a badge, the checkbox where the host offers one. */
function IdeaCard({ card }) {
  const { item, show } = card
  const done = item.status === 'done'
  const leading = card.toggleDone && React.createElement('input', {
    type: 'checkbox', checked: done, onChange: card.toggleDone,
    'aria-label': done ? t('reopen') : t('markDone'), className: 'size-3.5 accent-primary',
  })
  return React.createElement(BoardCard, {
    density: card.density,
    as: card.density === 'row' ? 'li' : 'article',
    'data-plain-card': 'todo',
    corner: show.id ? `#${item.id}` : null,
    leading,
    title: item.text,
    muted: done,
    badges: item.urgency ? badge(item.urgency) : null,
    meta: [show.project && item.project, show.author && item.author].filter(Boolean).join(' · ') || null,
    actions: card.remove && React.createElement(Button, { size: 'sm', variant: 'ghost', onClick: card.remove, 'aria-label': t('remove') }, '×'),
    onOpen: card.open,
  })
}

/** A task of the board: its agent, its priority, its state, and Stop while it runs. */
function TaskCard({ card }) {
  const { task } = card
  const running = task.status === 'IN_PROGRESS'
  return React.createElement(BoardCard, {
    ...card.drag,
    density: card.density,
    'data-plain-card': 'task',
    identity: React.createElement('span', { className: 'truncate text-[13px] font-semibold', style: { color: card.agent.accent } }, task.agent_name),
    corner: `P${task.priority}`,
    title: task.title,
    badges: badge(t(STATUS[task.status] ?? 'waiting')),
    context: task.blocked_reason && React.createElement('div', { className: 'rounded-md bg-destructive/10 px-2 py-1 text-[11.5px] text-destructive' }, task.blocked_reason),
    actions: running && task.mission_id && React.createElement(Button, { size: 'sm', variant: 'ghost', onClick: card.stop }, t('stop')),
    tone: running ? 'running' : task.status === 'BLOCKED' ? 'blocked' : 'default',
    dragging: card.dragging,
    onOpen: card.open,
  })
}

/**
 * A replacement of every Kanban tile, ideas and tasks alike.
 *
 * `kanban.card` is a `single` slot declared at boot, whose default occupant is
 * the product's tiles (`fallback`). Registering here claims every tile of the
 * board and of the TO DO widgets at once; removing the plugin gives the
 * product's tiles back.
 *
 * The component receives no props: it reads its item with `useKanbanCard()`,
 * a union on `kind`. What a replacement must respect:
 *   - call the gestures it is handed (`open`, `toggleDone`, `stop`…), never
 *     the daemon: the host knows the routes and asks before stopping;
 *   - a gesture set to `null` is one the host does not offer there: hide it;
 *   - spread `drag` on a task card's root, or the board cannot move it.
 */
function PlainKanbanCard() {
  const card = useKanbanCard()
  if (!card) return null
  return card.kind === 'todo'
    ? React.createElement(IdeaCard, { card })
    : React.createElement(TaskCard, { card })
}

/** @param {import('@timon-ai/sdk').ClientContext} ctx */
export function apply(ctx) {
  return ctx.slots.register({ slot: 'kanban.card' }, PlainKanbanCard)
}
