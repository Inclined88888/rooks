import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// The frosted chrome is a contract between globals.css, the rail and the
// unfolded strip: three files that must agree, or the chrome shows a darker
// band and a seam again (task 7d047ea3).
const css = readFileSync(new URL('../styles/globals.css', import.meta.url), 'utf8');
const nav = readFileSync(new URL('../components/vertical-nav.tsx', import.meta.url), 'utf8');

function mdGlassBlock(): string {
  const start = css.indexOf('@media (min-width: 768px) {\n  html[data-glass] { --timon-chrome-fill: transparent; }');
  assert.ok(start >= 0, 'the md+ glass block exists');
  const end = css.indexOf('\n}\n', start);
  return css.slice(start, end);
}

test('from md, the chrome is ONE frosted layer under the page', () => {
  const block = mdGlassBlock();
  const layer = /html\[data-glass\] body:has\(\.timon-nav-rail\)::before \{([^}]*)\}/.exec(block);
  assert.ok(layer, 'a single layer, only on pages that show the chrome');
  assert.match(layer[1]!, /position: fixed;/);
  assert.match(layer[1]!, /inset: 0;/);
  assert.match(layer[1]!, /z-index: -1;/);
  assert.match(layer[1]!, /background: var\(--timon-glass-chrome-bg\);/);
  assert.match(layer[1]!, /backdrop-filter: var\(--timon-glass-chrome-filter\);/);
});

test('from md, nothing else tints the chrome a second time', () => {
  const block = mdGlassBlock();
  assert.match(block, /:is\(\.timon-topbar-bar, \.timon-topbar-safe, \.timon-nav-rail\)::before \{ content: none; \}/);
  // Page backdrops, the underlay's shadow and the corners read this variable.
  assert.match(block, /html\[data-glass\] \{ --timon-chrome-fill: transparent; \}/);
  // A dialog sits over the page, not over the wallpaper: it keeps its frame.
  assert.match(block, /\[role='dialog'\][^{]*\{ --timon-chrome-fill: var\(--timon-glass-chrome-bg\); \}/);
});

test('the unfolded strip follows the rail: same width, same pace', () => {
  assert.match(css, /@property --timon-glass-rail-w \{\s*syntax: '<length>';/);
  assert.match(css, /\.timon-glass-rail \{[^}]*--timon-glass-rail-w: var\(--timon-nav-w\);/);
  assert.match(css, /\.timon-glass-rail \{[^}]*transition: --timon-glass-rail-w 150ms cubic-bezier\(0\.4, 0, 0\.2, 1\);/);
  // Unfolded, the rail is `w-56` (14rem) and the strip says the same.
  assert.match(css, /\.timon-glass-rail\[data-expanded\] \{ --timon-glass-rail-w: 14rem; \}/);
  assert.match(nav, /expanded \? 'w-56' : 'w-\[var\(--timon-nav-w\)\]'/);
  assert.match(nav, /'timon-nav-rail [^']*duration-150/);
  assert.match(nav, /const NAV_W_PINNED = '224px';/);
  assert.match(nav, /<GlassRail expanded=\{expanded\} \/>/);
});

test('the strip frosts its own copy the same way the layer frosts the wallpaper', () => {
  const frost = /\.timon-glass-rail-frost \{([^}]*)\}/.exec(css);
  assert.ok(frost);
  assert.match(frost[1]!, /background: var\(--timon-glass-chrome-bg\);/);
  assert.match(frost[1]!, /backdrop-filter: var\(--timon-glass-chrome-filter\);/);
  // The mask is what makes it a backdrop root: the blur reads the copy only.
  assert.match(css, /\.timon-glass-rail \{[^}]*mask-image:/);
});

// Blur, transparency and tint come from Appearance (`glassCss`): no surface
// of the glass may keep a literal radius or alpha, or it stops following them.
test('every frosted surface reads the blur, the alpha and the tone of Appearance', () => {
  const start = css.indexOf('/* Frosted glass (Settings → Appearance).');
  const end = css.indexOf('/* Tabs are a segmented control');
  assert.ok(start >= 0 && end > start);
  const glass = css.slice(start, end);
  assert.doesNotMatch(glass, /blur\(\d+px\)/, 'a literal blur radius');
  assert.doesNotMatch(glass, /hsl\(var\(--(chrome|card|background|surface-2)\) \/ 0\.\d+\)/, 'a literal glass alpha');
});

