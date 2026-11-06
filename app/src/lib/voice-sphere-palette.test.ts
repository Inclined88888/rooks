import test from 'node:test';
import assert from 'node:assert/strict';

import { derivePalettes, FALLBACK_PALETTES, parsePrimaryHsl } from './voice-sphere-palette';

const hslOf = (css: string) => {
  const m = /^hsl\((\d+), (\d+)%, (\d+)%\)$/.exec(css);
  assert.ok(m, `${css} is not a comma hsl() THREE.Color can parse`);
  return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) };
};

/** Shortest distance between two hues on the colour wheel. */
const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

test('the three states derive from the primary hue and stay distinct', () => {
  const p = derivePalettes('13 67% 63%');
  const all = [p.listening, p.speaking, p.thinking].flatMap((x) => [x.a, x.b, x.glow]);
  for (const c of all) assert.ok(hueGap(hslOf(c).h, 13) <= 20, `${c} drifts off the primary hue`);
  assert.equal(hslOf(p.listening.b).h, 13, 'listening body is the primary itself');

  const bodies = [p.listening.b, p.speaking.b, p.thinking.b];
  assert.equal(new Set(bodies).size, 3, 'each state has its own body colour');
  assert.ok(hslOf(p.speaking.b).l > hslOf(p.listening.b).l, 'speaking is brighter');
  assert.ok(hslOf(p.thinking.b).l < hslOf(p.listening.b).l, 'thinking is darker');
  for (const x of [p.listening, p.speaking, p.thinking]) {
    assert.ok(hslOf(x.glow).l > hslOf(x.b).l, 'the glow is a lighter variant');
  }
});

test('a blue theme gives a blue orb, hue wrapping included', () => {
  const blue = derivePalettes('221 83% 53%');
  assert.ok(hueGap(hslOf(blue.speaking.a).h, 221) <= 20);
  const red = derivePalettes('355 80% 50%');
  const h = hslOf(red.speaking.a).h;
  assert.ok(h >= 0 && h < 360 && hueGap(h, 355) <= 20, `hue ${h} did not wrap`);
});

test('an empty or unreadable primary falls back to the built-in palette', () => {
  assert.equal(derivePalettes(''), FALLBACK_PALETTES);
  assert.equal(derivePalettes(null), FALLBACK_PALETTES);
  assert.equal(derivePalettes('not a colour'), FALLBACK_PALETTES);
});

test('the token parser accepts the shadcn form and common variants', () => {
  assert.deepEqual(parsePrimaryHsl(' 13 67% 63% '), { h: 13, s: 67, l: 63 });
  assert.deepEqual(parsePrimaryHsl('hsl(13, 67%, 63%)'), { h: 13, s: 67, l: 63 });
  assert.deepEqual(parsePrimaryHsl('13deg 67% 63% / 0.9'), { h: 13, s: 67, l: 63 });
});
