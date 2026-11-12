/**
 * TIM-0099: a new mission only starts from ANOTHER mission's session when the
 * backend keeps its sessions in a CLI-global store. In `per-mission` (codex,
 * grok) the session lives in the old mission's scratch home, the new one is
 * empty, and codex dies at once with "no rollout found for thread id".
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

const { upsertAgent, resolveSpawnResume } = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { registerDialect, registerProfile } = await import('./backends/registry.js');
const { invalidateSettingsCache } = await import('./settings.js');
const { memoryDialect } = await import('../tests/helpers/example-dialects.js') as {
  memoryDialect: import('./backends/types.js').RemoteDialect;
};

const OWNER = 'spawn-resume-store-test';
invalidateSettingsCache();
const disposers = [
  registerDialect(OWNER, 'memory-global', { ...memoryDialect, id: 'memory-global', sessionStore: 'global' }),
  registerDialect(OWNER, 'memory-per-mission', { ...memoryDialect, id: 'memory-per-mission', sessionStore: 'per-mission' }),
];
for (const id of ['memory-global', 'memory-per-mission']) {
  disposers.push(registerProfile(OWNER, { id, dialect: id, label: id, defaultModel: null, models: [], env: {} }));
}
after(() => { for (const dispose of disposers.reverse()) dispose(); });

/** An agent on `backend` whose previous mission left the session `session`. */
function agentWithPastSession(backend: string): { agent: string; session: string; pastMission: string } {
  const agent = `resume-store-${randomUUID().slice(0, 8)}`;
  upsertAgent({
    name: agent,
    system_prompt: 'You are a witness.',
    config: { backend, cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' },
  });
  const pastMission = randomUUID();
  const session = `sess-${randomUUID()}`;
  dbApi.createMission(pastMission, agent, 'earlier work');
  dbApi.setMissionSession(pastMission, session);
  return { agent, session, pastMission };
}

test('per-mission store: a new mission does not pick up the agent\'s latest session', () => {
  const { agent } = agentWithPastSession('memory-per-mission');
  assert.equal(resolveSpawnResume(agent, randomUUID(), undefined), null);
});

test('per-mission store: an explicit session of another mission is ignored too', () => {
  const { agent, session } = agentWithPastSession('memory-per-mission');
  assert.equal(resolveSpawnResume(agent, randomUUID(), session), null);
});

test('per-mission store: a session of the same mission is kept', () => {
  const { agent, session, pastMission } = agentWithPastSession('memory-per-mission');
  assert.equal(resolveSpawnResume(agent, pastMission, session), session);
});

test('global store: the agent\'s latest session is still resumed', () => {
  const { agent, session } = agentWithPastSession('memory-global');
  assert.equal(resolveSpawnResume(agent, randomUUID(), undefined), session);
  assert.equal(resolveSpawnResume(agent, randomUUID(), session), session);
});

test('explicit null and a backend override still start fresh', () => {
  const { agent } = agentWithPastSession('memory-global');
  assert.equal(resolveSpawnResume(agent, randomUUID(), null), null);
  assert.equal(resolveSpawnResume(agent, randomUUID(), undefined, 'memory-per-mission'), null);
});

test('a cleared session cached by the client, and an unknown session, are refused', () => {
  const { agent, session, pastMission } = agentWithPastSession('memory-global');
  dbApi.clearMissionSession(pastMission);
  assert.equal(resolveSpawnResume(agent, randomUUID(), session), null);
  assert.equal(resolveSpawnResume(agent, randomUUID(), 'unknown-session'), null);
});

test('neither explicit nor latest session can cross user accounts', () => {
  const { agent, session, pastMission } = agentWithPastSession('memory-global');
  const alice = createTestAccount(dbApi, { email: `${randomUUID()}@test.local`, name: 'Alice', passwordHash: 'unused' });
  const bob = createTestAccount(dbApi, { email: `${randomUUID()}@test.local`, name: 'Bob', passwordHash: 'unused' });
  const foreign = randomUUID();
  dbApi.createMission(foreign, agent, 'private conversation', undefined, bob.id);
  dbApi.setMissionSession(foreign, 'bob-private-session');
  assert.equal(resolveSpawnResume(agent, randomUUID(), 'bob-private-session', undefined, alice.id), null);
  assert.equal(resolveSpawnResume(agent, randomUUID(), undefined, undefined, alice.id), null);
});