// Glass scope (task 23507c08), `both` and per-zone tuning: whole island, each
// widget, or both, read through inherited custom properties so the closest
// `data-glass-scope` wins.
function rule(selector: RegExp): string {
  const found = new RegExp(selector.source + String.raw`\s*\{([^}]*)\}`).exec(css);
  assert.ok(found, `rule ${selector.source}`);
  return found[1]!;
}
test('the glass scope drives the island frost and the widgets\' glass through variables', () => {
  const island = rule(/html\[data-glass\],\s*html\[data-glass\] \[data-glass-scope='island'\]/);
  assert.match(island, /--timon-glass-island-filter: var\(--timon-glass-island-blur-filter\);/, 'the plate frosts its own copy');
  assert.match(island, /--timon-glass-widget-filter: none;/, 'no blur of their own inside a frosted island');
  assert.match(island, /--timon-glass-clear: block;/);
  const widgets = rule(/html\[data-glass\]\[data-glass-scope='widgets'\],\s*html\[data-glass\] \[data-glass-scope='widgets'\]/);
  assert.match(widgets, /--timon-glass-island-fill: transparent;/);
  assert.match(widgets, /--timon-glass-island-filter: none;/, 'the copy stays sharp');
  assert.match(widgets, /--timon-glass-widget-filter: var\(--timon-glass-widget-blur-filter\);/);
  const both = rule(/html\[data-glass\]\[data-glass-scope='both'\],\s*html\[data-glass\] \[data-glass-scope='both'\]/);
  assert.match(both, /--timon-glass-island-filter: var\(--timon-glass-island-blur-filter\);/);
  assert.match(both, /--timon-glass-widget-filter: var\(--timon-glass-widget-blur-filter\);/);
  const dialog = rule(/html\[data-glass\] :is\(\[role='dialog'\], \[aria-modal='true'\]\)/);
  assert.match(dialog, /--timon-glass-clear: none;/, 'a dialog sits over the page: no copy of the wallpaper');
  assert.match(dialog, /--timon-glass-island-plate: var\(--timon-glass-island-bg\);/);
  assert.match(css, /:where\(html\[data-glass\]\) \.timon-island \{ background: var\(--timon-glass-island-plate/);
  // Only an island that holds its own frost layer clears its box: a Kanban
  // column or a form island has none, and keeps its plate over the chrome.
  assert.match(css, /:where\(html\[data-glass\]\) \.timon-island:where\(:has\(> \.timon-glass-clear\)\) \{ background: var\(--timon-glass-cleared-plate/);
  assert.match(island, /--timon-glass-island-plate: var\(--timon-glass-island-bg\);/);
  assert.match(island, /--timon-glass-cleared-plate: transparent;/);
  assert.match(dialog, /--timon-glass-cleared-plate: var\(--timon-glass-island-bg\);/, 'a dialog hides the layer: the plate goes back on the box');
  assert.match(css, /section::before \{\s*background: var\(--timon-glass-widget-fill\);[^}]*backdrop-filter: var\(--timon-glass-widget-filter\);/);
});

test('each zone reads its own blur, opacity and tone', () => {
  const root = rule(/:root(?=\s*\{\s*--timon-glass-chrome-bg)/);
  for (const zone of ['chrome', 'island', 'widget']) {
    assert.match(root, new RegExp(String.raw`--timon-glass-${zone}-blur, 16px`), `${zone} blur`);
    assert.match(root, new RegExp(String.raw`--timon-glass-${zone}-tone, var\(--`), `${zone} tone`);
    assert.match(root, new RegExp(String.raw`--timon-glass-${zone}-alpha, 0\.6`), `${zone} alpha`);
  }
  assert.match(root, /--timon-glass-bubble-blur, 16px/);
  assert.match(css, /--timon-glass-bubble-alpha, 0\.55/);
});

// A popup island showed the sharp wallpaper through its header, unblurred,
// over the islands beneath (03/11/2026); it is now frosted like a widget.
test('a floating island frosts what lies under it like a widget, never with a copy of the wallpaper', () => {
  const vars = /html\[data-glass\] \[data-island-float\] \{([^}]*)\}/.exec(css);
  assert.ok(vars);
  assert.match(vars[1]!, /--timon-glass-clear: none;/);
  assert.match(vars[1]!, /--timon-glass-widget-filter: none;/, 'no second blur for the widgets inside');
  assert.ok(css.indexOf(vars[0]) > css.indexOf("html[data-glass] [data-glass-scope='both']"), 'after the scope rules, or an island\'s own scope wins');
  const frost = /html\[data-glass\] \[data-island-float\]::before \{([^}]*)\}/.exec(css);
  assert.ok(frost);
  assert.match(frost[1]!, /z-index: -1;/);
  assert.match(frost[1]!, /background: var\(--timon-glass-widget-bg\);/);
  assert.match(frost[1]!, /backdrop-filter: var\(--timon-glass-widget-blur-filter\);/);
});

test('an island frosts its own copy of the wallpaper, clipped and masked on its own wrapper', () => {
  const clear = rule(/html\[data-glass\] \.timon-glass-clear/);
  assert.match(clear, /display: var\(--timon-glass-clear, none\);/);
  assert.match(clear, /z-index: -1;/);
  assert.match(clear, /clip-path: inset\(0 round var\(--timon-island-radius\)\);/);
  // The mask makes the wrapper a backdrop root: the island's blur reads the copy only.
  assert.match(clear, /mask-image: linear-gradient\(#000 0 0\);/);
  const frost = rule(/\.timon-glass-clear-frost/);
  assert.match(frost, /background: var\(--timon-glass-island-fill, transparent\);/);
  assert.match(frost, /backdrop-filter: var\(--timon-glass-island-filter, none\);/);
  assert.match(css, /\.timon-glass-clear-view \{ position: fixed; inset: 0; \}/);
  assert.doesNotMatch(css, /\.timon-island[^{]*\{[^}]*clip-path/, 'a clip on the island would cut a widget\'s inline modal');
});
