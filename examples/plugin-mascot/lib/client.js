import React from 'react'
import { useAgentMascot } from '@timon/ui'

// The eyes of each state, as rows of a 5×3 pixel grid: `#` is lit.
const EYES = {
  closed: ['     ', '#####', '     '],
  open: [' # # ', ' # # ', '     '],
  happy: ['     ', '# # #', ' # # '],
  wide: ['## ##', '## ##', '     '],
  cross: ['# # #', ' # # ', '# # #'],
}
const STATE_EYES = {
  sleeping: 'closed', done: 'happy', happy: 'happy', celebrate: 'happy', love: 'happy',
  listening: 'wide', waiting: 'wide', surprised: 'wide', error: 'cross', sad: 'closed',
}

/**
 * A replacement of the agent's mascot: a flat square in the agent's colour,
 * with pixel eyes that follow its state.
 *
 * `agent.mascot` is a `single` slot declared at boot, whose default occupant
 * is the product's meerkat (`fallback`). Registering here claims the mascot
 * of every screen — onboarding, agent creation, chat; removing the plugin
 * gives the meerkat back.
 *
 * The component receives no props: it reads `useAgentMascot()`. What a
 * replacement must respect:
 *   - paint a square of `size` pixels; with `fit`, nothing outside it;
 *   - `reducedMotion` (already folded into `live`): no animation at all;
 *   - `label` names the image, `null` means decorative (`aria-hidden`).
 */
function PixelMascot() {
  const m = useAgentMascot()
  if (!m) return null
  const rows = EYES[STATE_EYES[m.state] || (m.look.eyes === 'happy' ? 'happy' : 'open')]
  const cells = []
  rows.forEach((row, y) => row.split('').forEach((c, x) => {
    if (c === '#') cells.push(React.createElement('rect', { key: `${x}-${y}`, x: 25 + x * 10, y: 40 + y * 10, width: 9, height: 9, fill: '#fff4e6' }))
  }))
  const a11y = m.label ? { role: 'img', 'aria-label': m.label } : { 'aria-hidden': true }
  return React.createElement('svg', {
    viewBox: '0 0 100 100', width: m.size, height: m.size, 'data-pixel-mascot': m.state || 'still', ...a11y,
  },
  // `fur`: the colour as `#rrggbb`, a mascot pack's fur included (`look.color` may be a pack id).
  React.createElement('rect', { x: 6, y: 6, width: 88, height: 88, rx: 18, fill: m.fur || m.look.color }),
  React.createElement('rect', { x: 18, y: 30, width: 64, height: 40, rx: 8, fill: '#0b0b0c' }),
  ...cells)
}

export function apply(ctx) {
  return ctx.slots.register({ slot: 'agent.mascot' }, PixelMascot)
}
