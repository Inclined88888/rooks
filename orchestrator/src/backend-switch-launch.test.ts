import { createTestAccount } from '../tests/helpers/accounts.js';
import './test-home.js';
import '../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const { mountOfficialProviders, stubCodexSignIn } = await import('../tests/helpers/official-providers.js');
await mountOfficialProviders();
await stubCodexSignIn();
const { db, dbApi } = await import('./db.js');
const { getHost } = await import('./host/index.js');
const { upsertAgent, switchMissionBackend, respawnWithResume, isRunning, killAgent, getTurnState } = await import('./agent.js');
const { createBackendAccount } = await import('./backends/accounts.js');
const { launchForMission, missionAccountId } = await import('./backends/account-launch.js');
const { missionScratchPath } = await import('./backends/provider-scratch.js');
const { registerDialect, registerProfile } = await import('./backends/registry.js');
const { memoryDialect } = await import('../tests/helpers/example-dialects.js') as {
  memoryDialect: import('./backends/types.js').RemoteDialect;
};
const { registerRoutes } = await import('./plugins-bundled/missions/routes.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const admin = createTestAccount(dbApi, { email: 'switch@example.test', name: 'Admin', passwordHash: 'x', isSuperadmin: true });
const account = createBackendAccount({ backend: 'claude', name: 'Dry', ownerUserId: admin.id });
const accountBackend = `claude@${account.id}`;
const host = getHost();
const children: ChildProcessWithoutNullStreams[] = [];
const inputs: string[] = [];
const originalSpawn = host.spawn;
let failSpawn: 'throw' | 'event' | null = null;
host.spawn = (() => {
  if (failSpawn === 'throw') throw Object.assign(new Error('Test binary cannot start'), { code: 'ENOENT' });
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null;
  if (failSpawn === 'event') {
    // What node does for a missing binary: no pid, then `error` on a later tick.
    setImmediate(() => child.emit('error', Object.assign(new Error('spawn test-cli ENOENT'), { code: 'ENOENT' })));
    return child;
  }
  child.pid = 4242;
  child.stdin.on('data', (data: Buffer) => inputs.push(data.toString()));
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); return true; };
  children.push(child);
  return child;
}) as typeof host.spawn;
const OWNER = 'backend-switch-test';
const disposers = [
  registerDialect(OWNER, 'memory-remote', memoryDialect),
  registerProfile(OWNER, { id: 'memory-remote-refuses', dialect: 'memory-remote', label: 'refuses', defaultModel: null, models: [], env: { MEMORY_AGENT_FAIL: 'start' } }),
  registerProfile(OWNER, { id: 'memory-remote-plain', dialect: 'memory-remote', label: 'plain', defaultModel: null, models: [], env: {} }),
];
test.after(() => {
  for (const child of children) if (child.exitCode === null) child.kill();
  host.spawn = originalSpawn;
  for (const dispose of disposers.reverse()) dispose();
});

/** What a failed handover must leave untouched, event log aside. */
function missionState(id: string) {
  const { backend_override, model_override, session_id, status, ended_at, exit_code, interrupted_reason, return_notified } = dbApi.getMission(id)!;
  return { backend_override, model_override, session_id, status, ended_at, exit_code, interrupted_reason, return_notified };
}

function fixture() {
  const id = randomUUID();
  const name = `switch-${id.slice(0, 8)}`;
  upsertAgent({ name, system_prompt: 'Test switch.', config: {
    cwd: process.env.TIMON_HOME, backend: 'claude', model: 'sonnet', skills: [], mcp_servers: [], memory_scope: 'NONE',
  } });
  dbApi.createMission(id, name, 'Remember the release plan.', undefined, admin.id);
  dbApi.setMissionLlmOverrides(id, accountBackend, 'sonnet');
  dbApi.setMissionSession(id, 'original-session');
  launchForMission(id, accountBackend, admin.id);
  dbApi.insertEvent(id, 'user', { type: 'user', message: { role: 'user', content: 'Remember the release plan.' } });
  return { id, name };
}

test('an explicit account-to-host switch escapes the old frozen dry account', async () => {
  const { id } = fixture();
  dbApi.setBackendCooldown(accountBackend, Date.now() + 3600_000, 'five_hour', true, 'rate_limit');
  const out = await switchMissionBackend(id, { backend: 'claude', model: 'sonnet', contextMode: 'transcript' });
  assert.equal(out?.backend, 'claude');
  assert.equal(dbApi.getMission(id)!.backend_override, 'claude');
  assert.equal(missionAccountId(id), null);
  assert.equal(isRunning(id), true);
  assert.match(inputs.at(-1)!, /Remember the release plan/);
  const events = dbApi.listEvents(id);
  assert.equal(events.filter((e) => e.type === 'backend_switch').length, 1);
  children.at(-1)!.kill();
});

