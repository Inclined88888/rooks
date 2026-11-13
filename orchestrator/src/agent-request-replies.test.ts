import { createTestAccount } from '../tests/helpers/accounts.js';
import './test-home.js';
import '../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { db, dbApi } from './db.js';
import { completeRequestReplies, recordRequestDelivery, reconcileRequestReplies, requestDeliveryBatch } from './agent-request-replies.js';
import { sendAgentMessage } from './agent-messages.js';
import { AGENTS_DIR } from './paths.js';
import { originOfDigest } from './user-origin.js';

for (const name of ['sender', 'recipient', 'bystander']) mkdirSync(join(AGENTS_DIR, name), { recursive: true });

function setup(kind: 'request' | 'response' | 'msg' | 'notification' = 'request') {
  const sender = randomUUID(), recipient = randomUUID();
  dbApi.createMission(sender, 'sender', 'question');
  dbApi.createMission(recipient, 'recipient', 'answer');
  const request = dbApi.enqueueMessage({ id: randomUUID(), fromMission: sender, fromAgent: 'sender',
    toAgent: 'recipient', kind, payload: 'What is planned?' });
  const event = dbApi.insertEvent(recipient, 'user', { message: { content: request.payload }, origin: originOfDigest([request]) });
  recordRequestDelivery(recipient, event.id, [request.id]);
  return { sender, recipient, request, event };
}
function answer(mission: string, text: string) {
  dbApi.insertEvent(mission, 'assistant', { message: { content: [{ type: 'text', text }] } });
}
function result(mission: string, fields: Record<string, unknown> = {}) {
  dbApi.insertEvent(mission, 'result', { subtype: 'success', is_error: false, ...fields });
}
function replies(id: string) {
  return dbApi.listAllInbox({ limit: 10000 }).filter((m) => m.in_reply_to === id);
}
function sentBy(recipient: string) {
  return dbApi.listAllInbox({ limit: 10000 }).filter((m) => m.from_mission === recipient && m.to_agent === 'sender');
}
function freeSend(recipient: string, over: { toAgent?: string; kind?: 'msg' | 'request' | 'response' | 'notification' } = {}) {
  return sendAgentMessage({ id: randomUUID(), fromMission: recipient, fromAgent: 'recipient',
    toAgent: over.toAgent ?? 'sender', kind: over.kind ?? 'msg', payload: 'Answer sent by hand', inReplyTo: null, toMission: null });
}

test('plain final text returns to the exact initiating mission without an explicit reply tool', () => {
  const { sender, recipient, request } = setup();
  answer(recipient, 'No tasks tonight.');
  completeRequestReplies(recipient);
  assert.equal(replies(request.id).length, 0, 'streaming is not a completed answer');
  result(recipient);
  completeRequestReplies(recipient);
  const [reply] = replies(request.id);
  assert.equal(reply?.payload, 'No tasks tonight.');
  assert.equal(reply?.to_mission, sender);
  assert.equal(reply?.from_mission, recipient);
  assert.equal(reply?.kind, 'response');
  assert.equal(reply?.status, 'pending');
});

test('duplicate completion and restart reconciliation produce one durable response', () => {
  const { recipient, request } = setup();
  result(recipient, { result: 'Direct result text' });
  reconcileRequestReplies();
  completeRequestReplies(recipient);
  reconcileRequestReplies();
  assert.equal(replies(request.id).length, 1);
  assert.equal(replies(request.id)[0]?.payload, 'Direct result text');
});

test('an explicit response suppresses the automatic fallback', () => {
  const { sender, recipient, request } = setup();
  dbApi.enqueueMessage({ id: randomUUID(), fromMission: recipient, fromAgent: 'recipient', toAgent: 'sender',
    toMission: sender, kind: 'response', inReplyTo: request.id, payload: 'Explicit answer' });
  result(recipient, { result: 'Summary in recipient chat' });
  completeRequestReplies(recipient);
  assert.equal(replies(request.id).length, 1);
  assert.equal(replies(request.id)[0]?.payload, 'Explicit answer');
});

