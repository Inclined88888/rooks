import React from 'react'

/**
 * One identity, two insertions: a rail card (`*.widget`) and an in-app
 * overlay. Not an OS window. Overlay is an exact slot, outside WidgetHost.
 */
function Body() {
  return React.createElement('strong', null, 'Example overlay')
}

/** @param {import('@timon-ai/sdk').ClientContext} ctx */
export function apply(ctx) {
  const disposeWidget = ctx.slots.register(
    { slot: 'cockpit.widget' },
    function OverlayCard() {
      return React.createElement(
        'section',
        { style: { margin: 12, padding: 16, border: '1px solid currentColor', borderRadius: 12 } },
        React.createElement(Body),
      )
    },
  )

  const disposeOverlay = ctx.slots.register(
    { slot: 'overlay' },
    function OverlayMascot() {
      return React.createElement(
        'div',
        {
          style: {
            position: 'fixed',
            right: 16,
            bottom: 16,
            zIndex: 40,
            padding: 12,
            borderRadius: 16,
            border: '1px solid currentColor',
          },
        },
        React.createElement(Body),
      )
    },
  )

  return () => {
    disposeOverlay()
    disposeWidget()
  }
}
