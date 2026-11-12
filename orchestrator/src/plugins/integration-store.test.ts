import '../test-home.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { IntegrationQueueError, IntegrationStore, RECEIPT_MAX_ATTEMPTS } from './integration-store.js';
import { pruneIntegrationReceipts } from './integration-runtime.js';

const DAY = 86_400_000;

function store(): IntegrationStore {
  const s = new IntegrationStore(join(mkdtempSync(join(tmpdir(), 'integration-store-')), 'integrations.db'));
  s.db.prepare('INSERT INTO connections VALUES (?,?,?,?,?)').run('c1', 'p', 'u', 1, '{}');
  return s;
}

function receipt(s: IntegrationStore, id: string, stage: 'inbox' | 'reply' | 'delivered', createdAt: number): void {
  s.db.prepare('INSERT INTO receipts(id,connection_id,external_id,connection,message,stage,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, 'c1', `ext-${id}`, '{}', '{}', stage, createdAt);
}

const ids = (s: IntegrationStore): string[] =>
  (s.db.prepare('SELECT id FROM receipts ORDER BY id').all() as { id: string }[]).map((r) => r.id);

test('TODO #547: only delivered receipts past the cutoff are dropped, in batches', () => {
  const s = store();
  try {
    const now = 100 * DAY;
    for (let i = 0; i < 5; i++) receipt(s, `old-delivered-${i}`, 'delivered', now - 60 * DAY);
    receipt(s, 'recent-delivered', 'delivered', now - DAY);
    // Months old but never delivered: still owed to its sender.
    receipt(s, 'old-inbox', 'inbox', now - 90 * DAY);
    receipt(s, 'old-reply', 'reply', now - 90 * DAY);
    assert.equal(s.pruneDelivered(now - 30 * DAY, 2), 5);
    assert.deepEqual(ids(s), ['old-inbox', 'old-reply', 'recent-delivered']);
    assert.equal(s.pruneDelivered(now - 30 * DAY), 0);
  } finally {
    s.close();
  }
});

test('TODO #547: the retention setting defaults to 30 days', () => {
  const s = store();
  try {
    const now = 100 * DAY;
    receipt(s, 'a', 'delivered', now - 31 * DAY);
    receipt(s, 'b', 'delivered', now - 29 * DAY);
    assert.equal(pruneIntegrationReceipts(s, now), 1);
    assert.deepEqual(ids(s), ['b']);
  } finally {
    s.close();
  }
});

function claimable(s: IntegrationStore, id: string, attempts = 0): ReturnType<IntegrationStore['claim']> {
  receipt(s, id, 'inbox', 1);
  s.db.prepare('UPDATE receipts SET attempts=? WHERE id=?').run(attempts, id);
  return s.claim('inbox', 2);
}

test('TODO #631: a receipt out of retries leaves the queue and keeps its reason', () => {
  const s = store();
  try {
    const row = claimable(s, 'r', RECEIPT_MAX_ATTEMPTS - 1)!;
    assert.equal(s.defer(row, true, 10, 'provider said no'), true);
    const failed = s.getReceipt('r')!;
    assert.equal(failed.failed_at, 10);
    assert.equal(failed.last_error, 'provider said no');
    assert.equal(s.claim('inbox', Number.MAX_SAFE_INTEGER), undefined);
    assert.deepEqual(s.receiptCounts('c1'), { queued: 0, retrying: 0, failed: 1 });
  } finally {
    s.close();
  }
});

test('TODO #631: a failure below the limit still retries, and a wait never counts', () => {
  const s = store();
  try {
    const row = claimable(s, 'r', RECEIPT_MAX_ATTEMPTS - 2)!;
    assert.equal(s.defer(row, true, 10, 'first'), false);
    assert.equal(s.getReceipt('r')!.failed_at, 0);
    assert.deepEqual(s.receiptCounts('c1'), { queued: 0, retrying: 1, failed: 0 });
    const next = s.claim('inbox', Number.MAX_SAFE_INTEGER - 1)!;
    assert.equal(next.attempts, RECEIPT_MAX_ATTEMPTS - 1);
  } finally {
    s.close();
  }
});

test('TODO #631: a late defer from a lost lease cannot fail a receipt', () => {
  const s = store();
  try {
    const row = claimable(s, 'r', RECEIPT_MAX_ATTEMPTS - 1)!;
    assert.equal(s.defer({ ...row, lease: 'someone-else' }, true, 10, 'late'), false);
    assert.equal(s.getReceipt('r')!.failed_at, 0);
  } finally {
    s.close();
  }
});

test('TODO #631: failed receipts stop counting against the live bound', () => {
  const s = store();
  try {
    const insert = s.db.prepare("INSERT INTO receipts(id,connection_id,external_id,connection,message,failed_at,created_at) VALUES (?,?,?,'{}','{}',1,1)");
    s.db.transaction(() => { for (let i = 0; i < 10_000; i++) insert.run(`f${i}`, 'c1', `f${i}`); })();
    const connection = { id: 'c1', pluginId: 'p', identity: { ownerUserId: 'u' }, transport: 't', agent: 'a', config: {}, secretRefs: {}, enabled: true, revision: 1 };
    s.db.prepare('UPDATE connections SET definition=?').run(JSON.stringify(connection));
    assert.ok(s.accept(connection, { externalId: 'new', text: 'hi', replyContext: null }));
  } finally {
    s.close();
  }
});

test('TODO #631: one connection keeps its newest 1000 failures and cannot evict another', () => {
  const s = store();
  try {
    s.db.prepare('INSERT INTO connections VALUES (?,?,?,?,?)').run('c2', 'p', 'u', 1, '{}');
    s.db.prepare("INSERT INTO receipts(id,connection_id,external_id,connection,message,failed_at,created_at) VALUES ('other','c2','other','{}','{}',1,1)").run();
    const insert = s.db.prepare("INSERT INTO receipts(id,connection_id,external_id,connection,message,failed_at,created_at) VALUES (?,'c1',?,'{}','{}',?,1)");
    s.db.transaction(() => { for (let i = 0; i < 1000; i++) insert.run(`f${i}`, `f${i}`, i + 2); })();
    const row = claimable(s, 'last', RECEIPT_MAX_ATTEMPTS - 1)!;
    assert.equal(s.defer(row, true, 5000, 'gave up'), true);
    assert.equal(s.getReceipt('f0'), undefined);
    assert.ok(s.getReceipt('f1'));
    assert.ok(s.getReceipt('last'));
    assert.ok(s.getReceipt('other'));
    assert.equal(s.receiptCounts('c1').failed, 1000);
  } finally {
    s.close();
  }
});

test('TODO #631: replay resumes at the reached stage, with the retries reset', () => {
  const s = store();
  try {
    receipt(s, 'r', 'reply', 1);
    s.db.prepare("UPDATE receipts SET attempts=295,failed_at=9,mission_id='m1',next_at=9999,last_error='x' WHERE id='r'").run();
    assert.equal(s.replay('r', 100), true);
    const row = s.claim('reply', 100)!;
    assert.equal(row.id, 'r');
    assert.equal(row.mission_id, 'm1');
    assert.equal(row.attempts, 0);
    assert.equal(row.failed_at, 0);
    assert.equal(row.last_error, 'x');
    // Being processed now: a second replay must not hand it to another worker.
    assert.equal(s.replay('r', 101), false);
  } finally {
    s.close();
  }
});

test('TODO #631: replay and discard refuse what has nothing to do', () => {
  const s = store();
  try {
    receipt(s, 'done', 'delivered', 1);
    receipt(s, 'fresh', 'inbox', 1);
    assert.equal(s.replay('done'), false);
    assert.equal(s.replay('fresh'), false);
    assert.equal(s.replay('missing'), false);
    // Still owed to its sender: only a failed receipt can be thrown away.
    assert.equal(s.discardFailed('fresh'), false);
    assert.ok(s.getReceipt('fresh'));
    s.db.prepare("UPDATE receipts SET failed_at=5 WHERE id='fresh'").run();
    assert.equal(s.discardFailed('fresh'), true);
    assert.equal(s.getReceipt('fresh'), undefined);
  } finally {
    s.close();
  }
});

test('TODO #631: replaying a connection refuses to overflow the live bound', () => {
  const s = store();
  try {
    const live = s.db.prepare("INSERT INTO receipts(id,connection_id,external_id,connection,message,created_at) VALUES (?,'c1',?,'{}','{}',1)");
    s.db.transaction(() => { for (let i = 0; i < 9_999; i++) live.run(`l${i}`, `l${i}`); })();
    for (const id of ['a', 'b']) {
      receipt(s, id, 'inbox', 1);
      s.db.prepare('UPDATE receipts SET failed_at=5 WHERE id=?').run(id);
    }
    assert.throws(() => s.replayFailed('c1'), IntegrationQueueError);
    assert.equal(s.receiptCounts('c1').failed, 2);
    s.db.prepare("DELETE FROM receipts WHERE id='l0'").run();
    assert.equal(s.replayFailed('c1', 7), 2);
    assert.equal(s.receiptCounts('c1').failed, 0);
  } finally {
    s.close();
  }
});

test('TODO #631: retention drops failed receipts by their failure date, never live ones', () => {
  const s = store();
  try {
    const now = 100 * DAY;
    receipt(s, 'expired', 'inbox', now - 90 * DAY);
    s.db.prepare('UPDATE receipts SET failed_at=? WHERE id=?').run(now - 31 * DAY, 'expired');
    // Created long ago, failed recently: its owner still has the full window.
    receipt(s, 'recent', 'reply', now - 90 * DAY);
    s.db.prepare('UPDATE receipts SET failed_at=? WHERE id=?').run(now - DAY, 'recent');
    receipt(s, 'live', 'inbox', now - 90 * DAY);
    assert.equal(pruneIntegrationReceipts(s, now), 1);
    assert.deepEqual(ids(s), ['live', 'recent']);
  } finally {
    s.close();
  }
});

test('TODO #631: a database from before the dead-letter opens and keeps its receipts', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'integration-store-')), 'integrations.db');
  const old = new Database(path);
  old.exec(`CREATE TABLE connections (id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, enabled INTEGER NOT NULL, definition TEXT NOT NULL);
    CREATE TABLE receipts (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connections(id),
      external_id TEXT NOT NULL, connection TEXT NOT NULL, message TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'inbox', mission_id TEXT, reply_text TEXT,
      checkpoint TEXT NOT NULL DEFAULT 'null', attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, UNIQUE(connection_id, external_id));
    INSERT INTO connections VALUES ('c1','p','u',1,'{}');
    INSERT INTO receipts(id,connection_id,external_id,connection,message,attempts,created_at) VALUES ('stuck','c1','e','{}','{}',5000,1);`);
  old.close();
  const s = new IntegrationStore(path);
  try {
    // The endless retries of an old install end at its next failure.
    const row = s.claim('inbox', 2)!;
    assert.equal(row.failed_at, 0);
    assert.equal(s.defer(row, true, 3, 'still failing'), true);
    assert.equal(s.getReceipt('stuck')!.failed_at, 3);
  } finally {
    s.close();
  }
});
