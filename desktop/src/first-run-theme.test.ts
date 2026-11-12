import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FIRST_RUN_THEME } from './first-run-theme.js';

/** The theme package the onboarding paints, from the repository (the source of truth). */
const PACKAGE = fileURLToPath(new URL('../../plugins/theme-rooks/lib/client.js', import.meta.url));

function hex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const light = l / 100;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number): string => {
    const k = (n + h / 30) % 12;
    const v = light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** `--name: H S% L%;` of one block of the package, resolved through `var(--other)` once. */
function tokens(block: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/--([\w-]+):\s*([^;]+);/g)) map.set(name!, value!.trim());
  const resolve = (name: string): string => {
    const value = map.get(name) ?? '';
    const alias = /^var\(--([\w-]+)\)$/.exec(value);
    return alias ? resolve(alias[1]!) : value;
  };
  const out = new Map<string, string>();
  for (const name of map.keys()) {
    const m = /^(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%$/.exec(resolve(name));
    if (m) out.set(name, hex(Number(m[1]), Number(m[2]), Number(m[3])));
  }
  return out;
}

test('the first-launch palette is the Rooks theme package, dark and light', () => {
  const source = readFileSync(PACKAGE, 'utf8');
  const light = source.indexOf(':root.light');
  assert.ok(light > 0, 'the package has a light block');
  const blocks = { dark: tokens(source.slice(0, light)), light: tokens(source.slice(light)) };
  for (const scheme of ['dark', 'light'] as const) {
    const t = blocks[scheme];
    const p = FIRST_RUN_THEME[scheme];
    assert.deepEqual(
      [p.background, p.foreground, p.muted, p.border, p.chip, p.primary, p.primaryForeground],
      [t.get('background'), t.get('foreground'), t.get('muted-foreground'), t.get('border'), t.get('surface-chip'), t.get('primary'), t.get('primary-foreground')],
      scheme,
    );
  }
});