test('responses and notifications never trigger another automatic response', () => {
  for (const kind of ['response', 'notification', 'msg'] as const) {
    const { recipient, request } = setup(kind);
    result(recipient, { result: 'Acknowledged' });
    completeRequestReplies(recipient);
    assert.equal(replies(request.id).length, 0);
  }
});

test('requests are isolated from each other and unrelated messages in delivery batches', () => {
  const one = setup(), two = setup(), msg = setup('msg');
  assert.deepEqual(requestDeliveryBatch([msg.request, one.request, two.request]), [one.request]);
  result(one.recipient, { result: 'Answer one' });
  result(two.recipient, { result: 'Answer two' });
  completeRequestReplies(one.recipient); completeRequestReplies(two.recipient);
  assert.equal(replies(one.request.id)[0]?.payload, 'Answer one');
  assert.equal(replies(two.request.id)[0]?.payload, 'Answer two');
});

test('tool output, nested agent output and old turns cannot become the final answer', () => {
  const { recipient, request } = setup();
  answer(recipient, 'Root answer');
  dbApi.insertEvent(recipient, 'assistant', { parent_tool_use_id: 'child', message: { content: 'Nested secret' } });
  dbApi.insertEvent(recipient, 'user', { message: { content: [{ type: 'tool_result', content: 'Tool secret' }] } });
  result(recipient);
  completeRequestReplies(recipient);
  assert.equal(replies(request.id)[0]?.payload, 'Root answer');
});

test('a later human turn cannot answer an interrupted request', () => {
  const { recipient, request } = setup();
  dbApi.insertEvent(recipient, 'user', { message: { content: 'Unrelated private question' } });
  result(recipient, { result: 'Private answer' });
  completeRequestReplies(recipient);
  assert.match(replies(request.id)[0]!.payload, /interrupted/);
  assert.ok(!replies(request.id)[0]!.payload.includes('Private'));
});

test('failed and empty turns return an explicit outcome instead of disappearing', () => {
  for (const fields of [{ is_error: true, result: 'Partial text' }, {}]) {
    const { recipient, request } = setup();
    result(recipient, fields);
    completeRequestReplies(recipient);
    assert.match(replies(request.id)[0]!.payload, /failed|without a text response/);
  }
  const { recipient, request } = setup();
  answer(recipient, 'Unfinished reasoning');
  dbApi.finishMission(recipient, 'failed', 1);
  reconcileRequestReplies();
  assert.match(replies(request.id)[0]!.payload, /mission failed/);
});

test('delivery cannot be attached to another agent, owner or target mission', () => {
  const { recipient, request, event } = setup();
  db.prepare('DELETE FROM agent_request_deliveries WHERE request_id = ?').run(request.id);
  const wrong = randomUUID(); dbApi.createMission(wrong, 'other', 'other');
  recordRequestDelivery(wrong, event.id, [request.id]);
  assert.equal(db.prepare('SELECT 1 FROM agent_request_deliveries WHERE request_id = ?').get(request.id), undefined);
  const user = createTestAccount(dbApi, { email: `${randomUUID()}@test.local`, name: 'Other', passwordHash: 'x' });
  db.prepare('UPDATE missions SET owner_user_id = ? WHERE id = ?').run(user.id, recipient);
  recordRequestDelivery(recipient, event.id, [request.id]);
  assert.equal(db.prepare('SELECT 1 FROM agent_request_deliveries WHERE request_id = ?').get(request.id), undefined);
});

