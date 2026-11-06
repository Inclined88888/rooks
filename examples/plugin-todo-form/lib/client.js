import React from 'react'
import { Button, DetailShell, Input, createTranslator, useTodoForm } from '@timon/ui'

// A plugin ships its own strings: the product's keys are not part of the contract.
const t = createTranslator({
  en: {
    create: 'New idea', edit: 'Idea #{id}', title: 'Title', description: 'Description', about: 'About the idea', project: 'Project',
    type: 'Type', untyped: 'Untyped', progress: 'Progress', save: 'Save', cancel: 'Cancel', handoff: 'Hand off to the orchestrator',
    handedOff: 'Handed off to {agent}', failed: 'Not saved: {error}',
  },
  fr: {
    create: 'Nouvelle idée', edit: 'Idée n° {id}', title: 'Titre', description: 'Description', about: 'À propos de l’idée', project: 'Projet',
    type: 'Type', untyped: 'Sans type', progress: 'Avancement', save: 'Enregistrer', cancel: 'Annuler', handoff: 'Passer à l’orchestrateur',
    handedOff: 'Passée à {agent}', failed: 'Non enregistrée : {error}',
  },
})

const URGENCIES = ['critical', 'bug', 'minor', 'idea']
const PROGRESSES = ['todo', 'analyzed', 'partial', 'to_test', 'done']

const field = (label, control) => React.createElement('label', { className: 'flex flex-col gap-1 text-[12px] text-muted-foreground' }, label, control)
const select = (label, value, options, onChange) => React.createElement('select', {
  'aria-label': label, value, onChange: (e) => onChange(e.target.value),
  className: 'h-8 rounded-md bg-muted/50 px-2 text-[13px] text-foreground',
}, options.map(([v, text]) => React.createElement('option', { key: v, value: v }, text)))

/**
 * A replacement of the TO DO idea form, laid out on the product's `DetailShell`.
 *
 * `todo.form` is a `single` slot declared at boot, the twin of `task.form`,
 * whose default occupant is the product's form (`fallback`). The component
 * receives no props: it reads its host with `useTodoForm()`. The host frames
 * it (modal, focus, Escape) and owns the daemon's calls. What a replacement
 * must respect:
 *   - put `titleId` on its heading: it names the dialog;
 *   - never draw its own modal: it is already inside the host's frame;
 *   - `submit()` does not close: call `finish()` once saved, `close()` to leave.
 */
function PlainTodoForm() {
  const host = useTodoForm()
  const item = host?.item ?? null
  const [text, setText] = React.useState(item?.text ?? '')
  const [notes, setNotes] = React.useState(item?.notes ?? '')
  const [project, setProject] = React.useState(item?.project ?? host?.defaultProject ?? '')
  const [urgency, setUrgency] = React.useState(item?.urgency ?? '')
  const [progress, setProgress] = React.useState(item?.progress ?? 'todo')
  const [message, setMessage] = React.useState(null)
  if (!host) return null

  const save = async (event) => {
    event.preventDefault()
    if (!text.trim()) return
    const result = await host.submit({
      text: text.trim(), project: project.trim() || null, notes: notes || null, urgency: urgency || null, progress,
    })
    if (result.ok) host.finish()
    else setMessage(t('failed', { error: result.error }))
  }
  const handoff = async () => {
    const result = await host.handoff?.()
    if (result) setMessage(result.ok ? t('handedOff', { agent: result.agent }) : result.error)
  }

  return React.createElement('form', { onSubmit: save, className: 'flex min-h-0 flex-1 flex-col' },
    React.createElement(DetailShell, {
      header: React.createElement(React.Fragment, null,
        React.createElement('h2', { id: host.titleId, className: 'text-[13px] text-muted-foreground tabular-nums' }, item ? t('edit', { id: item.id }) : t('create')),
        React.createElement(Input, { 'aria-label': t('title'), placeholder: t('title'), value: text, autoFocus: true, onChange: (e) => setText(e.target.value) })),
      rail: React.createElement(React.Fragment, null,
        field(t('project'), React.createElement(Input, { value: project, onChange: (e) => setProject(e.target.value) })),
        field(t('type'), select(t('type'), urgency, [['', t('untyped')], ...URGENCIES.map((u) => [u, u])], setUrgency)),
        field(t('progress'), select(t('progress'), progress, PROGRESSES.map((p) => [p, p]), setProgress))),
      railLabel: t('about'),
      footer: React.createElement(React.Fragment, null,
        React.createElement('div', { className: 'flex items-center gap-2' },
          host.handoff && React.createElement(Button, { type: 'button', variant: 'secondary', size: 'sm', onClick: handoff, 'data-plain-handoff': '' }, t('handoff')),
          message && React.createElement('span', { role: 'status', className: 'text-[12px] text-muted-foreground' }, message)),
        React.createElement('div', { className: 'flex items-center gap-2' },
          React.createElement(Button, { type: 'button', variant: 'ghost', size: 'sm', onClick: host.close }, t('cancel')),
          React.createElement(Button, { type: 'submit', size: 'sm', 'data-plain-save': '' }, t('save')))),
    },
    React.createElement('textarea', {
      'aria-label': t('description'), placeholder: t('description'), value: notes, rows: 12,
      onChange: (e) => setNotes(e.target.value),
      className: 'min-h-[12rem] flex-1 rounded-md bg-muted/40 px-3 py-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring',
    })))
}

/** @param {import('@timon-ai/sdk').ClientContext} ctx */
export function apply(ctx) {
  return ctx.slots.register({ slot: 'todo.form' }, PlainTodoForm)
}
