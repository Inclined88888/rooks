/**
 * A bundled module that paints a widget is a `widget` in the plugin gallery:
 * its filter must list every module the widget window draws from. The
 * gallery reads `orchestrator/src/plugins/bundled-identity.ts`, the widget
 * window reads the registrations here, so the two are compared as text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = process.cwd();
const read = (...parts: string[]): string => readFileSync(join(APP, ...parts), 'utf8');

/** Modules whose client half registers a widget, read from the sources. */
function widgetModules(): string[] {
  const out = new Set<string>();
  const dir = join(APP, 'src', 'plugins-client');
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.tsx')) continue;
    const source = read('src', 'plugins-client', name);
    if (!/registerWidget\(ctx|slot: 'cockpit\.widget'/.test(source)) continue;
    const module = /(?:module: |_MODULE = )'(@rooks\/[a-z-]+)'/.exec(source)?.[1];
    if (module) out.add(module);
  }
  for (const m of read('src', 'components', 'chat', 'chat-rails.tsx').matchAll(/pluginId: '(@rooks\/[a-z-]+)'/g)) {
    out.add(m[1]!);
  }
  return [...out].sort();
}

test('every module that paints a widget is a widget in the gallery', () => {
  const identity = read('..', 'orchestrator', 'src', 'plugins', 'bundled-identity.ts');
  const modules = widgetModules();
  assert.ok(modules.length >= 16, `only ${modules.length} widget modules found — the scan is broken`);
  for (const id of modules) {
    const start = identity.indexOf(`'${id}':`);
    assert.notEqual(start, -1, `${id} has no gallery identity`);
    const next = identity.indexOf("\n  '@rooks/", start + 1);
    const entry = identity.slice(start, next === -1 ? undefined : next);
    assert.match(entry, /'widget'|widget\(/, `${id} paints a widget but is not one in the gallery`);
  }
});