test('two successive requests in the same mission keep their own turn boundaries', () => {
  const { recipient, sender, request } = setup();
  result(recipient, { result: 'First answer' });
  const second = dbApi.enqueueMessage({ id: randomUUID(), fromMission: sender, fromAgent: 'sender',
    toAgent: 'recipient', kind: 'request', payload: 'Second question' });
  const input = dbApi.insertEvent(recipient, 'user', { message: { content: second.payload } });
  recordRequestDelivery(recipient, input.id, [second.id]);
  result(recipient, { result: 'Second answer' });
  reconcileRequestReplies();
  assert.equal(replies(request.id)[0]!.payload, 'First answer');
  assert.equal(replies(second.id)[0]!.payload, 'Second answer');
});

test('non-request digests are partitioned by owner', () => {
  const one = setup('notification').request, two = setup('notification').request;
  two.owner_user_id = 'another-owner';
  assert.deepEqual(requestDeliveryBatch([one, two]), [one]);
});

test('an uncorrelated message to the requester does not suppress the automatic reply', () => {
  const { recipient, request } = setup();
  for (const kind of ['msg', 'response'] as const) {
    dbApi.enqueueMessage({ id: randomUUID(), fromMission: recipient, fromAgent: 'recipient', toAgent: 'sender',
      kind, payload: 'Free-form answer' });
  }
  result(recipient, { result: 'Summary in recipient chat' });
  completeRequestReplies(recipient);
  assert.deepEqual(replies(request.id).map((m) => m.payload), ['Summary in recipient chat'],
    'an uncorrelated message never wakes the requester: only the automatic reply answers it');
  const receipt = db.prepare('SELECT settled_at FROM agent_request_deliveries WHERE request_id = ?')
    .get(request.id) as { settled_at: number | null };
  assert.notEqual(receipt.settled_at, null);
});

test('a free-form answer to two open requests still returns an automatic reply for each', () => {
  const { sender, recipient, request } = setup();
  const second = dbApi.enqueueMessage({ id: randomUUID(), fromMission: sender, fromAgent: 'sender',
    toAgent: 'recipient', kind: 'request', payload: 'Another question' });
  recordRequestDelivery(recipient, dbApi.insertEvent(recipient, 'user', { message: { content: [] } }).id, [second.id]);
  assert.equal(freeSend(recipient).in_reply_to, null, 'ambiguous: left uncorrelated');
  result(recipient, { result: 'Both answered' });
  completeRequestReplies(recipient);
  assert.equal(replies(request.id).length, 1);
  assert.equal(replies(second.id).length, 1);
  assert.equal(dbApi.getMessage(`request-reply:${request.id}`)?.kind, 'response');
  assert.equal(dbApi.getMessage(`request-reply:${second.id}`)?.to_mission, sender);
});

test('a free-form message to the requester is correlated to the open request', () => {
  const { sender, recipient, request } = setup();
  const sent = freeSend(recipient);
  assert.equal(sent.kind, 'response');
  assert.equal(sent.in_reply_to, request.id);
  assert.equal(sent.to_mission, sender);
  result(recipient, { result: 'Summary in recipient chat' });
  completeRequestReplies(recipient);
  reconcileRequestReplies();
  assert.deepEqual(replies(request.id).map((m) => m.payload), ['Answer sent by hand']);
  assert.equal(sentBy(recipient).length, 1, 'one request, one message, one wake');
});

test('ambiguous, settled or unrelated sends stay uncorrelated', () => {
  const { sender, recipient, request } = setup();
  const second = dbApi.enqueueMessage({ id: randomUUID(), fromMission: sender, fromAgent: 'sender',
    toAgent: 'recipient', kind: 'request', payload: 'Another question' });
  recordRequestDelivery(recipient, dbApi.insertEvent(recipient, 'user', { message: { content: [] } }).id, [second.id]);
  assert.equal(freeSend(recipient).in_reply_to, null, 'two open requests from one agent are ambiguous');
  assert.equal(freeSend(recipient, { toAgent: 'bystander' }).in_reply_to, null);
  assert.equal(freeSend(recipient, { kind: 'notification' }).in_reply_to, null);
  db.prepare('UPDATE agent_request_deliveries SET settled_at = 1 WHERE request_id IN (?, ?)').run(request.id, second.id);
  assert.equal(freeSend(recipient).in_reply_to, null, 'a settled request is no longer open');
});

