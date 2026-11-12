import React from 'react'
import { createTranslator, useUpdateStatus } from '@rooks/ui'

// A plugin ships its own strings: the product's keys are not part of the contract.
const t = createTranslator({
  en: { line: 'Rooks {version} is out', download: 'Download', page: 'Download page', later: 'Later' },
  fr: { line: 'Rooks {version} est sorti', download: 'Télécharger', page: 'Page de téléchargement', later: 'Plus tard' },
})

/**
 * A replacement of the "new version" banner: one compact line instead of the
 * product's strip with its notes.
 *
 * `updates.banner` is a `single` slot declared at boot, whose default occupant
 * is the product's banner (`fallback`). Registering here replaces it on every
 * page; removing the plugin gives the product's banner back.
 *
 * The component receives no props: it reads `useUpdateStatus()`. The host
 * only paints the slot while a newer version — verified by the daemon against
 * the signed release list — is offered and not put off, so `null` is the only
 * other case. What a replacement must respect:
 *   - the notes (`offer.notes`) are plain text: render them as text, never as HTML;
 *   - link to `installers[0]` (picked for this browser's system) or, when the
 *     list is empty (a phone, an unknown system), to `offer.notesUrl`;
 *   - offer `later()`: it hides this version only, the next one comes back;
 *   - while `buildExpiresAt` is set, the build-expiry notice is hidden in
 *     favour of this banner: say when the build stops.
 */
function CompactUpdateBanner() {
  const update = useUpdateStatus()
  if (!update) return null
  const target = update.installers[0]
  const ends = update.buildExpiresAt ? ` (${new Date(update.buildExpiresAt).toLocaleDateString()})` : ''
  return React.createElement('div', { role: 'status', className: 'flex shrink-0 items-center justify-center gap-3 bg-muted px-3 py-1 text-xs', 'data-compact-update': update.offer.version },
    React.createElement('span', { className: 'font-semibold' }, t('line', { version: update.offer.version }) + ends),
    React.createElement('a', {
      className: 'underline', href: target ? target.url : update.offer.notesUrl, target: '_blank', rel: 'noopener noreferrer',
      'data-compact-download': target ? target.key : '',
    }, target ? t('download') : t('page')),
    React.createElement('button', { type: 'button', className: 'underline', onClick: update.later, 'data-compact-later': '' }, t('later')))
}

export function apply(ctx) {
  return ctx.slots.register({ slot: 'updates.banner' }, CompactUpdateBanner)
}
