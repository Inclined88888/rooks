/**
 * Output redaction (SECRETS-VAULT.md §7).
 *
 * Two levels, on purpose. The pure filter carries the two guards that make it
 * usable at all — the 12-character threshold and the longest-first ordering —
 * and can be exercised with an injected source. The wiring, on the other hand,
 * is only meaningful through the REAL `dbApi`: the whole point of §7 is that a
 * value is masked *before storage*, and a fake source would prove nothing about
 * whether `insertEvent`, `updateTaskStatus` or `createNotification` actually
 * cross the filter. Same for cache invalidation, which is a property of the
 * vault writers, not of the filter.
 */
// Isolates ROOKS_HOME BEFORE any module touching Rooks state (see test-home.ts).
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  REDACTION_MIN_LENGTH,
  redactDeep,
  redactText,
  redactedValues,
  setRedactionSource,
} from './redact.js';
import { seal } from './box.js';
import { resolveMasterKey } from './key.js';
import { dbApi } from '../db.js';

/** `db.ts` registers the real vault as the source at import time. This swaps in
 *  a fixed list for one case and restores whatever was there — the wiring cases
 *  below need the real one back, and must not have to re-implement it. */
function withValues(values: string[], body: () => void): void {
  const previous = setRedactionSource(() => values);
  try {
    body();
  } finally {
    setRedactionSource(previous);
  }
}

// ── the two guards ─────────────────────────────────────────────────────────

test('a value of 12 characters or more is masked in a transcript', () => {
  withValues(['sk-live-abcdefghijklmnop'], () => {
    const transcript = 'I ran: curl -H "Authorization: Bearer sk-live-abcdefghijklmnop" https://api';
    const out = redactText(transcript);
    assert.ok(!out.includes('sk-live-abcdefghijklmnop'), 'the value survived redaction');
    assert.ok(out.includes('Bearer ***'), out);
  });
});

test('a value of 6 characters is not masked — the threshold protects readability', () => {
  assert.equal(REDACTION_MIN_LENGTH, 12);
  withValues(['secret', 'hunter2'], () => {
    assert.deepEqual(redactedValues(), []);
    const prose = 'the secret is that hunter2 appears in ordinary sentences';
    assert.equal(redactText(prose), prose);
  });
});

test('exactly 12 characters is masked, 11 is not — the boundary is inclusive', () => {
  withValues(['abcdefghijkl', 'ABCDEFGHIJK'], () => {
    assert.deepEqual(redactedValues(), ['abcdefghijkl']);
    assert.equal(redactText('x abcdefghijkl y ABCDEFGHIJK z'), 'x *** y ABCDEFGHIJK z');
  });
});

test('a secret containing another is consumed whole (longest first)', () => {
  withValues(['token-abcdefghij', 'token-abcdefghij-extended-suffix'], () => {
    const out = redactText('value=token-abcdefghij-extended-suffix.');
    assert.equal(out, 'value=***.');
  });
});

// ── structures ─────────────────────────────────────────────────────────────

test('redactDeep masks nested strings and object keys, and returns identity when untouched', () => {
  withValues(['nested-secret-value'], () => {
    const payload = { content: [{ type: 'text', text: 'here: nested-secret-value' }], n: 3 };
    const out = redactDeep(payload);
    assert.equal(JSON.stringify(out).includes('nested-secret-value'), false);
    assert.equal(out.n, 3);

    const clean = { content: [{ type: 'text', text: 'nothing to hide' }] };
    assert.equal(redactDeep(clean), clean, 'an untouched payload must not be rebuilt');

    const keyed = { 'X=nested-secret-value': true };
    assert.deepEqual(redactDeep(keyed), { 'X=***': true });
  });
});

test('an empty vault is a no-op — the hot path allocates nothing', () => {
  withValues([], () => {
    const payload = { text: 'anything at all' };
    assert.equal(redactDeep(payload), payload);
    assert.equal(redactText(payload.text), payload.text);
  });
});

