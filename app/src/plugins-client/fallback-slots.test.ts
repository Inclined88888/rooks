/**
 * A bundled module that holds a boot slot as its default occupant
 * (`fallback: true`) names that slot in its gallery identity
 * (`orchestrator/src/plugins/bundled-identity.ts`): the plugin gallery and the
 * daemon's contract then say what the module paints, and a slot nobody
 * declares cannot hide behind a module that occupies it (TODO #874:
 * `agent.mascot`, `directory.picker`, `confirm.dialog`, `chat.media`,
 * `chat.secret`, `chat.document` were occupied and never declared). The two
 * packages are independent, so both sides are read as text, like
 * `widget-kinds.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = process.cwd();
const read = (...parts: string[]): string => readFileSync(join(APP, ...parts), 'utf8');

/** `X_SLOT = 'a.b'` constants of the slot registry. */
function slotConstants(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of read('src', 'lib', 'plugin-host', 'slots.ts').matchAll(/export const (\w+_SLOT) = '([^']+)'/g)) {
    out.set(m[1]!, m[2]!);
  }
  return out;
}

/** `X_MODULE = '@rooks/…'` constants a client plugin may name its module with. */
function moduleConstants(): Map<string, string> {
  const out = new Map<string, string>();
  for (const sub of [['src', 'lib'], ['src', 'plugins-client']]) {
    for (const name of readdirSync(join(APP, ...sub))) {
      if (!/\.tsx?$/.test(name) || name.includes('.test.')) continue;
      for (const m of read(...sub, name).matchAll(/export const (\w+_MODULE) = '(@rooks\/[a-z-]+)'/g)) out.set(m[1]!, m[2]!);
    }
  }
  return out;
}

/** `[module, slot]` of every `ctx.register({ slot, fallback: true }, …)` of a bundled client plugin. */
function fallbackOccupants(): Array<[string, string]> {
  const constants = slotConstants();
  const modules = moduleConstants();
  const out: Array<[string, string]> = [];
  const dir = join(APP, 'src', 'plugins-client');
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.tsx') || name.endsWith('.test.tsx')) continue;
    const source = read('src', 'plugins-client', name);
    const named = /module: (?:'(@rooks\/[a-z-]+)'|(\w+_MODULE))/.exec(source);
    const module = named?.[1] ?? (named?.[2] ? modules.get(named[2]) : undefined);
    if (!module) continue;
    for (const m of source.matchAll(/ctx\.register\(\{\s*slot:\s*(?:'([^']+)'|(\w+))\s*,\s*fallback:\s*true/g)) {
      const slot = m[1] ?? constants.get(m[2]!);
      assert.ok(slot, `${name}: slot constant ${m[2]} not found in slots.ts`);
      out.push([module, slot]);
    }
  }
  return out;
}

/** The text of one module's entry, up to the next entry or the comment above it. */
function identityEntry(identity: string, id: string): string {
  const start = identity.indexOf(`'${id}':`);
  assert.notEqual(start, -1, `${id} has no gallery identity`);
  const ends = [identity.indexOf("\n  '@rooks/", start + 1), identity.indexOf('\n  //', start + 1)].filter((i) => i !== -1);
  return identity.slice(start, ends.length ? Math.min(...ends) : undefined);
}

test('every boot slot a bundled module occupies by default is declared in its identity', () => {
  const identity = read('..', 'orchestrator', 'src', 'plugins', 'bundled-identity.ts');
  const occupants = fallbackOccupants();
  assert.ok(occupants.length >= 13, `only ${occupants.length} default occupants found — the scan is broken`);
  for (const [module, slot] of occupants) {
    assert.ok(identityEntry(identity, module).includes(`'${slot}'`), `${module} occupies ${slot} but does not declare it`);
  }
});

test('the debt of TODO #874 is paid: the mascot, the folder picker and the confirmation dialog', () => {
  const occupants = fallbackOccupants().map(([module, slot]) => `${module} ${slot}`);
  for (const pair of ['@rooks/agents agent.mascot', '@rooks/settings directory.picker', '@rooks/settings confirm.dialog']) {
    assert.ok(occupants.includes(pair), `${pair} is no longer a default occupant: update this test`);
  }
});
