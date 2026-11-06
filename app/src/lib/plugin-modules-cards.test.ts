/**
 * The gallery card of every bundled module — label and description, in
 * English, the only language required whole (docs/I18N.md); another language
 * lacking a card reads it in English.
 *
 * What it closes: a module born on the daemon side (dreams, web-push,
 * backlog, agent-chat) enters the catalog, and its card shows its raw id as a
 * name. `bundledCopy` falls back silently on `plugin.id`: nobody sees the
 * omission before meeting "@timon/web-push" written as is in the gallery.
 *
 * The catalog is read as TEXT, not imported: the two packages stay
 * independent at run time (the same reason `brand.ts` lives twice). A test may
 * read the repository.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import en from '../locales/en/plugins.json';

const CATALOG_SRC = fileURLToPath(
  new URL('../../../orchestrator/src/kernel/catalog.ts', import.meta.url),
);

function catalogIds(): string[] {
  const src = readFileSync(CATALOG_SRC, 'utf8');
  const ids = [...src.matchAll(/\{ id: '([^']+)'/g)].map((m) => m[1] ?? '');
  assert.ok(ids.length > 20, 'unreadable catalog: the shape of its entries changed');
  return ids;
}

const modules = en.pluginsPage.modules as Record<string, { label?: string; description?: string }>;

test('every module of the catalog has its card in English, and every card a module', () => {
  const ids = catalogIds();
  assert.deepEqual(ids.filter((id) => !modules[id]), [], 'modules without a card');
  assert.deepEqual(Object.keys(modules).filter((id) => !ids.includes(id)), [], 'cards without a module in the catalog');
});

test('every card has a label and a description', () => {
  for (const [id, entry] of Object.entries(modules)) {
    assert.ok(entry.label?.trim(), `${id} has no label`);
    assert.ok(entry.description?.trim(), `${id} has no description`);
  }
});
