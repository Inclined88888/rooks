import React from 'react'

// Same drawing as `icon.svg`, the gallery picto declared in the manifest.
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 9h17"/><path d="M7.5 13h5M7.5 16h8"/></svg>'

/**
 * Target shape of a widget plugin: one card, registered in a `*.widget`
 * slot. The host owns drag, remove and resize; this file is only the body.
 * @param {import('@rooks/sdk').ClientContext} ctx
 */
export function apply(ctx) {
  function ExampleWidget() {
    return React.createElement(
      'section',
      { style: { margin: 12, padding: 16, border: '1px solid currentColor', borderRadius: 12 } },
      React.createElement('strong', null, 'Example widget'),
      React.createElement('p', null, `plugin ${ctx.id}`),
    )
  }

  // `icon`: the card's picto in the widget window (SVG markup or the URL of
  // an SVG), painted in the theme's text colour — only its shape counts.
  return ctx.slots.register(
    { slot: 'cockpit.widget', widget: { title: 'Example widget', icon: ICON } },
    ExampleWidget,
  )
}
