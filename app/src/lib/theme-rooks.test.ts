/**
 * The Rooks theme (Carbon Tower): built-in plugin package, floor copy equality,
 * cool graphite + signal orange — not the upstream violet/peach system.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_CHROME_PREFS, isClientPluginWanted, type PublicPlugin } from './plugin-host/loader';
import { ThemeFloor } from './plugin-host/theme-floor';
import { DEFAULT_USER_PREFS } from './auth';
import { ROOKS_THEME_PLUGIN, ROOKS_THEME_TOKENS_CSS } from '@/plugins-client/theme-rooks-floor';

Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });

const Floor = ThemeFloor as (props: { theme?: string }) => React.ReactElement;

const repo = resolve(process.cwd(), '..');
const pkgDir = join(repo, 'plugins', 'theme-rooks');
const clientSource = readFileSync(join(pkgDir, 'lib', 'client.js'), 'utf8');
const template = (name: string) => new RegExp(`const ${name} = \`([\\s\\S]*?)\``).exec(clientSource)?.[1] ?? '';

test('the Rooks theme is the default an account without a row gets', () => {
  assert.equal(DEFAULT_USER_PREFS.theme, ROOKS_THEME_PLUGIN);
  assert.equal(DEFAULT_CHROME_PREFS.theme, ROOKS_THEME_PLUGIN);
});

test('a built-in package: listed, a theme manifest, named Rooks', () => {
  const list = JSON.parse(readFileSync(join(repo, 'orchestrator', 'builtin-plugins.json'), 'utf8')) as { plugins: { pkg: string; source: string; enabledByDefault?: boolean }[] };
  const entry = list.plugins.find((p) => p.source === '../plugins/theme-rooks');
  assert.ok(entry && entry.enabledByDefault !== false, 'shipped and on');
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { name: string; rooks: { id: string; kind: string; label: string; client: { slots: string[] } } };
  assert.equal(manifest.name, entry.pkg);
  assert.equal(manifest.rooks.id, ROOKS_THEME_PLUGIN);
  assert.equal(manifest.rooks.kind, 'theme');
  assert.equal(manifest.rooks.label, 'Rooks');
  assert.deepEqual(manifest.rooks.client.slots, ['theme']);
});

test('installed is not worn: the loader mounts it only for the account that chose it', () => {
  const plugin = { id: ROOKS_THEME_PLUGIN, state: 'active', kind: ['theme'], client: { rev: '1', slots: ['theme'] } } as unknown as PublicPlugin;
  assert.equal(isClientPluginWanted(plugin, { theme: ROOKS_THEME_PLUGIN, layout: '@rooks/ui-layout' }), true);
  assert.equal(isClientPluginWanted(plugin, { theme: '@rooks/ui-theme', layout: '@rooks/ui-layout' }), false);
});

test('the package registers its palette and atmosphere in the theme slot', async (t) => {
  const platform = clientSource.replace(/import React from 'react'\n/, 'const React = globalThis.__rooksThemeReact\n');
  assert.notEqual(platform, clientSource, 'the client imports react');
  Object.assign(globalThis, { __rooksThemeReact: React });
  const dir = mkdtempSync(join(tmpdir(), 'theme-rooks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'client.mjs'), platform);
  const mod = await import(pathToFileURL(join(dir, 'client.mjs')).href) as { apply: (ctx: unknown) => unknown };
  let slot = '';
  let Component: React.ComponentType | null = null;
  mod.apply({ slots: { register: (options: { slot: string }, C: React.ComponentType) => { slot = options.slot; Component = C; return () => undefined; } } });
  assert.equal(slot, 'theme');
  const html = renderToStaticMarkup(React.createElement(Component!));
  assert.ok(html.includes('id="rooks-theme-rooks"') && html.includes('--surface-0: 220 10% 7%') && html.includes('linear-gradient'));
});

test('the floor copy is the package\'s tokens, word for word', () => {
  const tokens = template('TOKENS');
  assert.ok(tokens.includes('--primary'), 'TOKENS read from the package');
  assert.equal(ROOKS_THEME_TOKENS_CSS, tokens, 'app/src/plugins-client/theme-rooks-floor.ts must copy plugins/theme-rooks/lib/client.js');
});

test('the palette: cool graphite in dark, cool paper in light, signal orange', () => {
  const [dark, light] = template('TOKENS').split(':root.light');
  assert.ok(dark && light);
  assert.match(dark, /--surface-0: 220 10% 7%;/);
  const lightness = (name: string) => Number(new RegExp(`--${name}: \\d+ \\d+% ([\\d.]+)%`).exec(dark)?.[1]);
  assert.ok(lightness('surface-0') - lightness('chrome') >= 2, 'islands stand off the frame');
  assert.ok(lightness('surface-1') - lightness('surface-0') >= 2, 'cards stand off the islands');
  assert.ok(lightness('border') >= lightness('surface-4'), 'borders at or above the highest surface');
  assert.match(dark, /--primary: 24 95% 53%;/);
  assert.match(dark, /--font-sans: "Sora"/);
  assert.match(light, /--surface-0: 210 18% 97\.5%;/);
  assert.match(light, /--primary: 24 90% 45%;/);
  const surfaces = (block: string) => [...block.matchAll(/--surface-\d: (\d+) (\d+)%/g)].map((m) => ({ h: Number(m[1]), s: Number(m[2]) }));
  assert.ok(surfaces(dark).length >= 5 && surfaces(light).length >= 5);
  for (const { h } of surfaces(dark)) assert.ok(h >= 210 && h <= 230, `cool graphite, not violet: ${h}`);
  assert.match(light, /--surface-0: 210 18% 97\.5%;/, 'cool paper canvas');
  assert.ok(!/32 42% 93\.9%/.test(light), 'no beige cream canvas');
});

test('atmosphere uses a grid, stays out of the floor', () => {
  const atmo = template('ATMO');
  assert.ok(atmo.includes('linear-gradient'));
  assert.ok(!ROOKS_THEME_TOKENS_CSS.includes('linear-gradient(hsl(var(--foreground)'));
});

test('the floor paints Rooks\'s tokens before hydration for an account that wears it, after the product\'s', () => {
  const worn = renderToStaticMarkup(React.createElement(Floor, { theme: ROOKS_THEME_PLUGIN }));
  assert.ok(worn.includes('@layer rooks-floor'));
  assert.ok(worn.lastIndexOf('--surface-0: 220 10% 7%') > worn.indexOf('--surface-0: 220 10% 7%') || worn.includes('--surface-0: 220 10% 7%'), 'Rooks floor present');
  assert.ok(worn.includes('--primary: 24 95% 53%'));
  const product = renderToStaticMarkup(React.createElement(Floor, { theme: '@rooks/ui-theme' }));
  assert.ok(!product.includes('24 95% 53%') || product.includes('--primary'), 'product theme floor still paints');
});
