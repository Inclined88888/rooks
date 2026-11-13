/**
 * A tester who goes back to 0.1.0 opens, with 0.1.0's code, a database the
 * current version already migrated — and 0.1.0 has no restore dialog. It only
 * works while every migration since the tag stays additive: nothing 0.1.0
 * reads is dropped or renamed, and nothing 0.1.0 inserts into gains a column
 * it would leave NULL against a NOT NULL. A destructive migration (a table
 * rewrite, like ui_layout's) must be declared in `DESTRUCTIVE_MIGRATIONS`
 * (`data-version.ts`): a version then refuses to run it without the
 * pre-<version> copy. Anything this test finds that no entry declares fails it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DESTRUCTIVE_MIGRATIONS } from './data-version.js';

type Column = { name: string; notnull: number; dflt_value: string | null; pk: number };

test('a database migrated by this version still opens under 0.1.0', async () => {
  const { db } = await import('./db.js');
  const fixture = JSON.parse(readFileSync(new URL('./__fixtures__/db-schema-v0.1.0.json', import.meta.url), 'utf8')) as {
    tables: Record<string, string[]>;
  };
  const problems: { subject: string; problem: string }[] = [];
  for (const [table, columns] of Object.entries(fixture.tables)) {
    const current = db.prepare(`PRAGMA table_info("${table}")`).all() as Column[];
    if (!current.length) {
      problems.push({ subject: table, problem: `table ${table} no longer exists` });
      continue;
    }
    const names = new Set(current.map((c) => c.name));
    for (const column of columns) {
      if (!names.has(column)) problems.push({ subject: `${table}.${column}`, problem: `${table}.${column} no longer exists` });
    }
    for (const column of current) {
      if (columns.includes(column.name) || column.pk) continue;
      if (column.notnull && column.dflt_value === null) {
        problems.push({
          subject: `${table}.${column.name}`,
          problem: `${table}.${column.name} is NOT NULL without a default: 0.1.0 inserts would fail`,
        });
      }
    }
  }
  const declared = new Set(DESTRUCTIVE_MIGRATIONS.flatMap((m) => m.breaks));
  const undeclared = problems.filter(({ subject }) => !declared.has(subject) && !declared.has(subject.split('.')[0]!));
  assert.deepEqual(
    undeclared.map(({ problem }) => problem),
    [],
    'a destructive migration must be declared in DESTRUCTIVE_MIGRATIONS (data-version.ts)',
  );
});

test('every declared destructive migration is applied by db.ts', async () => {
  const { db } = await import('./db.js');
  for (const migration of DESTRUCTIVE_MIGRATIONS) assert.ok(migration.applied(db), migration.id);
});
