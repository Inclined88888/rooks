/**
 * A reply names an earlier message of the same conversation (`reply-to.ts`).
 * The contract: the agent reads an excerpt and the event id, never the whole
 * message; a row of another mission, or a bubble that is not a message, is not
 * a target; the read route and the send route refuse what the caller may not
 * see, before anything is written.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import express from 'express';

const { dbApi } = await import('./db.js');
const { registerRoutes } = await import('./plugins-bundled/missions/routes.js');
const {
  excerptOf, findReplyTarget, messageTextOf, replyPart, resolveReplyTo, REPLY_EXCERPT_CHARS, REPLY_PART_LABEL,
} = await import('./reply-to.js');
const { composeChatTurn } = await import('./chat-attachments.js');

const owner = randomUUID();
const stranger = randomUUID();

function assistant(missionId: string, text: string): number {
  return dbApi.insertEvent(missionId, 'assistant', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
  }).id;
}

async function serve(actorId: string, run: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = { kind: 'api-token', isSuperadmin: false, actorId, permissions: ['missions:read', 'missions:spawn'] };
    next();
  });
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test('the excerpt is one line, cut at a word, and never the whole of a long message', () => {
  assert.equal(excerptOf('  short\n\n message  '), 'short message');
  const long = 'word '.repeat(200);
  const cut = excerptOf(long);
  assert.ok(cut.length <= REPLY_EXCERPT_CHARS + 1, 'bounded');
  assert.ok(cut.endsWith('…'));
  assert.ok(!cut.includes('\n'));
});

test('the text of a bubble: the agent text blocks, or what the human wrote without the instructions around it', () => {
  const agentPayload = JSON.stringify({ message: { content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use' }, { type: 'text', text: 'there' }] } });
  assert.equal(messageTextOf('assistant', agentPayload), 'Hello\n\nthere');
  const userPayload = JSON.stringify({
    message: { content: '<reply-to event="3">x</reply-to>\nskill body\nmy words' },
    origin: { presentation: { parts: [{ kind: 'instruction', text: 'skill body' }, { kind: 'text', text: 'my words' }] } },
  });
  assert.equal(messageTextOf('user', userPayload), 'my words');
  const plainReply = JSON.stringify({ message: { content: '<reply-to event="3">\nquoted\n</reply-to>\nthe answer' } });
  assert.equal(messageTextOf('user', plainReply), 'the answer', 'a reply header is not the human\'s words');
  assert.equal(messageTextOf('assistant', '{broken'), '');
});

test('a target lives in the same mission and is a message, nothing else', () => {
  const mission = randomUUID();
  const other = randomUUID();
  dbApi.createMission(mission, 'reply.agent', 'a conversation', undefined, owner);
  dbApi.createMission(other, 'reply.agent', 'another', undefined, owner);
  const id = assistant(mission, 'The plan has three steps.');
  const result = dbApi.insertEvent(mission, 'result', { type: 'result' }).id;

  const found = findReplyTarget(mission, id);
  assert.deepEqual({ ...found, timestamp: 0 }, { event_id: id, role: 'agent', timestamp: 0, text: 'The plan has three steps.' });
  assert.equal(findReplyTarget(other, id), null, 'another mission\'s row is not found');
  assert.equal(findReplyTarget(mission, result), null, 'a result row is not a message');

  for (const raw of [{ event_id: -1 }, { event_id: 'x' }, { event_id: 1, extra: true }, 'id']) {
    const resolved = resolveReplyTo(mission, raw);
    assert.equal(resolved.ok, false);
    if (!resolved.ok) assert.equal(resolved.status, 400);
  }
  const missing = resolveReplyTo(other, { event_id: id });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, 'reply_target_not_found');
  assert.deepEqual(resolveReplyTo(mission, undefined), { ok: true, target: null });
});

test('the agent reads an excerpt and the event id ahead of the message, the thread gets an attachment', () => {
  const target = { event_id: 42, role: 'agent' as const, timestamp: 1, text: `Opening words. ${'detail '.repeat(100)}` };
  const turn = composeChatTurn({ expanded: 'Yes, do it' }, [], undefined, undefined, target);
  assert.ok(turn.text.startsWith('<reply-to event="42">'));
  assert.ok(turn.text.endsWith('Yes, do it'));
  assert.ok(!turn.text.includes('detail '.repeat(40)), 'the whole message is not copied');
  assert.match(turn.text, /mission_message_get/);
  assert.equal(turn.presentation?.parts[0]?.label, REPLY_PART_LABEL);
  assert.deepEqual(turn.presentation?.parts.slice(1), [{ kind: 'text', text: 'Yes, do it' }]);
  assert.deepEqual(turn.presentation?.attachments, [{ type: 'reply', event_id: 42, role: 'agent', excerpt: excerptOf(target.text) }]);
  assert.equal(replyPart(target).kind, 'instruction');
});

test('a reply heads a skill without merging into its instruction', () => {
  const target = { event_id: 7, role: 'user' as const, timestamp: 1, text: 'earlier' };
  const slash = { expanded: 'SKILL do it', presentation: { version: 1 as const, parts: [{ kind: 'instruction' as const, text: 'SKILL ', label: 'skill' }, { kind: 'text' as const, text: 'do it' }] } };
  const turn = composeChatTurn(slash, [], undefined, undefined, target);
  assert.deepEqual(turn.presentation?.parts.map((p) => p.label ?? p.kind), [REPLY_PART_LABEL, 'skill', 'text']);
});

test('GET …/messages/:eventId reads a message of a visible mission only', async () => {
  const mission = randomUUID();
  const other = randomUUID();
  const foreign = randomUUID();
  dbApi.createMission(mission, 'reply.agent', 'mine', undefined, owner);
  dbApi.createMission(other, 'reply.agent', 'also mine', undefined, owner);
  dbApi.createMission(foreign, 'reply.agent', 'not mine', undefined, stranger);
  const id = assistant(mission, 'Full text of the earlier answer.');
  const foreignId = assistant(foreign, 'Someone else\'s answer.');

  await serve(owner, async (base) => {
    const ok = await fetch(`${base}/api/missions/${mission}/messages/${id}`);
    assert.equal(ok.status, 200);
    const body = await ok.json() as Record<string, unknown>;
    assert.equal(body.text, 'Full text of the earlier answer.');
    assert.equal(body.role, 'agent');
    assert.equal((await fetch(`${base}/api/missions/${other}/messages/${id}`)).status, 404, 'not this mission\'s row');
    assert.equal((await fetch(`${base}/api/missions/${foreign}/messages/${foreignId}`)).status, 404, 'another owner\'s mission');
    assert.equal((await fetch(`${base}/api/missions/${mission}/messages/abc`)).status, 400);
  });
});

test('send and steer refuse a reply to a message the mission does not hold, writing nothing', async () => {
  const mission = randomUUID();
  const other = randomUUID();
  dbApi.createMission(mission, 'reply.agent', 'mine', undefined, owner);
  dbApi.createMission(other, 'reply.agent', 'also mine', undefined, owner);
  const elsewhere = assistant(other, 'In the other conversation.');
  const before = dbApi.listEvents(mission).length;

  await serve(owner, async (base) => {
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const sent = await post(`/api/agents/${mission}/send`, { input: 'yes', reply_to: { event_id: elsewhere } });
    assert.equal(sent.status, 422, 'never a 404: the composer reads it as a dead mission');
    assert.equal(((await sent.json()) as { code?: string }).code, 'reply_target_not_found');
    assert.equal((await post(`/api/agents/${mission}/send`, { input: 'yes', reply_to: { event_id: 'x' } })).status, 400);
    const steered = await post(`/api/missions/${mission}/steer`, { input: 'go', reply_to: { event_id: elsewhere } });
    assert.equal(steered.status, 422);
  });
  assert.equal(dbApi.listEvents(mission).length, before, 'nothing was written to the conversation');
});
