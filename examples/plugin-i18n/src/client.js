import React from 'react'
import { createTranslator, getLocale } from '@rooks/ui'
// One file per language, in the package. The build inlines them in
// `lib/client.js`: the daemon serves that single file, nothing beside it.
import en from '../locales/en.json' with { type: 'json' }
import fr from '../locales/fr.json' with { type: 'json' }
import de from '../locales/de.json' with { type: 'json' }
import pl from '../locales/pl.json' with { type: 'json' }

// The reader's language, negotiated among these four (`de-AT` reads `de`),
// key by key, then `en`, then the key: `de` has no `widget.language`, so a
// German reader sees that line in English.
const t = createTranslator({ en, fr, de, pl })

/** @param {import('@rooks/sdk').ClientContext} ctx */
export function apply(ctx) {
  function I18nWidget() {
    const [count, setCount] = React.useState(0)
    return React.createElement(
      'section',
      { style: { margin: 12, padding: 16, display: 'grid', gap: 8 } },
      React.createElement('strong', null, t('widget.greeting', { name: ctx.id })),
      // One message, every plural form of the language: `{count, plural, …}`.
      React.createElement('p', null, t('widget.notes', { count })),
      React.createElement('button', { type: 'button', onClick: () => setCount((n) => n + 1) }, t('widget.add')),
      React.createElement('small', null, t('widget.language', { tag: getLocale() })),
    )
  }

  return ctx.slots.register(
    { slot: 'cockpit.widget', widget: { title: t('widget.title') } },
    I18nWidget,
  )
}
