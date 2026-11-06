/**
 * A mission's title stays on one line in the rail, ending with an ellipsis, in
 * the desktop client too. Its Chromium (Electron 33 = Chromium 130) gives
 * `<button>` `align-items: flex-start` in its UA stylesheet, where current
 * browsers give `normal`: the row's `flex-col` button then sized its children to
 * the title, which overflowed the card and the widget (measured: title 478px in
 * a 266px button, 224px with the reset). jsdom applies no UA stylesheet, so the
 * guard is on the source: the global reset, and the rail's own explicit stretch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** Bodies of the `@layer base { … }` blocks, braces matched. */
function baseLayers(css: string): string[] {
  const bodies: string[] = [];
  const opener = /@layer\s+base\s*\{/g;
  for (let m = opener.exec(css); m; m = opener.exec(css)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
    }
    bodies.push(css.slice(start, i - 1));
  }
  return bodies;
}

test('globals.css resets the UA align-items of buttons, in the base layer', () => {
  const css = read('../../styles/globals.css');
  const rule = /:where\(button\)\s*\{\s*align-items:\s*normal;?\s*\}/;
  assert.ok(baseLayers(css).some((body) => rule.test(body)), 'expected `:where(button) { align-items: normal }` inside `@layer base`');
  // Outside a layer it would beat every `items-*` utility of the product.
  const outside = baseLayers(css).reduce((rest, body) => rest.replace(body, ''), css);
  assert.doesNotMatch(outside, rule);
});

test('the rail row stretches its children and truncates the title', () => {
  const src = read('./mission-rail.tsx');
  assert.match(src, /'flex w-full flex-col items-stretch [^']*'/, 'the row button spells out `items-stretch`');
  assert.match(src, /flex min-w-0 flex-1 flex-col[\s\S]{0,400}?<span className="truncate /, 'the title is a `truncate` span under a `min-w-0` column');
});
