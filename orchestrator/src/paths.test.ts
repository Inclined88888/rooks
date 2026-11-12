/**
 * Garde-fou `ROOKS_HOME` : sous le runner, jamais le home réel, jamais ~/.pkos. public-name-ok: the archive guard
 *
 * `paths.ts` se fige à l'import : on sonde le module dans un process enfant
 * pour ne pas polluer le ROOKS_HOME déjà posé par `test-home.ts`.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOKS_HOME } from './paths.js';

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
test('le home du process de test n\'est ni ~/.pkos ni ~/.rooks', () => {
  assert.notEqual(ROOKS_HOME, join(homedir(), '.pkos'));
  assert.notEqual(ROOKS_HOME, join(homedir(), '.rooks'));
  assert.ok(
    ROOKS_HOME.startsWith(tmpdir()) || ROOKS_HOME.includes('rooks-test-home-'),
    `home de test inattendu : ${ROOKS_HOME}`,
  );
});

test('sans ROOKS_HOME, le runner refuse de charger paths.ts', () => {
  const r = probe({ ROOKS_HOME: null });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ROOKS_HOME is required/);
});

// public-name-ok: the archive guard refuses it by name
test('ROOKS_HOME=~/.pkos est refusé (home du PKOS quotidien)', () => {
  const r = probe({ ROOKS_HOME: join(homedir(), '.pkos') });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /~\/\.pkos/); // public-name-ok: the refusal names the archive
});

test('ROOKS_HOME=~/.rooks réel est refusé sous le runner', () => {
  const r = probe({ ROOKS_HOME: join(homedir(), '.rooks') });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /the real ~\/\.rooks/);
});