test('an ordinary resumed turn keeps its frozen account when the agent is repointed', async () => {
  const { id, name } = fixture();
  // The account no longer comes from the row: only the freeze can keep it.
  dbApi.setMissionLlmOverrides(id, null, 'sonnet');
  upsertAgent({ name, system_prompt: 'Test switch.', config: { cwd: process.env.TIMON_HOME, backend: 'claude', model: 'sonnet' } });
  dbApi.clearBackendCooldown(accountBackend);
  await respawnWithResume(id, 'Continue.');
  assert.equal(dbApi.getMission(id)!.backend_override, accountBackend);
  assert.equal(missionAccountId(id), account.id);
  children.at(-1)!.kill();
});

test('a dry target is refused by the route without changing mission, session, freeze or events', async () => {
  const { id } = fixture();
  dbApi.setBackendCooldown('codex', Date.now() + 3600_000, 'five_hour', true, 'rate_limit');
  const before = dbApi.getMission(id);
  const frozen = db.prepare('SELECT * FROM backend_account_missions WHERE mission_id = ?').get(id);
  const events = dbApi.listEvents(id);
  const count = children.length;
  const app = express();
  app.use(createDaemonAuthMiddleware({ token: 'test-token', required: true }));
  app.use(express.json());
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    const url = `http://127.0.0.1:${port}/api/missions/${id}/backend`;
    const anonymous = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backend: 'codex' }) });
    assert.equal(anonymous.status, 401);
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' }, body: JSON.stringify({ backend: 'codex' }) });
    assert.equal(response.status, 429);
    assert.match((await response.json() as { error: string }).error, /codex is out of quota until .*: the conversation stays where it is/);
    assert.deepEqual(dbApi.getMission(id), before);
    assert.deepEqual(db.prepare('SELECT * FROM backend_account_missions WHERE mission_id = ?').get(id), frozen);
    assert.deepEqual(dbApi.listEvents(id), events);
    assert.equal(children.length, count);
  } finally { server.close(); dbApi.clearBackendCooldown('codex'); }
});

test('a failed launch restores the original state and permits another switch', async () => {
  const { id } = fixture();
  dbApi.finishMission(id, 'failed', 1, 'rate_limit');
  const before = missionState(id);
  const frozen = db.prepare('SELECT * FROM backend_account_missions WHERE mission_id = ?').get(id);
  // The session store of the backend being left, as a provider plugin keeps it.
  const scratch = missionScratchPath('provider-codex', id);
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, 'rollout.jsonl'), 'old session');
  failSpawn = 'throw';
  try {
    await assert.rejects(switchMissionBackend(id, { backend: 'codex', contextMode: 'transcript' }), /Test binary cannot start/);
  } finally { failSpawn = null; }
  assert.deepEqual(missionState(id), before);
  assert.deepEqual(db.prepare('SELECT * FROM backend_account_missions WHERE mission_id = ?').get(id), frozen);
  assert.equal(isRunning(id), false);
  assert.equal(existsSync(join(scratch, 'rollout.jsonl')), true, 'the old session stays resumable');
  const events = dbApi.listEvents(id);
  assert.equal(events.filter((e) => e.type === 'backend_switch').length, 0, 'no success card before a turn starts');
  const failure = events.find((e) => e.type === 'backend_switch_failed');
  assert.ok(failure);
  assert.match(failure.payload, /Test binary cannot start/);
  await switchMissionBackend(id, { backend: 'codex', contextMode: 'transcript' });
  assert.equal(dbApi.getMission(id)!.backend_override, 'codex');
  assert.equal(existsSync(join(scratch, 'rollout.jsonl')), false, 'a handover that succeeded drops the old session');
  assert.equal(existsSync(`${scratch}.handover`), false);
  children.at(-1)!.kill();
});

