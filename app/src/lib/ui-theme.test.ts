/**
 * `@rooks/ui-theme` occupies the boot-declared `theme` slot. A second
 * claimant paints in its place; disposing it returns the salmon palette.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { register, resetSlotsForTests, slotEntries, slotKind } from './plugin-host/slots';
import { SlotSingle } from './plugin-host/render';
import { declareLayoutSlots } from './plugin-host/client-plugin-host';
import { mountBundledClients } from '@/plugins-client/mount';
import {
  THEME_TOKENS_CSS,
  THEME_TOKENS_STYLE_ID,
  ThemeRoot,
  UI_THEME_MODULE,
} from '@/plugins-client/ui-theme';
import { THEME_FLOOR_STYLE_ID, ThemeFloor } from './plugin-host/theme-floor';
import type { Capabilities } from './capabilities';

const SALMON_DARK = '31 79% 56\\.9%';

test('theme is a boot slot, independent of ui-layout', () => {
  resetSlotsForTests();
  assert.equal(slotKind('theme'), 'single');
  assert.equal(slotKind('nav.item'), null, 'layout children are not boot slots');
});

test('the bundled theme registers as the default occupant and paints salmon', () => {
  resetSlotsForTests();
  declareLayoutSlots();
  mountBundledClients(null);
  const entries = slotEntries('theme');
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.pluginId, UI_THEME_MODULE);
  assert.equal(entries[0]?.fallback, true);
  assert.equal(
    slotEntries('settings.section').some((row) => row.pluginId === UI_THEME_MODULE),
    true,
    'Appearance is this plugin\'s own settings.section, not a daemon graft',
  );

  const html = renderToStaticMarkup(React.createElement(SlotSingle, { name: 'theme' }));
  assert.match(html, new RegExp(`id="${THEME_TOKENS_STYLE_ID}"`));
  assert.match(html, new RegExp(`--primary:\\s*${SALMON_DARK}`));
  assert.match(html, /\.light\s*\{/);
});

test('ui-theme still registers when layout slots are absent', () => {
  resetSlotsForTests();
  const error = console.error;
  console.error = () => {};
  try {
    mountBundledClients(null);
    assert.equal(slotEntries('theme')[0]?.pluginId, UI_THEME_MODULE);
    assert.equal(slotEntries('theme')[0]?.fallback, true);
  } finally {
    console.error = error;
  }
});

test('a second register without fallback paints, and dispose returns the salmon', () => {
  resetSlotsForTests();
  declareLayoutSlots();
  mountBundledClients(null);

  const Other = () => React.createElement('style', { id: 'other-theme' }, ':root { --primary: 200 80% 50%; }');
  const dispose = register({ slot: 'theme', pluginId: 'fixture-theme' }, Other);

  const claimed = renderToStaticMarkup(React.createElement(SlotSingle, { name: 'theme' }));
  assert.match(claimed, /id="other-theme"/);
  assert.doesNotMatch(claimed, new RegExp(`id="${THEME_TOKENS_STYLE_ID}"`), 'the fallback steps aside, it does not stack');
  assert.doesNotMatch(claimed, new RegExp(SALMON_DARK));

  dispose();
  const restored = renderToStaticMarkup(React.createElement(SlotSingle, { name: 'theme' }));
  assert.match(restored, new RegExp(`id="${THEME_TOKENS_STYLE_ID}"`));
  assert.match(restored, new RegExp(`--primary:\\s*${SALMON_DARK}`), 'disposing the claimant returns the salmon');
});

test('globals.css keeps infrastructure vars and consumers, not palette values', () => {
  const css = readFileSync(new URL('../styles/globals.css', import.meta.url), 'utf8');
  assert.match(css, /--rooks-topbar-h\s*:/);
  assert.match(css, /--rooks-nav-w\s*:/);
  assert.match(css, /--rooks-browser-w\s*:/);
  assert.match(css, /var\(--primary\)/);
  // The global backdrop now owns patterns; CSS keeps scrollbar consumers.
  assert.match(css, /var\(--rooks-scrollbar-thumb\)/);
  assert.match(css, /var\(--hl-fg\)/);
  assert.doesNotMatch(css, /--primary\s*:/);
  assert.doesNotMatch(css, /--surface-0\s*:/);
  assert.doesNotMatch(css, /\.light\s*\{/);
});

/** Restricted viewer (M.4): `surfaces` lists what this account may see. */
function restrictedCaps(themes: string[]): Capabilities {
  return {
    edition: 'expert',
    profile: 'host',
    capabilities: [],
    modules: [{ id: UI_THEME_MODULE, tier: 'std', active: true, reason: null, missing: [] }],
    ui: { hidden: [], home: '/' },
    kernel: true,
    developer: { unsignedPlugins: false },
    surfaces: { pages: [], widgets: [], nav: [], plugins: [], themes, layouts: [] },
  };
}