// ── wiring: masked BEFORE storage, through the real vault ───────────────────

/** Store a real secret (sealed with the real master key) and hand back its id. */
function putSecret(name: string, value: string): string {
  const id = randomUUID();
  const key = resolveMasterKey();
  dbApi.createSecret({ id, name, value_enc: seal(value, key, { secretId: id, name }), mode: 'inject' });
  return id;
}

test('writing a secret invalidates the cache: the new value is masked at once', () => {
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'test.agent', 'redaction');

  // Before anything is stored, the transcript keeps the text verbatim — and the
  // cache is now warm on an empty vault, which is exactly the state a stale
  // cache would keep us in.
  dbApi.insertEvent(missionId, 'assistant', { text: 'ROTATING-TOKEN-ONE-000' });
  assert.ok(dbApi.listEvents(missionId)[0].payload.includes('ROTATING-TOKEN-ONE-000'));

  const id = putSecret('ROTATED_TOKEN', 'ROTATING-TOKEN-ONE-000');
  dbApi.insertEvent(missionId, 'assistant', { text: 'still ROTATING-TOKEN-ONE-000 here' });
  const afterCreate = dbApi.listEvents(missionId)[1].payload;
  assert.ok(!afterCreate.includes('ROTATING-TOKEN-ONE-000'), afterCreate);

  // Rotation: the update must invalidate too, otherwise redaction keeps
  // masking the OLD value and lets the fresh one straight through.
  const key = resolveMasterKey();
  dbApi.updateSecret(id, {
    value_enc: seal('ROTATING-TOKEN-TWO-111', key, { secretId: id, name: 'ROTATED_TOKEN' }),
  });
  dbApi.insertEvent(missionId, 'assistant', { text: 'now ROTATING-TOKEN-TWO-111' });
  const afterUpdate = dbApi.listEvents(missionId)[2].payload;
  assert.ok(!afterUpdate.includes('ROTATING-TOKEN-TWO-111'), afterUpdate);

  // Deletion invalidates as well: nothing left to mask.
  dbApi.deleteSecret(id);
  dbApi.insertEvent(missionId, 'assistant', { text: 'gone ROTATING-TOKEN-TWO-111' });
  assert.ok(dbApi.listEvents(missionId)[3].payload.includes('ROTATING-TOKEN-TWO-111'));
});

test("a task's done_comment and a notification body are masked before storage", () => {
  const id = putSecret('REPORT_TOKEN', 'ghp-REPORTED-0123456789');
  try {
    const taskId = randomUUID();
    dbApi.createTask(taskId, 'redaction', 'test.agent');
    dbApi.updateTaskStatus(taskId, 'DONE', {
      doneComment: 'done — used ghp-REPORTED-0123456789 to push',
    });
    const task = dbApi.getTask(taskId)!;
    assert.ok(!task.done_comment!.includes('ghp-REPORTED-0123456789'), task.done_comment!);
    assert.ok(task.done_comment!.includes('used *** to push'), task.done_comment!);

    const notifId = randomUUID();
    const notif = dbApi.createNotification({
      id: notifId,
      type: 'report',
      title: 'token ghp-REPORTED-0123456789 rotated',
      body: 'the old one was ghp-REPORTED-0123456789',
    });
    assert.ok(!notif.title.includes('ghp-REPORTED-0123456789'), notif.title);
    assert.ok(!notif.body!.includes('ghp-REPORTED-0123456789'), notif.body!);
  } finally {
    dbApi.deleteSecret(id);
  }
});

test('a legacy plaintext value (before migration §10.4) is masked too', () => {
  const id = randomUUID();
  dbApi.createSecret({ id, name: 'LEGACY_TOKEN', value_enc: 'plain-legacy-value-42', mode: 'inject' });
  try {
    assert.equal(redactText('carrying plain-legacy-value-42 along'), 'carrying *** along');
  } finally {
    dbApi.deleteSecret(id);
  }
});
