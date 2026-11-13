/**
 * Sending to a recipient this home does not know must be refused in words.
 * Before the guard, the unknown `from_mission` hit a foreign key and the raw
 * `SqliteError` killed the SENDING mission, while an unknown recipient was
 * stored and never delivered (03/09/2026, dual-home: a name from another home
 * addressed from a sandbox).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-agent-messages-test-'));

const { AGENTS_DIR } = await import('./paths.js');
const { dbApi } = await import('./db.js');
const { sendAgentMessage, UnknownAgentError, UnknownMissionError } =
  await import('./agent-messages.js');

mkdirSync(join(AGENTS_DIR, 'ROOKS.librarian'), { recursive: true });
mkdirSync(join(AGENTS_DIR, '_main'), { recursive: true });
const missionId = randomUUID();
dbApi.createMission(missionId, '_main', 'sender');

function send(over: { toAgent?: string; fromMission?: string }) {
  return sendAgentMessage({
    id: randomUUID(),
    fromMission: over.fromMission ?? missionId,
    fromAgent: '_main',
    toAgent: over.toAgent ?? 'ROOKS.librarian',
    payload: 'hello',
  });
}

test('an unknown recipient is refused by name, not stored', () => {
  const before = dbApi.listInbox('other-home.librarian').length;
  assert.throws(() => send({ toAgent: 'other-home.librarian' }), (err: unknown) => {
    assert.ok(err instanceof UnknownAgentError);
    assert.equal((err as Error).message, 'unknown agent: other-home.librarian');
    return true;
  });
  assert.equal(dbApi.listInbox('other-home.librarian').length, before);
});

test('an unknown sending mission is a typed error, not a SQLite constraint', () => {
  assert.throws(() => send({ fromMission: 'no-such-mission' }), (err: unknown) => {
    assert.ok(err instanceof UnknownMissionError);
    assert.equal((err as Error).message, 'unknown mission: no-such-mission');
    return true;
  });
});

test('a known recipient is delivered under its canonical name', () => {
  const row = send({ toAgent: 'rooks.librarian' });
  assert.equal(row.to_agent, 'ROOKS.librarian');
  assert.ok(dbApi.listInbox('ROOKS.librarian').some((m) => m.id === row.id));
});

test('an explicit correlated reply is always routed to the original sending mission', () => {
  const recipient = randomUUID();
  dbApi.createMission(recipient, 'ROOKS.librarian', 'answer');
  const request = sendAgentMessage({ id: randomUUID(), fromMission: missionId, fromAgent: '_main',
    toAgent: 'ROOKS.librarian', kind: 'request', payload: 'Question' });
  const reply = sendAgentMessage({ id: randomUUID(), fromMission: recipient, fromAgent: 'ROOKS.librarian',
    toAgent: '_main', kind: 'response', inReplyTo: request.id, payload: 'Answer' });
  assert.equal(reply.to_mission, missionId);
  assert.throws(() => sendAgentMessage({ id: randomUUID(), fromMission: recipient, fromAgent: 'ROOKS.librarian',
    toAgent: '_main', kind: 'response', inReplyTo: 'unknown', payload: 'Answer' }), /accessible request/);
});
