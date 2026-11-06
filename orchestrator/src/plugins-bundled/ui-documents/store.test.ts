/**
 * The `ui_documents` table (ADR-MCPUI D2): masked at write time, settled
 * once, counted per mission for the caps, purged by mission only.
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { dbApi } = await import('../../db.js');
const { setRedactionSource } = await import('../../secrets/redact.js');

const SECRET = 'sk-live-ui-document-secret-0001';

function insert(missionId: string, over: Partial<Parameters<typeof dbApi.insertUiDocument>[0]> = {}) {
  return dbApi.insertUiDocument({
    id: randomUUID(), mission_id: missionId, owner_user_id: 'u-owner', origin_kind: 'agent', origin_id: 'timon.coder',
    title: 'Pick one', html: '<p>hello</p>', bridge: 'timon', height: null, expects_reply: 0,
    ref_provider: null, ref: null, project: null, mission_title: 'm', task_id: null, ...over,
  });
}

test('title, HTML and reply are masked before storage', () => {
  const previous = setRedactionSource(() => [SECRET]);
  try {
    const row = insert('m-mask', { title: `token ${SECRET}`, html: `<p>${SECRET}</p>`, expects_reply: 1 });
    assert.equal(row.status, 'pending');
    assert.ok(!row.title.includes(SECRET) && !row.html.includes(SECRET));
    assert.ok(dbApi.settleUiDocument(row.id, { status: 'answered', reply: JSON.stringify({ k: SECRET }), resolvedByKind: 'user', resolvedById: 'u-owner' }));
    assert.ok(!dbApi.getUiDocument(row.id)!.reply!.includes(SECRET));
  } finally {
    setRedactionSource(previous);
  }
});

test('a document is settled once; answered needs a pending one', () => {
  const shown = insert('m-settle');
  assert.equal(shown.status, 'shown');
  assert.equal(dbApi.settleUiDocument(shown.id, { status: 'answered', reply: '{}', resolvedByKind: 'user', resolvedById: 'u' }), false);
  assert.equal(dbApi.settleUiDocument(shown.id, { status: 'dismissed', resolvedByKind: 'agent', resolvedById: 'a' }), true);
  assert.equal(dbApi.settleUiDocument(shown.id, { status: 'dismissed', resolvedByKind: 'agent', resolvedById: 'a' }), false);
  const row = dbApi.getUiDocument(shown.id)!;
  assert.equal(row.status, 'dismissed');
  assert.equal(row.resolved_by_kind, 'agent');
  assert.ok(row.resolved_at);
});

test('counts per mission, pending apart', () => {
  insert('m-count');
  insert('m-count', { expects_reply: 1 });
  assert.deepEqual(dbApi.countUiDocuments('m-count'), { total: 2, pending: 1 });
  assert.deepEqual(dbApi.countUiDocuments('m-none'), { total: 0, pending: 0 });
});

test('a reference is unique per plugin, found by its plugin only', () => {
  insert('m-ref', { origin_kind: 'plugin', origin_id: 'acme', ref_provider: 'github', ref: '42' });
  assert.throws(() => insert('m-ref', { origin_kind: 'plugin', origin_id: 'acme', ref_provider: 'github', ref: '42' }));
  insert('m-ref', { origin_kind: 'plugin', origin_id: 'other', ref_provider: 'github', ref: '42' });
  assert.equal(dbApi.findUiDocumentByRef('acme', 'github', '42')?.origin_id, 'acme');
  assert.equal(dbApi.findUiDocumentByRef('nobody', 'github', '42'), undefined);
});

test('the purge removes whole missions the caller lets go, and nothing else', () => {
  const kept = insert('m-live');
  const gone = insert('m-old');
  const removed = dbApi.purgeUiDocuments((missionId) => missionId === 'm-old');
  assert.deepEqual(removed.map((r) => r.id), [gone.id]);
  assert.ok(!('html' in removed[0]!));
  assert.ok(dbApi.getUiDocument(kept.id));
  assert.equal(dbApi.getUiDocument(gone.id), undefined);
});