test('a viewer without the theme surface gets an empty theme slot', () => {
  resetSlotsForTests();
  declareLayoutSlots();
  mountBundledClients(restrictedCaps([]));
  assert.equal(slotEntries('theme').length, 0, 'the product palette is a theme like any other');
  assert.equal(
    slotEntries('settings.section').some((row) => row.pluginId === UI_THEME_MODULE),
    false,
    'no Appearance pane when the theme itself is not granted',
  );
});

test('the product palette comes back once its surface is granted', () => {
  resetSlotsForTests();
  declareLayoutSlots();
  mountBundledClients(restrictedCaps(['ui-theme']));
  assert.equal(slotEntries('theme')[0]?.pluginId, UI_THEME_MODULE);

  resetSlotsForTests();
  declareLayoutSlots();
  mountBundledClients({ ...restrictedCaps([]), surfaces: { all: true } });
  assert.equal(slotEntries('theme')[0]?.pluginId, UI_THEME_MODULE, 'an unrestricted viewer keeps the fallback');
});

test('ui-theme owns --font-sans and --font-mono (system stack, no next/font)', () => {
  assert.match(THEME_TOKENS_CSS, /--font-sans\s*:/);
  assert.match(THEME_TOKENS_CSS, /--font-mono\s*:/);
  const layout = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(layout, /next\/font/);
  assert.doesNotMatch(layout, /themeColor\s*:/);
  const tailwind = readFileSync(new URL('../../tailwind.config.ts', import.meta.url), 'utf8');
  assert.match(tailwind, /var\(--font-sans\)/);
  assert.doesNotMatch(tailwind, /--font-inter/);
});

test('the theme-color sync is hosted around the slot, not inside the occupant', () => {
  // An effect held by the occupant would be torn down exactly when a
  // third-party theme claims the slot. See theme-color-sync.test.ts for the
  // behavioural proof; this guards the wiring against a well-meaning revert.
  const occupant = readFileSync(new URL('../plugins-client/ui-theme.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(occupant, /theme-color|startThemeColorSync/);
  const layout = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8');
  assert.match(layout, /<ThemeColorSync>\s*<SlotSingle name="theme" \/>\s*<\/ThemeColorSync>/);
});

/**
 * The floor (`theme-floor.tsx`) and the slot occupant paint the SAME tokens
 * from the same string. What separates them is the cascade layer: an
 * unlayered declaration beats any layer whatever the document order, so the
 * occupant always wins the tokens it defines — and only those.
 */
test('the floor paints the same tokens, inside a cascade layer', () => {
  const html = renderToStaticMarkup(React.createElement(ThemeFloor));
  assert.match(html, new RegExp(`id="${THEME_FLOOR_STYLE_ID}"`));
  assert.ok(html.includes('@layer rooks-floor {'), 'the floor must be layered, or it would beat a theme');
  // Verbatim, not a subset: a floor that drifts from the palette would paint
  // a page half-salmon, half-something-else the day a token moves.
  assert.ok(html.includes(THEME_TOKENS_CSS.replace(/</g, '&lt;')), 'the floor is the palette, verbatim');
});

test('the slot occupant is NOT layered — it must beat the floor', () => {
  const html = renderToStaticMarkup(React.createElement(ThemeRoot));
  assert.equal(html.includes('@layer'), false);
  assert.match(html, new RegExp(SALMON_DARK));
});

test('the fallback paints nothing while another theme is expected and the plugins have not loaded', async () => {
  // The provider's JSX is compiled for a global React, as in the browser bundle.
  (globalThis as { React?: typeof React }).React ??= React;
  const { PathnameContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { ThemeProvider } = await import('@/components/theme-provider');
  // The first paint (server and hydration): the plugins are not synced yet.
  const under = (initialTheme: string | null): string => renderToStaticMarkup(React.createElement(PathnameContext.Provider, { value: '/onboarding' },
    React.createElement(ThemeProvider, { initialTheme, children: React.createElement(ThemeRoot) })));
  const tokens = new RegExp(`id="${THEME_TOKENS_STYLE_ID}"`);
  assert.doesNotMatch(under('theme-rooks'), tokens, 'the floor paints Rooks; the product palette must not flash over it');
  assert.doesNotMatch(under('acme-theme'), tokens, 'same for a chosen third-party theme');
  assert.match(under(UI_THEME_MODULE), tokens, 'the product theme is expected: it paints at once');
  assert.match(under(null), tokens, 'nothing said: it paints');
});

test('no baked #E07A5F / #c95a3f in app/src outside comments', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const hits: string[] = [];
  for (const file of walkSource(root)) {
    const body = stripComments(readFileSync(file, 'utf8'));
    if (/#e07a5f|#c95a3f/i.test(body)) hits.push(file.slice(root.length));
  }
  assert.deepEqual(hits, []);
});

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walkSource(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkSource(p));
    else if (/\.(ts|tsx|css|js)$/.test(ent.name) && !ent.name.includes('.test.')) out.push(p);
  }
  return out;
}
