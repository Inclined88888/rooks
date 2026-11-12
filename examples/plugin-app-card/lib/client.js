import React from 'react'
import { Button, Input, createTranslator, useAppCard } from '@rooks/ui'

// A plugin ships its own strings: the product's keys are not part of the contract.
const t = createTranslator({
  en: { connect: 'Connect', finish: 'Finish sign-in', connected: 'Connected', blocked: 'Name taken', disconnect: 'Disconnect', reopen: 'Open the sign-in page', save: 'Save the key' },
  fr: { connect: 'Connecter', finish: 'Terminer la connexion', connected: 'Connectée', blocked: 'Nom déjà pris', disconnect: 'Déconnecter', reopen: 'Ouvrir la page de connexion', save: 'Enregistrer la clé' },
})

/**
 * A replacement of the official connectors' card: one compact row per connector.
 *
 * `apps.card` is a `single` slot declared at boot, whose default occupant is
 * the product's card (`fallback`). Registering here claims every card of the
 * page at once; removing the plugin gives the product's cards back.
 *
 * The component receives no props: it reads its app with `useAppCard()`. The
 * host owns the gestures — it creates the MCP server, opens the publisher's
 * consent page, keeps a key in the vault and refreshes the state. What a
 * replacement must respect:
 *   - call `connect()` / `disconnect()`, never the daemon: the host knows the
 *     reviewed endpoint, the card does not choose one;
 *   - an app of type `key` needs its key: `connect(key)`, from a masked field;
 *   - `blocked` means a server of the same id was added by hand: offer nothing.
 */
function CompactAppCard() {
  const card = useAppCard()
  const [key, setKey] = React.useState('')
  if (!card) return null
  const { app, status } = card
  const busy = status === 'connecting'
  const needsKey = app.auth.type === 'key' && status !== 'connected' && status !== 'blocked'

  let action = null
  if (status === 'connected') {
    action = React.createElement(Button, { size: 'sm', variant: 'ghost', onClick: () => card.disconnect(), 'data-app-card-action': 'disconnect' }, t('disconnect'))
  } else if (status === 'blocked') {
    action = React.createElement('span', { className: 'text-xs text-muted-foreground' }, t('blocked'))
  } else if (!needsKey) {
    action = React.createElement(Button, { size: 'sm', disabled: busy, onClick: () => card.connect(), 'data-app-card-action': 'connect' }, status === 'consent' ? t('finish') : t('connect'))
  }

  return React.createElement('div', { className: 'flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-2', 'data-app-card': app.slug },
    React.createElement('div', { className: 'flex items-center gap-2.5' },
      React.createElement('span', {
        'aria-hidden': true,
        className: 'inline-flex size-7 items-center justify-center rounded-md text-xs font-semibold text-white',
        style: { backgroundColor: app.icon.color },
      }, app.icon.logo
        // The publisher's mark is path data: draw it, never inject markup.
        ? React.createElement('svg', { viewBox: app.icon.logo.viewBox, className: 'size-4' },
          ...app.icon.logo.paths.map((p, i) => React.createElement('path', { key: i, d: p.d, fill: p.fill || 'currentColor' })))
        : app.icon.monogram),
      React.createElement('div', { className: 'min-w-0 flex-1' },
        React.createElement('div', { className: 'truncate text-sm font-medium' }, app.name),
        React.createElement('div', { className: 'truncate text-xs text-muted-foreground' }, status === 'connected' ? t('connected') : app.tagline)),
      action),
    needsKey && React.createElement('form', {
      className: 'flex items-center gap-2',
      onSubmit: async (e) => { e.preventDefault(); if (key.trim() && await card.connect(key.trim())) setKey('') },
    },
      React.createElement(Input, { type: 'password', autoComplete: 'off', placeholder: app.auth.type === 'key' ? app.auth.label : '', value: key, onChange: (e) => setKey(e.target.value), disabled: busy || card.vaultOff, className: 'h-8' }),
      React.createElement(Button, { size: 'sm', type: 'submit', disabled: busy || card.vaultOff || !key.trim() }, t('save'))),
    status === 'consent' && card.consentUrl && React.createElement('a', { href: card.consentUrl, target: '_blank', rel: 'noopener noreferrer', className: 'text-xs underline' }, t('reopen')))
}

export function apply(ctx) {
  return ctx.slots.register({ slot: 'apps.card' }, CompactAppCard)
}
