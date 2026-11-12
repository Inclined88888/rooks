import React from 'react'
import { Slot } from '@rooks/ui'

/**
 * A page plugin: the key is the route. Next's catch-all paints this entry
 * when the browser goes to /example, and the zone declared here is open to
 * any widget.
 * @param {import('@rooks/sdk').ClientContext} ctx
 */
export function apply(ctx) {
  function ExamplePage() {
    return React.createElement(
      'main',
      { style: { padding: 24 } },
      React.createElement('h1', null, 'Example page'),
      React.createElement(Slot, { name: 'example.widget' }),
    )
  }

  return ctx.slots.register(
    { slot: 'page', key: '/example', children: { 'example.widget': 'list' } },
    ExamplePage,
  )
}
