/**
 * The Rooks theme (moodboard): built-in plugin package, floor copy equality,
 * warm near-black / cream + tower amber — not teal, purple, or grid glow.
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

test('the package registers its palette in the theme slot', async (t) => {
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
  assert.ok(html.includes('id="rooks-theme-rooks"') && html.includes('--surface-0: 240 4% 4.5%'));
  assert.ok(!html.includes('linear-gradient'), 'no decorative grid or glow');
});

test('the floor copy is the package\'s tokens, word for word', () => {
  const tokens = template('TOKENS');
  assert.ok(tokens.includes('--primary'), 'TOKENS read from the package');
  assert.equal(ROOKS_THEME_TOKENS_CSS, tokens, 'app/src/plugins-client/theme-rooks-floor.ts must copy plugins/theme-rooks/lib/client.js');
});

test('the palette: warm near-black dark, cream light, tower amber, Geist', () => {
  const [dark, light] = template('TOKENS').split(':root.light');
  assert.ok(dark && light);
  assert.match(dark, /--surface-0: 240 4% 4\.5%;/);
  const lightness = (name: string) => Number(new RegExp(`--${name}: \\d+ \\d+% ([\\d.]+)%`).exec(dark)?.[1]);
  assert.ok(lightness('surface-0') - lightness('chrome') >= 2, 'islands stand off the frame');
  assert.ok(lightness('surface-1') - lightness('surface-0') >= 2, 'cards stand off the islands');
  assert.ok(lightness('border') >= lightness('surface-4'), 'borders at or above the highest surface');
  assert.match(dark, /--primary: 31 79% 56\.9%;/);
  assert.match(dark, /--font-sans: "Geist"/);
  assert.match(dark, /--font-mono: "Geist Mono"/);
  assert.match(light, /--surface-0: 42 31% 93\.7%;/);
  assert.match(light, /--primary: 29 82% 42\.7%;/);
  const surfaces = (block: string) => [...block.matchAll(/--surface-\d: (\d+) (\d+)%/g)].map((m) => ({ h: Number(m[1]), s: Number(m[2]) }));
  assert.ok(surfaces(dark).length >= 5 && surfaces(light).length >= 5);
  for (const { h } of surfaces(dark)) assert.ok(h >= 230 && h <= 250, `warm near-black, not teal/violet: ${h}`);
  assert.match(light, /--surface-0: 42 31% 93\.7%;/, 'cream paper canvas');
  assert.ok(!/173 |174 |263 /.test(dark + light), 'no teal or purple accents in the floor');
});

test('atmosphere is flat — no grid or glow', () => {
  const atmo = template('ATMO');
  assert.ok(atmo.includes('background-color'));
  assert.ok(!atmo.includes('linear-gradient'));
  assert.ok(!atmo.includes('radial-gradient'));
  assert.ok(!ROOKS_THEME_TOKENS_CSS.includes('linear-gradient(hsl(var(--foreground)'));
});

test('the floor paints Rooks\'s tokens before hydration for an account that wears it, after the product\'s', () => {
  const worn = renderToStaticMarkup(React.createElement(Floor, { theme: ROOKS_THEME_PLUGIN }));
  assert.ok(worn.includes('@layer rooks-floor'));
  assert.ok(worn.includes('--surface-0: 240 4% 4.5%'), 'Rooks floor present');
  assert.ok(worn.includes('--primary: 31 79% 56.9%'));
  const product = renderToStaticMarkup(React.createElement(Floor, { theme: '@rooks/ui-theme' }));
  assert.ok(product.includes('--primary'), 'product theme floor still paints');
});
