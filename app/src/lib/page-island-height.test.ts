/**
 * A page of the `page` slot lives in an island (`AppFrame`, then the island
 * workspace): it fills the island, never the viewport. A height written as
 * "viewport minus the top bar" is wrong twice over: alone, the island is
 * already shorter than that (the bottom gutter), and split it is a fraction
 * of the screen while `--rooks-topbar-h` reads 0 inside it
 * (`island-workspace.tsx`, `CONFINED_VARS`) — the page then takes the whole
 * viewport in a half-screen island, which clips its bottom: the composer of
 * `/bots`, the terminal's prompt (TODO #637).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOTS = [join(APP, 'src'), join(APP, '..', 'examples')];

/** `100vh` / `100dvh` / `100svh` / `100lvh` minus the top bar, in a class or a style. */
const VIEWPORT_MINUS_TOPBAR = /100[dsl]?vh\s*-\s*var\(\s*--rooks-topbar-h/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

test('no page sizes itself on the viewport minus the top bar', () => {
  const offenders = ROOTS.flatMap(sources).flatMap((path) =>
    readFileSync(path, 'utf8')
      .split('\n')
      .map((line, i) => ({ line, at: `${relative(APP, path)}:${i + 1}` }))
      .filter(({ line }) => VIEWPORT_MINUS_TOPBAR.test(line))
      .map(({ at }) => at),
  );
  assert.deepEqual(offenders, [], `fill the island instead (flex-1 min-h-0 or h-full): ${offenders.join(', ')}`);
});

test('the pattern catches the forms it is meant to', () => {
  for (const sample of [
    'h-[calc(100vh-var(--rooks-topbar-h))]',
    'h-[calc(100dvh-var(--rooks-topbar-h,3.5rem))]',
    "height: 'calc(100svh - var(--rooks-topbar-h))'",
  ]) assert.match(sample, VIEWPORT_MINUS_TOPBAR, sample);
  assert.doesNotMatch('pt-[var(--rooks-topbar-h)]', VIEWPORT_MINUS_TOPBAR);
});
