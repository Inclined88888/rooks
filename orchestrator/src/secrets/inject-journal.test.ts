/**
 * Inject journal at spawn (SECRETS-VAULT.md §8, invariant §12.8).
 *
 * `recordSecretAccess(kind: 'inject')` existed since S.8; its call site is the
 * spawn, not `missionEnv` — that function is exercised by tests that must not
 * fill `secret_access`. A fake host (spawn does not run a CLI) is enough to
 * observe the journal and the child env.
 */
import '../test-home.js';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { getHost } = await import('../host/index.js');
await import('../../tests/helpers/claude-provider.js');

const { spawnAgent, upsertAgent, missionEnv } = await import('../agent.js');
const { dbApi } = await import('../db.js');
const { seal } = await import('./box.js');
const { resolveMasterKey } = await import('./key.js');

type FakeChild = ChildProcessWithoutNullStreams & { killed: boolean };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    child.killed = true;
    child.emit('exit', 0, signal ?? null);
    child.emit('close', 0, signal ?? null);
    return true;
  }) as ChildProcessWithoutNullStreams['kill'];
  return child;
}

const HTTP_SPEC = JSON.stringify({
  type: 'http',
  hosts: ['example.invalid'],
  inject: { kind: 'header', name: 'X', template: '{{value}}' },
});

function putSecret(name: string, value: string, mode: 'inject' | 'broker' = 'inject'): string {
  const key = resolveMasterKey();
  const row = dbApi.createSecret({
    name,
    value_enc: 'placeholder',
    mode,
    ...(mode === 'broker' ? { broker_spec: HTTP_SPEC } : {}),
  });
  dbApi.updateSecret(row.id, { value_enc: seal(value, key, { secretId: row.id, name }) });
  return row.id;
}

function injectLines(secretId: string) {
  return dbApi.listSecretAccess(secretId).filter((r) => r.kind === 'inject');
}

function upsertWitness(name: string): void {
  upsertAgent({
    name,
    system_prompt: 'inject-journal witness — does nothing.',
    config: {
      backend: 'claude',
      cwd: tmpdir(),
      skills: [],
      mcp_servers: [],
      memory_scope: 'NONE',
    },
  });
}

async function spawnWithFake(agentName: string): Promise<{
  missionId: string;
  env: NodeJS.ProcessEnv;
}> {
  const host = getHost();
  const original = host.spawn;
  const calls: { env: NodeJS.ProcessEnv }[] = [];
  const children: FakeChild[] = [];
  host.spawn = ((cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    const child = fakeChild();
    children.push(child);
    calls.push({ env: (opts?.env ?? {}) as NodeJS.ProcessEnv });
    return child;
  }) as typeof host.spawn;
  try {
    const missionId = await spawnAgent(agentName, 'ping');
    assert.equal(calls.length, 1, 'one spawn, via the host');
    return { missionId, env: calls[0]!.env };
  } finally {
    host.spawn = original;
    for (const child of children) {
      if (!child.killed) child.kill();
    }
  }
}

test('missionEnv does not write the access journal', () => {
  const id = putSecret('JOURNAL_WITNESS', 'valeur-temoin-assez-longue');
  dbApi.addSecretGrant(id, 'agent', 'witness');
  const env = missionEnv({ missionId: 'm-no-journal', agentName: 'witness', cwd: tmpdir() });
  assert.equal(env.JOURNAL_WITNESS, 'valeur-temoin-assez-longue');
  assert.equal(injectLines(id).length, 0);
});

// `host.spawn` is process-global: the three spawn tests must not overlap.
describe('inject journal at spawn', { concurrency: 1 }, () => {
  test('a spawn with two injected secrets writes two kind=inject lines', async () => {
    const a = putSecret('INJECT_A', 'valeur-a-secrete');
    const b = putSecret('INJECT_B', 'valeur-b-secrete');
    dbApi.addSecretGrant(a, 'agent', 'inject-two');
    dbApi.addSecretGrant(b, 'agent', 'inject-two');
    upsertWitness('inject-two');

    const { missionId, env } = await spawnWithFake('inject-two');
    assert.equal(env.INJECT_A, 'valeur-a-secrete');
    assert.equal(env.INJECT_B, 'valeur-b-secrete');

    const linesA = injectLines(a).filter((r) => r.mission_id === missionId);
    const linesB = injectLines(b).filter((r) => r.mission_id === missionId);
    assert.equal(linesA.length, 1);
    assert.equal(linesB.length, 1);
    assert.equal(linesA[0]?.agent, 'inject-two');
    assert.equal(linesB[0]?.agent, 'inject-two');
    assert.equal(linesA[0]?.name, 'INJECT_A');
    assert.equal(linesB[0]?.name, 'INJECT_B');
    assert.equal(linesA[0]?.outcome, 'ok');
    assert.equal(linesB[0]?.outcome, 'ok');
    const dumped = JSON.stringify([...linesA, ...linesB]);
    assert.equal(dumped.includes('valeur-a-secrete'), false);
    assert.equal(dumped.includes('valeur-b-secrete'), false);
    assert.equal(Object.keys(linesA[0]!).includes('value'), false);
  });

  test('a spawn that resolves no secret writes no journal line', async () => {
    const orphan = putSecret('ORPHAN_NO_GRANT', 'jamais-injecte');
    upsertWitness('inject-none');
    const { missionId, env } = await spawnWithFake('inject-none');
    assert.equal(env.ORPHAN_NO_GRANT, undefined);
    assert.equal(
      dbApi.listSecrets()
        .flatMap((s) => dbApi.listSecretAccess(s.id))
        .filter((r) => r.kind === 'inject' && r.mission_id === missionId)
        .length,
      0,
    );
    assert.equal(injectLines(orphan).length, 0);
  });

  test('a granted broker secret produces no inject line', async () => {
    const id = putSecret('BROKER_AT_SPAWN', 'ne-sort-pas-non-plus', 'broker');
    dbApi.addSecretGrant(id, 'agent', 'inject-broker');
    upsertWitness('inject-broker');
    const { missionId, env } = await spawnWithFake('inject-broker');
    assert.equal(env.BROKER_AT_SPAWN, undefined);
    assert.equal(
      dbApi.listSecretAccess(id).filter((r) => r.kind === 'inject' && r.mission_id === missionId).length,
      0,
    );
    assert.equal(JSON.stringify(env).includes('ne-sort-pas-non-plus'), false);
  });
});
