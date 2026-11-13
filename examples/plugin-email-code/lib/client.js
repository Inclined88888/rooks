import React from 'react'
import { createTranslator, useEmailCode } from '@rooks/ui'

// A plugin ships its own strings: the product's keys are not part of the contract.
const t = createTranslator({
  en: { title: 'Enter the code', to: 'Sent to {email}', label: 'Code', change: 'Change email', resend: 'Resend', wait: 'Resend in {s} s', checking: 'Checking…', ok: 'Confirmed', sent: 'New code sent' },
  fr: { title: 'Saisissez le code', to: 'Envoyé à {email}', label: 'Code', change: 'Changer d’e-mail', resend: 'Renvoyer', wait: 'Renvoyer dans {s} s', checking: 'Vérification…', ok: 'Confirmé', sent: 'Nouveau code envoyé' },
})

/**
 * A replacement of the code screen: one field, the status under it, two links.
 *
 * `email.code` is a `single` slot declared at boot, whose default occupant is
 * the product's six boxes. Registering here claims every code screen;
 * removing the plugin gives the product's back.
 *
 * The component receives no props: it reads `useEmailCode()`. What a
 * replacement must respect:
 *   - pass everything typed or pasted to `input`: the host keeps the digits
 *     and checks the code once complete — never call the daemon yourself;
 *   - show `message` as it is: the host translates the refusal and counts its
 *     wait down;
 *   - leave `resend` closed while `resendIn` is above zero.
 */
function SingleFieldCode() {
  const code = useEmailCode()
  if (!code) return null
  const busy = code.state === 'checking' || code.state === 'ok'
  const status = code.state === 'checking' ? t('checking')
    : code.state === 'ok' ? t('ok')
      : code.state === 'sent' ? t('sent')
        : code.message
  return React.createElement('div', { 'data-example-email-code': '', className: 'flex w-full max-w-sm flex-col items-center gap-3 text-center' },
    React.createElement('h1', { className: 'text-2xl font-bold' }, t('title')),
    React.createElement('p', { className: 'text-sm text-muted-foreground' }, t('to', { email: code.email })),
    React.createElement('input', {
      autoFocus: true,
      value: code.digits,
      onChange: (e) => code.input(e.target.value),
      inputMode: 'numeric',
      autoComplete: 'one-time-code',
      'aria-label': t('label'),
      disabled: busy,
      maxLength: code.length + 4,
      className: 'h-12 w-48 rounded-lg bg-muted/40 text-center text-2xl tracking-[0.4em] tabular-nums ring-1 ring-inset ring-border',
    }),
    React.createElement('p', { role: 'status', className: 'min-h-5 text-xs text-muted-foreground' }, status),
    React.createElement('div', { className: 'flex gap-5 text-sm text-muted-foreground' },
      React.createElement('button', { type: 'button', onClick: code.changeEmail }, t('change')),
      React.createElement('button', {
        type: 'button',
        'data-example-resend': '',
        disabled: code.resendIn > 0 || code.resending || busy,
        onClick: code.resend,
      }, code.resendIn > 0 ? t('wait', { s: code.resendIn }) : t('resend'))))
}

export function apply(ctx) {
  return ctx.slots.register({ slot: 'email.code' }, SingleFieldCode)
}
