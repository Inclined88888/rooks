import React from 'react'
import { Button, createTranslator, openInIsland, startIslandDrag, useIslandContent } from '@timon/ui'

const t = createTranslator({
  en: {
    board: 'Board: {id}',
    description: 'This example board lives in its own workspace tab.',
    open: 'Open {id} to the right (or drag)',
    refused: 'The board could not open. Close a tab or try again in a workspace.',
    close: 'Close this tab',
  },
  fr: {
    board: 'Tableau : {id}',
    description: 'Ce tableau d’exemple occupe son propre onglet dans l’espace.',
    open: 'Ouvrir {id} à droite (ou glisser)',
    refused: 'Le tableau n’a pas pu s’ouvrir. Fermez un onglet ou réessayez dans un espace.',
    close: 'Fermer cet onglet',
  },
})

// Persist identifiers only; a real board reloads its data through ctx.api.
function parseParams(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return typeof raw.id === 'string' && /^[a-z0-9-]{1,40}$/.test(raw.id)
    ? { id: raw.id }
    : null
}

/** @param {import('@timon-ai/sdk').ClientContext} ctx */
export function apply(ctx) {
  function Board() {
    const { params, setTitle, close } = useIslandContent()
    const [error, setError] = React.useState(false)
    const title = t('board', { id: String(params.id) })
    React.useEffect(() => { setTitle(title) }, [setTitle, title])
    const nextId = params.id === 'demo' ? 'archive' : 'demo'
    const content = { type: `${ctx.id}:board`, params: { id: nextId } }
    return React.createElement('section', { style: { padding: 16, height: '100%', overflow: 'auto' } },
      React.createElement('h2', { style: { fontWeight: 600 } }, title),
      React.createElement('p', { style: { marginTop: 8 } }, t('description')),
      React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 } },
        React.createElement(Button, {
          type: 'button',
          draggable: true,
          onDragStart: (event) => startIslandDrag(event, content, { label: t('board', { id: nextId }) }),
          onClick: () => setError(!openInIsland(content, { edge: 'right' })),
        }, t('open', { id: nextId })),
        React.createElement(Button, { type: 'button', variant: 'ghost', onClick: close }, t('close'))),
      error ? React.createElement('p', { role: 'status', style: { marginTop: 8 } }, t('refused')) : null)
  }

  return ctx.slots.register({
    slot: 'island.content',
    key: 'board',
    island: {
      title: t('board', { id: 'demo' }),
      parseParams,
      params: { id: { type: 'string', required: true, maxLength: 40, description: 'Board slug (lowercase letters, digits, hyphens).' } },
      singletonBy: 'id',
      minWidth: 280,
      minHeight: 160,
    },
  }, Board)
}