test('a failed launch after stopping a live process leaves a conversation resumable, not a phantom running', async () => {
  const { id } = fixture();
  await respawnWithResume(id, 'Continue.');
  assert.equal(isRunning(id), true);
  // The turn ends and the CLI stays up, idle: the ordinary state of a chat.
  children.at(-1)!.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'original-session' })}\n`);
  for (let i = 0; i < 100 && getTurnState(id)?.turnActive; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const count = children.length;
  failSpawn = 'throw';
  try {
    await assert.rejects(switchMissionBackend(id, { backend: 'codex', contextMode: 'transcript' }), /Test binary cannot start/);
  } finally { failSpawn = null; }
  assert.equal(isRunning(id), false);
  const after = dbApi.getMission(id)!;
  assert.equal(after.status, 'terminated', 'no process runs this mission any more');
  assert.equal(after.interrupted_reason, 'killed');
  assert.equal(after.backend_override, accountBackend);
  assert.equal(after.session_id, 'original-session');
  assert.equal(missionAccountId(id), account.id);
  assert.equal(await respawnWithResume(id, 'Still there?'), true, 'the next message resumes it in place');
  assert.equal(children.length, count + 1);
  assert.equal(dbApi.getMission(id)!.status, 'running');
  children.at(-1)!.kill();
});

test('a binary that only fails on a later tick restores the state too', async () => {
  const { id } = fixture();
  const before = missionState(id);
  failSpawn = 'event';
  try {
    await assert.rejects(switchMissionBackend(id, { backend: 'codex', contextMode: 'transcript' }), /spawn test-cli ENOENT/);
  } finally { failSpawn = null; }
  assert.deepEqual(missionState(id), before);
  assert.equal(isRunning(id), false);
  const events = dbApi.listEvents(id);
  assert.equal(events.filter((e) => e.type === 'backend_switch').length, 0);
  assert.equal(events.filter((e) => e.type === 'backend_switch_failed').length, 1);
});

test('a refused session handshake restores the state and says why in the thread', async () => {
  const { id } = fixture();
  const before = missionState(id);
  await assert.rejects(
    switchMissionBackend(id, { backend: 'memory-remote-refuses', contextMode: 'transcript' }),
    /the agent refused the API key/,
  );
  assert.deepEqual(missionState(id), before);
  assert.equal(isRunning(id), false);
  const events = dbApi.listEvents(id);
  assert.equal(events.filter((e) => e.type === 'backend_switch').length, 0);
  assert.match(events.find((e) => e.type === 'backend_switch_failed')!.payload, /the agent refused the API key/);
});

test('a notice that cannot be written stops the new process and restores the state', async () => {
  const { id } = fixture();
  const before = missionState(id);
  const insertEvent = dbApi.insertEvent;
  dbApi.insertEvent = ((missionId: string, type: string, payload: unknown) => {
    if (type === 'backend_switch') throw new Error('database is locked');
    return insertEvent(missionId, type, payload);
  }) as typeof dbApi.insertEvent;
  try {
    await assert.rejects(switchMissionBackend(id, { backend: 'codex', contextMode: 'transcript' }), /database is locked/);
  } finally { dbApi.insertEvent = insertEvent; }
  assert.deepEqual(missionState(id), before);
  assert.equal(isRunning(id), false);
  assert.notEqual(children.at(-1)!.exitCode, null, 'the process of the abandoned turn is stopped');
});

test('the notice precedes the input and the first words of the new backend', async () => {
  const { id } = fixture();
  await switchMissionBackend(id, {
    backend: 'memory-remote-plain', contextMode: 'transcript', message: 'Keep going.', inputOrigin: null,
  });
  const after = dbApi.listEvents(id).slice(1).map((e) => e.type);
  assert.equal(after[0], 'backend_switch', after.join(', '));
  assert.ok(after.indexOf('user') > 0, after.join(', '));
  await killAgent(id, { source: 'test' });
});

test('a dead pilot repointed by its series fallback leaves the frozen dry account', async () => {
  const { switchSeriesToFallback } = await import('./backend-fallback.js');
  const { setBackendBinaryAvailabilityForTest } = await import('./backends/binary-check.js');
  setBackendBinaryAvailabilityForTest(() => true);
  const { id } = fixture();
  dbApi.finishMission(id, 'failed', 1, 'rate_limit');
  dbApi.createTask(randomUUID(), 'review', 'switch-reviewer', { creatorMissionId: id, type: 'review' });
  const seriesId = dbApi.seriesIdForMission(id)!;
  dbApi.setSeriesFallback(seriesId, 'orchestrator', 'claude', 'sonnet');
  dbApi.setBackendCooldown(accountBackend, Date.now() + 3600_000, 'five_hour', true, 'rate_limit');
  try {
    await switchSeriesToFallback(seriesId, { pilotMissionId: id, ruleScope: 'orchestrator', respawnDeadPilot: false });
  } finally { setBackendBinaryAvailabilityForTest(null); }
  assert.equal(dbApi.getMission(id)!.backend_override, 'claude');
  assert.equal(missionAccountId(id), null, 'the next launch runs on the target, not on the old account');
  assert.equal(launchForMission(id, 'claude', admin.id).backend, 'claude');
  dbApi.clearBackendCooldown(accountBackend);
});
