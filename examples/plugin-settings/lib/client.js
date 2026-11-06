import React from 'react'
import { Slot } from '@timon/ui'

/**
 * Two insertions, one identity, no invented kind (`behavior`):
 * a graft into the native Missions group, and the plugin's own
 * settings category (`settings.section`, keyed by plugin id).
 * The pane may open a list slot so others can graft into it.
 * @param {import('@timon-ai/sdk').ClientContext} ctx
 */
export function apply(ctx) {
  function MissionsGraft() {
    // A settings row, not a widget card: no border, no handle. It lives
    // in the native pane flow after the product's own lines.
    return React.createElement(
      'div',
      { style: { padding: '16px 0' } },
      React.createElement(
        'span',
        { style: { fontSize: 13, fontWeight: 500, lineHeight: 1.375 } },
        `Example row grafted into Missions (${ctx.id})`,
      ),
    )
  }

  function OwnCategory() {
    return React.createElement(
      'section',
      { style: { padding: 16 } },
      React.createElement('h2', null, 'Example settings'),
      React.createElement('p', null, `plugin ${ctx.id}`),
      React.createElement(Slot, { name: 'settings.acme' }),
    )
  }

  const disposeGraft = ctx.slots.register({ slot: 'settings.missions' }, MissionsGraft)
  const disposeSection = ctx.slots.register(
    { slot: 'settings.section', children: { 'settings.acme': 'list' } },
    OwnCategory,
  )
  return () => {
    disposeSection()
    disposeGraft()
  }
}
