import React from 'react'
import { Button, DialogFooter, createTranslator, useConfirmDialog } from '@timon/ui'

// A plugin ships its own strings: the product's keys are not part of the contract.
const t = createTranslator({
  en: { again: 'Click again: {label}', warning: 'This cannot be undone.' },
  fr: { again: 'Cliquer encore : {label}', warning: 'Cette action est définitive.' },
})

/**
 * A replacement of the confirmation dialog: a destructive question needs two
 * clicks on its button, the first one arms it.
 *
 * `confirm.dialog` is a `single` slot declared at boot, whose default occupant
 * is the product's dialog (`fallback`). Registering here claims every
 * confirmation of the app at once — stopping a mission, deleting a task, a
 * secret, an agent; removing the plugin gives the product's dialog back.
 *
 * The component receives no props: it reads the open question with
 * `useConfirmDialog()`. The host frames it (an `alertdialog` it names itself
 * with the question, focus, Escape and a click outside answering no) and
 * settles the caller. What a replacement must respect:
 *   - no `DialogTitle`: the host already names the dialog, a visible title is
 *     `aria-hidden`;
 *   - focus the safe button: Enter right after the click that asked must not
 *     destroy anything;
 *   - call `confirm()` or `cancel()`: the caller waits for one of them.
 */
function TwoStepConfirm() {
  const question = useConfirmDialog()
  const [armed, setArmed] = React.useState(false)
  if (!question) return null

  const yes = () => {
    if (question.destructive && !armed) setArmed(true)
    else question.confirm()
  }

  return React.createElement(React.Fragment, null,
    React.createElement('div', { 'aria-hidden': true, className: 'flex flex-col gap-1.5' },
      React.createElement('p', { className: 'm-0 text-base font-semibold', 'data-two-step-title': '' }, question.title),
      question.description && React.createElement('p', { className: 'm-0 text-sm text-muted-foreground' }, question.description),
      question.destructive && React.createElement('p', { className: 'm-0 text-sm text-destructive' }, t('warning'))),
    React.createElement(DialogFooter, { className: 'gap-2' },
      React.createElement(Button, { type: 'button', variant: 'outline', autoFocus: true, onClick: question.cancel, 'data-two-step-cancel': '' }, question.cancelLabel),
      React.createElement(Button, {
        type: 'button',
        variant: question.destructive ? 'destructive' : 'default',
        onClick: yes,
        'data-two-step-confirm': armed ? 'armed' : '',
      }, armed ? t('again', { label: question.confirmLabel }) : question.confirmLabel)))
}

export function apply(ctx) {
  return ctx.slots.register({ slot: 'confirm.dialog' }, TwoStepConfirm)
}
