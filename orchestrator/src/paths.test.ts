/**
 * Garde-fou `TIMON_HOME` : sous le runner, jamais le home réel, jamais ~/.pkos. public-name-ok: the archive guard
 *
 * `paths.ts` se fige à l'import : on sonde le module dans un process enfant
 * pour ne pas polluer le TIMON_HOME déjà posé par `test-home.ts`.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIMON_HOME } from './paths.js';

const orchestrator = join(dirname(fileURLToPath(import.meta.url)), '..');

function probe(patch: Record<string, string | null>) {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_TEST_CONTEXT: '1' };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete env[k];
    else env[k] = v;
  }
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', '-e', "await import('./src/paths.ts')"],
    { encoding: 'utf8', cwd: orchestrator, env },
  );
}

// public-name-ok: the archive guard refuses it by name
test('le home du process de test n\'est ni ~/.pkos ni ~/.timon', () => {
  assert.notEqual(TIMON_HOME, join(homedir(), '.pkos'));
  assert.notEqual(TIMON_HOME, join(homedir(), '.timon'));
  assert.ok(
    TIMON_HOME.startsWith(tmpdir()) || TIMON_HOME.includes('timon-test-home-'),
    `home de test inattendu : ${TIMON_HOME}`,
  );
});

test('sans TIMON_HOME, le runner refuse de charger paths.ts', () => {
  const r = probe({ TIMON_HOME: null });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /TIMON_HOME is required/);
});

// public-name-ok: the archive guard refuses it by name
test('TIMON_HOME=~/.pkos est refusé (home du PKOS quotidien)', () => {
  const r = probe({ TIMON_HOME: join(homedir(), '.pkos') });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /~\/\.pkos/); // public-name-ok: the refusal names the archive
});

test('TIMON_HOME=~/.timon réel est refusé sous le runner', () => {
  const r = probe({ TIMON_HOME: join(homedir(), '.timon') });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /the real ~\/\.timon/);
});
