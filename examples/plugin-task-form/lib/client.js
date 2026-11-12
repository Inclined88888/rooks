import React from 'react'
import { Button, Input, createTranslator, useTaskForm } from '@rooks/ui'

// A plugin ships its own strings: the product's keys are not part of the contract.
const t = createTranslator({
  en: { create: 'New quick task', edit: 'Edit quick task', title: 'Title', description: 'Description', agent: 'Agent', priority: 'Priority', save: 'Save', cancel: 'Cancel', failed: 'Not saved: {error}' },
  fr: { create: 'Nouvelle tâche rapide', edit: 'Modifier la tâche rapide', title: 'Titre', description: 'Description', agent: 'Agent', priority: 'Priorité', save: 'Enregistrer', cancel: 'Annuler', failed: 'Non enregistrée : {error}' },
})

/** A stored JSON list (`deps`, `extra_skills`…) back to an array. */
function list(raw) {
  try {
    const value = JSON.parse(raw || '[]')
    return Array.isArray(value) ? value.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * A replacement of the task form: one screen, four fields.
 *
 * `task.form` is a `single` slot declared at boot, whose default occupant is
 * the product's form (`fallback`). Registering here claims it on every screen
 * that opens it — the Kanban board, the Agents page, the agents grid; removing
 * the plugin gives the product's form back.
 *
 * The component receives no props: it reads its host with `useTaskForm()`.
 * The host frames it (modal, focus, Escape) and owns the daemon's calls. What
 * a replacement must respect:
 *   - put `titleId` on its heading: it names the dialog;
 *   - send back what it does not edit as the task holds it, so an edition
 *     never wipes a field the form does not show;
 *   - `submit()` does not close: call `finish()` once saved, `close()` to leave.
 */
function QuickTaskForm() {
  const host = useTaskForm()
  const task = host?.task ?? null
  const [title, setTitle] = React.useState(task?.title ?? '')
  const [description, setDescription] = React.useState(task?.description ?? '')
  const [agent, setAgent] = React.useState(task?.agent_name ?? host?.defaultAgent ?? host?.agents[0]?.name ?? '')
  const [priority, setPriority] = React.useState(task?.priority ?? 3)
  const [error, setError] = React.useState(null)
  if (!host) return null

  const save = async (event) => {
    event.preventDefault()
    if (!title.trim() || !agent) return
    const result = await host.submit({
      title: title.trim(),
      description,
      agent_name: agent,
      priority,
      type: task?.type ?? 'chore',
      deps: list(task?.deps),
      scheduled_at: task?.scheduled_at ?? null,
      backend_override: task?.backend_override ?? null,
      model_override: task?.model_override ?? null,
      fallback_backend_override: task?.fallback_backend_override ?? null,
      fallback_model_override: task?.fallback_model_override ?? null,
      permission_mode_override: task?.permission_mode_override ?? null,
      extra_skills: list(task?.extra_skills),
      extra_mcp_servers: list(task?.extra_mcp_servers),
      extra_allowed_tools: list(task?.extra_allowed_tools),
      todo_id: task?.todo_id ?? null,
    })
    if (result.ok) host.finish()
    else setError(t('failed', { error: result.error }))
  }

  return React.createElement('form', { onSubmit: save, className: 'flex flex-1 flex-col gap-4 p-6' },
    React.createElement('h2', { id: host.titleId, className: 'text-base font-semibold' }, host.mode === 'edit' ? t('edit') : t('create')),
    React.createElement(Input, { 'aria-label': t('title'), placeholder: t('title'), value: title, autoFocus: true, onChange: (e) => setTitle(e.target.value) }),
    React.createElement('textarea', {
      'aria-label': t('description'), placeholder: t('description'), value: description, rows: 8,
      onChange: (e) => setDescription(e.target.value),
      className: 'rounded-md bg-muted/50 px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
    }),
    React.createElement('div', { className: 'flex flex-wrap items-center gap-3' },
      React.createElement('select', {
        'aria-label': t('agent'), value: agent, onChange: (e) => setAgent(e.target.value),
        className: 'h-9 rounded-md bg-muted/50 px-2 text-sm',
      }, host.agents.map((a) => React.createElement('option', { key: a.name, value: a.name }, a.name))),
      React.createElement('select', {
        'aria-label': t('priority'), value: String(priority), onChange: (e) => setPriority(Number(e.target.value)),
        className: 'h-9 rounded-md bg-muted/50 px-2 text-sm tabular-nums',
      }, [5, 4, 3, 2, 1].map((p) => React.createElement('option', { key: p, value: String(p) }, `P${p}`)))),
    error && React.createElement('p', { role: 'alert', className: 'text-sm text-destructive' }, error),
    React.createElement('div', { className: 'mt-auto flex justify-end gap-2' },
      React.createElement(Button, { type: 'button', variant: 'ghost', size: 'sm', onClick: host.close }, t('cancel')),
      React.createElement(Button, { type: 'submit', size: 'sm', 'data-quick-save': '' }, t('save'))))
}

/** @param {import('@rooks/sdk').ClientContext} ctx */
export function apply(ctx) {
  ctx.slots.register({ slot: 'task.form' }, QuickTaskForm)
}
