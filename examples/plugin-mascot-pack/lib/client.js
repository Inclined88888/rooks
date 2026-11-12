/**
 * A mascot pack: four parts the mascot configurator offers beside the
 * product's, in their own group under the pack's name.
 *
 * Two halves that must say the same ids:
 *   - the manifest (`rooks.mascot` in package.json) declares each part's slug
 *     by look field, so the daemon accepts `example-mascot-pack:<slug>` in an
 *     agent's look while this plugin is enabled;
 *   - this browser half registers each part's drawing in the `mascot.parts`
 *     slot, keyed by the same slug. A part the manifest does not declare is
 *     refused when it registers.
 *
 * A part is data, never code: no component, no React. An accessory is SVG
 * markup drawn around (0, 0) in a box of about 32 × 32 — only shapes and
 * presentation attributes, no text, style, link, handler or url(): the host
 * reads it with a strict reader and refuses anything else.
 *
 * Remove the plugin: its parts leave the configurator, and an agent that wore
 * one shows its job's default for that part until the pack comes back.
 */

const PARTS = {
  beanie: {
    type: 'acc',
    label: { en: 'Woolly hat', fr: 'Bonnet' },
    tilt: -12,
    svg: `
      <path d="M-11 4 C -11 -9, 11 -9, 11 4 Z" fill="#d94b4b"/>
      <path d="M-6 -4 L -6 3 M 0 -6 L 0 3 M 6 -4 L 6 3" stroke="#b83a3a" stroke-width="1.4" stroke-linecap="round"/>
      <rect x="-12.5" y="2" width="25" height="6" rx="3" fill="#f2efe8"/>
      <circle cx="0" cy="-9" r="3.6" fill="#f2efe8"/>`,
  },
  scarf: {
    type: 'acc',
    label: { en: 'Scarf', fr: 'Écharpe' },
    tilt: 8,
    svg: `
      <rect x="-13" y="-5" width="26" height="8" rx="4" fill="#3fa9ff"/>
      <rect x="3" y="0" width="7" height="15" rx="2.5" fill="#2b86d6"/>
      <path d="M4 15 L 4 18 M 6.5 15 L 6.5 18 M 9 15 L 9 18" stroke="#2b86d6" stroke-width="1.2" stroke-linecap="round"/>
      <path d="M-9 -1 L 9 -1" stroke="#fff" stroke-opacity=".35" stroke-width="1.2" stroke-dasharray="2 2"/>`,
  },
  midnight: {
    type: 'color',
    label: { en: 'Midnight', fr: 'Minuit' },
    hex: '#2b3a67',
  },
  snowflake: {
    type: 'eyes',
    label: { en: 'Snowflakes', fr: 'Flocons' },
    // Drawn eyes: they do not blink. The right eye mirrors this one.
    blink: false,
    left: Array.from({ length: 12 }, (_, i) => {
      const a = -Math.PI / 2 + (i * Math.PI) / 6
      const r = i % 2 ? 2.6 : 6.4
      return [Math.round(r * Math.cos(a) * 100) / 100, Math.round(r * Math.sin(a) * 100) / 100]
    }),
  },
}

export function apply(ctx) {
  const disposers = Object.entries(PARTS).map(([key, mascotPart]) =>
    ctx.slots.register({ slot: 'mascot.parts', key, mascotPart }))
  return () => { for (const dispose of disposers) dispose() }
}
