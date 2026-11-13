/**
 * The registration check: a capability declared without what serves it is
 * refused with the reason, for a plugin of API 11 — and only warned about for the
 * ones written before, whose contract is supported as it was.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'rooks-dialect-check-'));
process.env.ROOKS_HOME = TMP_HOME;
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const { dialectProblems } = await import('./dialect-check.js');
const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();
const { getDialect, registeredBackendOwners } = await import('./registry.js');
const DIALECTS = Object.fromEntries(Object.keys(registeredBackendOwners().dialects).map((id) => [id, getDialect(id)!]));
const { registerDialect } = await import('./registry.js');
const { echoDialect } = await import('../../tests/helpers/example-dialects.js') as { echoDialect: unknown };
const { memoryDialect } = await import('../../tests/helpers/example-dialects.js') as { memoryDialect: unknown };
const { createHermesDialect } = await import('../../../plugins/hermes-gateway/src/driver.js') as {
  createHermesDialect: (deps: never) => unknown;
};

test('every dialect the product ships, both published examples and the Hermes gateway are coherent', () => {
  for (const [id, dialect] of Object.entries(DIALECTS)) assert.deepEqual(dialectProblems(dialect), [], id);
  assert.deepEqual(dialectProblems(echoDialect), [], 'plugin-provider example');
  assert.deepEqual(dialectProblems(memoryDialect), [], 'plugin-remote-backend example');
  // A shipped plugin: if it contradicted itself it would now warn at every load.
  assert.deepEqual(dialectProblems(createHermesDialect({} as never)), [], 'plugins/hermes-gateway');
});

const base = { ...(echoDialect as object) } as Record<string, unknown>;
const problemsOf = (patch: Record<string, unknown>) => dialectProblems({ ...base, ...patch }).join('\n');

test('each declared capability without its member is named', () => {
  assert.match(problemsOf({ permissionModel: 'protocol' }), /needs `openSession`/);
  assert.match(problemsOf({ permissionsByAgent: () => true }), /permissionsByAgent.*protocol/);
  assert.match(problemsOf({ persistentProcess: false, openSession: () => ({}) }), /openSession.*persistentProcess: true/);
  assert.match(problemsOf({ setModel: async () => true }), /setModel.*persistentProcess/);
  // A process per turn that is not resumable ACROSS missions still resumes between two turns of one mission.
  assert.equal(problemsOf({ sessionStore: 'per-mission', sessionResumable: false, isSessionNotFoundError: () => true }), '');
  assert.match(problemsOf({ sessionStore: 'global', sessionResumable: false }), /resumable by construction/);
  assert.match(problemsOf({ persistentProcess: true, finishMissionOnExit: true, sessionResumable: false }), /conversation/);
});

test('the process combinations that describe no provider are refused', () => {
  assert.match(problemsOf({ persistentProcess: true, finishMissionOnExit: false }), /ends the mission when it exits/);
  assert.match(problemsOf({ persistentProcess: false, finishMissionOnExit: true }), /must be false/);
});

test('wrong types and values are named, not guessed', () => {
  assert.match(problemsOf({ sessionStore: 'cloud' }), /sessionStore.*one of 'global', 'per-mission'/);
  assert.match(problemsOf({ permissionModel: 'yolo' }), /permissionModel/);
  assert.match(problemsOf({ rateLimitReporting: 'sometimes' }), /rateLimitReporting/);
  assert.match(problemsOf({ spans: 'yes' }), /`spans` is declared but is not a function/);
  assert.match(problemsOf({ thinkingControls: ['levels', 'telepathy'] }), /thinkingControls/);
  assert.match(problemsOf({ maxPromptBytes: -4 }), /maxPromptBytes/);
  assert.match(problemsOf({ defaultCmd: '' }), /defaultCmd/);
  assert.match(problemsOf({ hostedConnectors: undefined }), /hostedConnectors/);
  assert.match(dialectProblems(null).join(), /object/);
});

test('a remote dialect is checked for what applies to it, and not for a process', () => {
  const remote = { ...(memoryDialect as object) } as Record<string, unknown>;
  assert.deepEqual(dialectProblems(remote), []);
  assert.match(dialectProblems({ ...remote, permissionModel: 'protocol', openSession: undefined }).join(), /openSession/);
  assert.equal(dialectProblems({ ...remote, persistentProcess: undefined }).length, 0, 'no process, nothing to say about one');
});

test('registration: API 11 refuses an incoherent dialect, an older plugin is warned and accepted', () => {
  const bad = { ...base, id: 'check-legacy', permissionModel: 'protocol' } as never;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  try {
    const dispose = registerDialect('tests/legacy', 'check-legacy', bad);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /contradicts itself.*needs `openSession`/);
    dispose();
  } finally {
    console.warn = originalWarn;
  }
  assert.throws(
    () => registerDialect('tests/modern', 'check-modern', { ...base, id: 'check-modern', permissionModel: 'protocol' } as never, { strict: true }),
    /contradicts itself.*openSession/,
  );
  // A coherent dialect registers either way.
  registerDialect('tests/modern', 'check-ok', { ...base, id: 'check-ok' } as never, { strict: true })();
});
