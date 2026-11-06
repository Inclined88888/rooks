import { createTestAccount } from '../tests/helpers/accounts.js';
import './test-home.js';
import '../tests/helpers/paid-license.js';
import '../tests/helpers/no-load-gate.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const { getHost } = await import('./host/index.js');
await import('../tests/helpers/claude-provider.js');

const { spawnAgent, upsertAgent } = await import('./agent.js');
const { db, dbApi } = await import('./db.js');
const { sendAgentMessage } = await import('./agent-messages.js');
const { startWake } = await import('./wake.js');

async function until(check: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Roundtrip timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('real wake, input persistence and normalized result route a plain reply into the original chat', { timeout: 20000 }, async () => {
  for (const name of ['questioner', 'respondent']) upsertAgent({ name, system_prompt: 'Test agent.',
    config: { cwd: process.env.TIMON_HOME, backend: 'claude', skills: [], mcp_servers: [], memory_scope: 'NONE' } });
  const host = getHost();
  const original = host.spawn;
  const children = new Map<string, ChildProcessWithoutNullStreams>();
  host.spawn = ((_cmd, _args, options) => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 4242;
    child.kill = () => { child.emit('exit', 0); child.emit('close', 0); return true; };
    children.set(String(options?.env?.TIMON_MISSION_ID), child);
    return child;
  }) as typeof host.spawn;
  let stop: (() => void) | undefined;
  try {
    const owner = createTestAccount(dbApi, { email: 'roundtrip@example.test', name: 'Owner', passwordHash: 'x' });
    const sender = await spawnAgent('questioner', 'Check the schedule.', undefined, { ownerUserId: owner.id });
    const parent = children.get(sender)!;
    const emit = (child: ChildProcessWithoutNullStreams, event: unknown) => child.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
    emit(parent, { type: 'system', subtype: 'init', session_id: 'sender-session' });
    stop = startWake();
    const request = dbApi.enqueueMessage({ id: randomUUID(), fromMission: sender, fromAgent: 'questioner',
      toAgent: 'respondent', kind: 'request', payload: 'Any tasks tonight?' });
    await until(() => dbApi.getMessage(request.id)?.status === 'picked');
    const recipient = dbApi.listMissions(100, ['respondent'])[0]!;
    assert.equal(dbApi.getMission(recipient.id)!.owner_user_id, owner.id);
    const child = children.get(recipient.id)!;
    emit(child, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'No tasks scheduled.' }] } });
    emit(child, { type: 'result', subtype: 'success', is_error: false });
    const responseId = `request-reply:${request.id}`;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(dbApi.getMessage(responseId)?.status, 'pending', 'the busy initiating mission must keep its reply');
    assert.equal(dbApi.listMissions(100, ['questioner']).length, 1, 'busy targets must not fork');
    emit(parent, { type: 'result', subtype: 'success', is_error: false, result: 'Waiting for the answer.' });
    await until(() => dbApi.getMessage(responseId)?.status === 'picked');
    const response = dbApi.getMessage(responseId)!;
    assert.equal(response.to_mission, sender);
    assert.equal(response.owner_user_id, owner.id);
    assert.equal(response.payload, 'No tasks scheduled.');
    assert.equal(dbApi.listMissions(100, ['questioner']).length, 1);
    const incoming = dbApi.listEvents(sender).filter((e) => e.type === 'user').map((e) => JSON.parse(e.payload));
    assert.ok(incoming.some((p) => p.origin?.from === 'respondent' && p.message.content.includes('No tasks scheduled.')));
    emit(parent, { type: 'result', subtype: 'success', is_error: false, result: 'Received.' });
    assert.equal(dbApi.listInbox('respondent').length, 1, 'a response must not create an acknowledgement loop');
    const second = dbApi.enqueueMessage({ id: randomUUID(), fromMission: sender, fromAgent: 'questioner',
      toAgent: 'respondent', kind: 'request', payload: 'And tomorrow?' });
    await until(() => dbApi.getMessage(second.id)?.status === 'picked');
    assert.equal(dbApi.listMissions(100, ['respondent']).length, 1, 'successive requests reuse the idle recipient');
    emit(child, { type: 'result', subtype: 'success', is_error: false, result: 'One task tomorrow.' });
    await until(() => dbApi.getMessage(`request-reply:${second.id}`)?.status === 'picked');
    assert.equal(dbApi.getMessage(`request-reply:${second.id}`)?.payload, 'One task tomorrow.');
    emit(parent, { type: 'result', subtype: 'success', is_error: false, result: 'Noted.' });
    const third = dbApi.enqueueMessage({ id: randomUUID(), fromMission: sender, fromAgent: 'questioner',
      toAgent: 'respondent', kind: 'request', payload: 'Anything else?' });
    await until(() => dbApi.getMessage(third.id)?.status === 'picked');
    // What an agent_send_message call without in_reply_to or to_mission sends.
    const manual = sendAgentMessage({ id: randomUUID(), fromMission: recipient.id, fromAgent: 'respondent',
      toAgent: 'questioner', kind: 'msg', payload: 'Nothing else.', inReplyTo: null, toMission: null });
    assert.equal(manual.in_reply_to, third.id);
    assert.equal(manual.to_mission, sender);
    emit(child, { type: 'result', subtype: 'success', is_error: false, result: 'Told the questioner.' });
    await until(() => dbApi.getMessage(manual.id)?.status === 'picked'
      && (db.prepare('SELECT settled_at FROM agent_request_deliveries WHERE request_id = ?')
        .get(third.id) as { settled_at: number | null }).settled_at !== null);
    assert.equal(dbApi.getMessage(`request-reply:${third.id}`), undefined, 'one request, one answer, one wake');
    assert.equal(dbApi.listMissions(100, ['questioner']).length, 1);
  } finally {
    stop?.();
    for (const child of children.values()) child.kill();
    host.spawn = original;
  }
});