test('counter-requests, other recipients and earlier messages keep the automatic reply', () => {
  for (const kind of ['request', 'notification'] as const) {
    const { recipient, request } = setup();
    freeSend(recipient, { kind });
    result(recipient, { result: 'Real answer' });
    completeRequestReplies(recipient);
    assert.equal(replies(request.id)[0]?.payload, 'Real answer', kind);
  }
  const other = setup();
  freeSend(other.recipient, { toAgent: 'bystander' });
  result(other.recipient, { result: 'Real answer' });
  completeRequestReplies(other.recipient);
  assert.equal(replies(other.request.id)[0]?.payload, 'Real answer');
  const earlier = setup();
  const before = dbApi.enqueueMessage({ id: randomUUID(), fromMission: earlier.recipient, fromAgent: 'recipient',
    toAgent: 'sender', kind: 'msg', payload: 'Sent in a previous turn' });
  db.prepare('UPDATE agent_messages SET created_at = ? WHERE id = ?').run(earlier.event.timestamp - 1, before.id);
  result(earlier.recipient, { result: 'Real answer' });
  completeRequestReplies(earlier.recipient);
  assert.equal(replies(earlier.request.id)[0]?.payload, 'Real answer');
});

test('no reply while the provider retries, nor while Rooks replays the turn (TODO #459)', () => {
  const { recipient, request } = setup();
  dbApi.insertEvent(recipient, 'provider_retry', { type: 'provider_retry', attempt: 2, max: 5, cause: 'websocket closed', delay_ms: null, kind: 'transport' });
  completeRequestReplies(recipient);
  assert.equal(replies(request.id).length, 0, 'a provider retry is no turn end');
  const failure = { cause: 'stream disconnected', provider_retries: 5, provider_max: 5, rooks_retries: 0, rooks_max: 3 };
  result(recipient, { subtype: 'error', is_error: true, error: 'stream disconnected', transient_failure: failure,
    rooks_retry: { attempt: 1, max: 3, delay_ms: 30000 } });
  completeRequestReplies(recipient);
  assert.equal(replies(request.id).length, 0, 'the turn is being replayed');
  dbApi.insertEvent(recipient, 'user', { message: { content: 'Your previous turn was cut…' },
    origin: { kind: 'system', from: 'orchestrator', turn_retry: 1 } });
  answer(recipient, 'Three tasks tonight.');
  result(recipient);
  completeRequestReplies(recipient);
  assert.equal(replies(request.id)[0]?.payload, 'Three tasks tonight.');
});

test('a transient failure Rooks could not cure says so, with both layers of retries', () => {
  const { recipient, request } = setup();
  const failure = { cause: 'stream disconnected', provider_retries: 5, provider_max: 5, rooks_retries: 3, rooks_max: 3 };
  result(recipient, { subtype: 'error', is_error: true, error: 'stream disconnected', transient_failure: failure });
  completeRequestReplies(recipient);
  assert.match(replies(request.id)[0]?.payload ?? '',
    /unreachable \(transient\) after 5 provider retries \+ 3 Rooks retries — retry later/);
});

test('a replay that never ran ends the request on its transient failure', () => {
  const { recipient, request } = setup();
  const failure = { cause: 'ECONNRESET', provider_retries: 0, provider_max: null, rooks_retries: 0, rooks_max: 3 };
  result(recipient, { subtype: 'error', is_error: true, error: 'ECONNRESET', transient_failure: failure,
    rooks_retry: { attempt: 1, max: 3, delay_ms: 30000 } });
  dbApi.insertEvent(recipient, 'turn_retry_abandoned', { type: 'turn_retry_abandoned', reason: 'stopped by the user' });
  completeRequestReplies(recipient, 'failed');
  assert.match(replies(request.id)[0]?.payload ?? '', /unreachable \(transient\)/);
});
