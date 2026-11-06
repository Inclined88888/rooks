/**
 * TODO #551 — `systemctl` runs from the host adapter only (`host/`): the
 * self-supervision status and the doctor each spawned it on their own, with
 * their own timeout and their own "absent" reading.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(import.meta.dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

test('no module outside host/ spawns systemctl itself', () => {
  const offenders = sources(SRC)
    .filter((path) => !relative(SRC, path).startsWith(`host${sep}`))
    // A call that names the binary (`exec('systemctl', …)`, `spawn("systemctl", …)`), not prose.
    .filter((path) => /\(\s*['"]systemctl['"]/.test(readFileSync(path, 'utf8')))
    .map((path) => relative(SRC, path));
  assert.deepEqual(offenders, []);
});
