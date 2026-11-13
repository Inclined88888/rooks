import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

/*
 * The order is structural (TODO #864): the home's permissions are set by a
 * synchronous module that `boot.ts` imports before anything that opens a
 * database or serves a route. A mocked call order would not catch an import
 * added later that opens SQLite first, which is how this breaks.
 */
const SRC = dirname(fileURLToPath(import.meta.url));

/** Static imports and re-exports of a source file, type-only ones left out. */
function staticImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const specs: string[] = [];
  for (const m of text.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)) specs.push(m[1]!);
  return specs;
}

function sourceOf(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const target = resolve(dirname(from), spec).replace(/\.js$/, '.ts');
  return existsSync(target) ? target : null;
}

/** Every module evaluated when `entry` is: local files, and bare packages by name. */
function closure(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const walk = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const spec of staticImports(file)) {
      const local = sourceOf(file, spec);
      if (local) walk(local);
      else if (!spec.startsWith('.') && !spec.startsWith('node:')) packages.add(spec);
    }
  };
  walk(entry);
  return { files, packages };
}

test('boot.ts restricts the home right after the log, before the lock, the restore and the data update', () => {
  const order = staticImports(join(SRC, 'boot.ts'));
  const at = (spec: string) => {
    const i = order.indexOf(spec);
    assert.notEqual(i, -1, spec);
    return i;
  };
  const perms = at('./home-permissions-boot.js');
  assert.ok(at('./log-boot.js') < perms);
  for (const later of ['./home-lock-boot.js', './data-restore-boot.js', './data-update-boot.js']) assert.ok(perms < at(later), later);
  // `kernel-boot.ts` (and `db.ts` through it) is only reached by a dynamic import after these.
  assert.ok(!order.includes('./kernel-boot.js'));
});

test('nothing evaluated before the home is restricted opens SQLite', () => {
  for (const entry of ['log-boot.ts', 'home-permissions-boot.ts']) {
    const { files, packages } = closure(join(SRC, entry));
    assert.ok(!files.has(join(SRC, 'db.ts')), `${entry} reaches db.ts`);
    assert.ok(!packages.has('better-sqlite3'), `${entry} reaches better-sqlite3`);
  }
});

test('the closure walker does see SQLite where it is', () => {
  // Without this, a walker that found nothing would pass the test above.
  assert.ok(closure(join(SRC, 'home-lock-boot.ts')).packages.has('better-sqlite3'));
});
