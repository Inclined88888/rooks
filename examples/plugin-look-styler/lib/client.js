import React from 'react'
import { createTranslator, useLookStyler } from '@rooks/ui'

// A plugin ships its own strings: the product's keys are not part of the contract.
const t = createTranslator({
  en: { skull: 'Skull', eyes: 'Eyes', accessory: 'Accessory', fur: 'Fur', random: 'Random' },
  fr: { skull: 'Crâne', eyes: 'Yeux', accessory: 'Accessoire', fur: 'Pelage', random: 'Au hasard' },
})

function List({ name, label, value, options, onPick }) {
  return React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 } },
    React.createElement('span', { style: { width: 90 } }, label),
    React.createElement('select', {
      'data-compact-list': name,
      value,
      onChange: (e) => onPick(e.target.value),
      style: { flex: 1, padding: '4px 6px', borderRadius: 8 },
    }, options.map((o) => React.createElement('option', { key: o, value: o }, o))))
}

/**
 * A replacement of the mascot configurator: three lists, a row of swatches
 * and a random draw.
 *
 * `agent.lookstyler` is a `single` slot declared at boot, whose default
 * occupant is the product's preview and grids. Registering here claims the
 * configurator of every screen — onboarding and agent editor; removing the
 * plugin gives the product's back.
 *
 * The component receives no props: it reads `useLookStyler()`. What a
 * replacement must respect:
 *   - offer only the values of `choices`, and hand a whole look to `onChange`;
 *   - paint the inside only: the panel, its title and "Done" are the screen's;
 *   - `name` and `role` are the agent's, for a label or a default.
 */
function CompactLookStyler() {
  const s = useLookStyler()
  if (!s) return null
  const set = (field) => (value) => s.onChange({ ...s.look, [field]: value })
  return React.createElement('div', { 'data-compact-styler': s.name, style: { display: 'flex', flexDirection: 'column', gap: 10, padding: 8 } },
    React.createElement(List, { name: 'shape', label: t('skull'), value: s.look.shape, options: s.choices.shapes, onPick: set('shape') }),
    React.createElement(List, { name: 'eyes', label: t('eyes'), value: s.look.eyes, options: s.choices.eyes, onPick: set('eyes') }),
    React.createElement(List, { name: 'acc', label: t('accessory'), value: s.look.acc, options: s.choices.accessories, onPick: set('acc') }),
    React.createElement('div', { role: 'group', 'aria-label': t('fur'), style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
      // Swatches only for the product's `#rrggbb` colours: a mascot pack's fur is an id (`acme-pack:midnight`),
      // which this compact picker leaves out rather than paint a blank dot (`packs` names them).
      s.choices.colors.filter((color) => color.startsWith('#')).map((color) => React.createElement('button', {
        key: color,
        type: 'button',
        'data-compact-fur': color,
        'aria-label': color,
        'aria-pressed': s.look.color === color,
        onClick: () => set('color')(color),
        style: {
          width: 24, height: 24, borderRadius: 12, background: color, cursor: 'pointer',
          border: s.look.color === color ? '2px solid currentColor' : '2px solid transparent',
        },
      }))),
    React.createElement('button', { type: 'button', 'data-compact-random': true, onClick: () => s.onChange(s.random()), style: { alignSelf: 'flex-start', padding: '4px 10px', borderRadius: 8 } }, t('random')))
}

export function apply(ctx) {
  return ctx.slots.register({ slot: 'agent.lookstyler' }, CompactLookStyler)
}
