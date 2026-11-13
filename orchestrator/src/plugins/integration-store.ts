import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PluginInboundMessage, PluginJsonValue, PluginMessagingConnection } from './integration-types.js';

export class IntegrationQueueError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export type IntegrationReceipt = {
  id: string;
  connection_id: string;
  external_id: string;
  connection: string;
  message: string;
  stage: 'inbox' | 'reply' | 'delivered';
  mission_id: string | null;
  reply_text: string | null;
  checkpoint: string;
  attempts: number;
  next_at: number;
  lease: string | null;
  lease_until: number;
  created_at: number;
  /** When the retries gave up; 0 while the receipt is still in the queue. */
  failed_at: number;
  /** Scrubbed reason of the last failure, for whoever diagnoses it. */
  last_error: string | null;
};
/** A receipt `listTroubled` returns: delivered ones are never in trouble. */
export type TroubledReceipt = IntegrationReceipt & { stage: 'inbox' | 'reply' };
export type IntegrationReceiptCounts = { queued: number; retrying: number; failed: number };
export type IntegrationReceiptStatus = 'failed' | 'retrying';
const retryDelay = (attempts: number) => Math.min(300_000, 1000 * 2 ** Math.min(attempts, 9));
// Longer than the maximum bounded read + transport call (30s + 5min).
const LEASE_MS = 360_000;
/** About 24 h of the delays above: long enough to outlast a provider outage. */
export const RECEIPT_MAX_ATTEMPTS = 295;
const MAX_LIVE_RECEIPTS = 10_000;
// A failed receipt leaves the live bound, or a dead transport would end up
// refusing every other connection's traffic. Per connection, so that one noisy
// connection cannot push out what another still has to replay.
const MAX_FAILED_PER_CONNECTION = 1_000;

/** Daemon-owned WAL store. Opening/importing the SDK itself never opens this file. */
export class IntegrationStore {
  readonly db: Database.Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    chmodSync(path, 0o600);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
        enabled INTEGER NOT NULL, definition TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS connection_owners ON connections(plugin_id, owner_user_id);
      CREATE TABLE IF NOT EXISTS receipts (
        id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connections(id),
        external_id TEXT NOT NULL, connection TEXT NOT NULL, message TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'inbox', mission_id TEXT, reply_text TEXT,
        checkpoint TEXT NOT NULL DEFAULT 'null', attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, failed_at INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        UNIQUE(connection_id, external_id)
      );
      CREATE INDEX IF NOT EXISTS receipt_due ON receipts(stage,next_at,lease_until);
      CREATE INDEX IF NOT EXISTS receipt_rate ON receipts(connection_id,created_at);
    `);
    const columns = (this.db.pragma('table_info(receipts)') as { name: string }[]).map((column) => column.name);
    if (!columns.includes('failed_at')) this.db.exec('ALTER TABLE receipts ADD COLUMN failed_at INTEGER NOT NULL DEFAULT 0');
    if (!columns.includes('last_error')) this.db.exec('ALTER TABLE receipts ADD COLUMN last_error TEXT');
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS receipt_failed ON receipts(connection_id,failed_at) WHERE failed_at>0;
      CREATE INDEX IF NOT EXISTS receipt_open ON receipts(connection_id,created_at) WHERE stage!='delivered';
    `);
    this.db.pragma('foreign_keys = ON');
  }

  getConnection(id: string): PluginMessagingConnection | undefined {
    const row = this.db.prepare('SELECT definition FROM connections WHERE id=?').get(id) as { definition: string } | undefined;
    return row ? JSON.parse(row.definition) as PluginMessagingConnection : undefined;
  }
  listConnections(pluginId: string, ownerUserId: string): PluginMessagingConnection[] {
    return (this.db.prepare('SELECT definition FROM connections WHERE plugin_id=? AND owner_user_id=? ORDER BY id')
      .all(pluginId, ownerUserId) as { definition: string }[]).map((row) => JSON.parse(row.definition) as PluginMessagingConnection);
  }
  /** Every plugin's connections of one account, or all of them when `ownerUserId` is null. */
  connectionsOf(ownerUserId: string | null): PluginMessagingConnection[] {
    const rows = ownerUserId === null
      ? this.db.prepare('SELECT definition FROM connections ORDER BY id').all()
      : this.db.prepare('SELECT definition FROM connections WHERE owner_user_id=? ORDER BY id').all(ownerUserId);
    return (rows as { definition: string }[]).map((row) => JSON.parse(row.definition) as PluginMessagingConnection);
  }
  createConnection(connection: PluginMessagingConnection): void {
    this.db.prepare('INSERT INTO connections VALUES (?,?,?,?,?)')
      .run(connection.id, connection.pluginId, connection.identity.ownerUserId, connection.enabled ? 1 : 0, JSON.stringify(connection));
  }
  updateConnection(connection: PluginMessagingConnection, previousRevision: number): void {
    this.db.transaction(() => {
      const old = this.getConnection(connection.id);
      if (!old || old.revision !== previousRevision || old.pluginId !== connection.pluginId
        || old.identity.ownerUserId !== connection.identity.ownerUserId || old.transport !== connection.transport) {
        throw new IntegrationQueueError(409, 'Connection changed; reload before updating');
      }
      this.db.prepare('UPDATE connections SET enabled=?, definition=? WHERE id=?')
        .run(connection.enabled ? 1 : 0, JSON.stringify(connection), connection.id);
    }).immediate();
  }

  accept(connection: PluginMessagingConnection, message: PluginInboundMessage, now = Date.now()): IntegrationReceipt {
    return this.db.transaction(() => {
      const current = this.getConnection(connection.id);
      if (!current?.enabled || current.revision !== connection.revision) throw new IntegrationQueueError(409, 'Connection changed during authentication');
      const existing = this.db.prepare('SELECT * FROM receipts WHERE connection_id=? AND external_id=?')
        .get(connection.id, message.externalId) as IntegrationReceipt | undefined;
      if (existing) return existing;
      if (this.liveCount() >= MAX_LIVE_RECEIPTS) throw new IntegrationQueueError(503, 'Integration queue full');
      const recent = this.db.prepare('SELECT COUNT(*) AS n FROM receipts WHERE connection_id=? AND created_at>?')
        .get(connection.id, now - 60_000) as { n: number };
      if (recent.n >= 30) throw new IntegrationQueueError(429, 'Connection rate limited');
      const id = randomUUID();
      this.db.prepare('INSERT INTO receipts(id,connection_id,external_id,connection,message,created_at) VALUES (?,?,?,?,?,?)')
        .run(id, connection.id, message.externalId, JSON.stringify(connection), JSON.stringify(message), now);
      return this.getReceipt(id)!;
    }).immediate();
  }
  private liveCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE stage!='delivered' AND failed_at=0").get() as { n: number }).n;
  }
  getReceipt(id: string): IntegrationReceipt | undefined {
    return this.db.prepare('SELECT * FROM receipts WHERE id=?').get(id) as IntegrationReceipt | undefined;
  }
  claim(stage: 'inbox' | 'reply', now = Date.now()): IntegrationReceipt | undefined {
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT r.* FROM receipts r JOIN connections c ON c.id=r.connection_id
        WHERE r.stage=? AND r.next_at<=? AND r.lease_until<=? AND r.failed_at=0 AND c.enabled=1
        ORDER BY r.next_at,r.created_at,r.rowid LIMIT 1`).get(stage, now, now) as IntegrationReceipt | undefined;
      if (!row) return;
      const lease = randomUUID();
      this.db.prepare('UPDATE receipts SET lease=?,lease_until=? WHERE id=?').run(lease, now + LEASE_MS, row.id);
      return { ...row, lease, lease_until: now + LEASE_MS };
    }).immediate();
  }
  attachMission(row: IntegrationReceipt, missionId: string, now = Date.now()): boolean {
    return this.db.prepare(`UPDATE receipts SET mission_id=?,stage='reply',attempts=0,last_error=NULL,next_at=0,lease=NULL,lease_until=0
      WHERE id=? AND stage='inbox' AND lease=? AND lease_until>?`).run(missionId, row.id, row.lease, now).changes > 0;
  }
  saveReplyText(row: IntegrationReceipt, text: string, now = Date.now()): boolean {
    return this.db.prepare(`UPDATE receipts SET reply_text=COALESCE(reply_text,?)
      WHERE id=? AND stage='reply' AND lease=? AND lease_until>?`).run(text, row.id, row.lease, now).changes > 0;
  }
  saveDelivery(row: IntegrationReceipt, checkpoint: PluginJsonValue, done: boolean, now = Date.now()): boolean {
    return this.db.prepare(`UPDATE receipts SET checkpoint=?,stage=?,attempts=0,last_error=NULL,next_at=?,lease=NULL,lease_until=0
      WHERE id=? AND stage='reply' AND lease=? AND lease_until>?`)
      .run(JSON.stringify(checkpoint), done ? 'delivered' : 'reply', now, row.id, row.lease, now).changes > 0;
  }
  /** Puts a claimed receipt back. Returns true when this failure used up its retries. */
  defer(row: IntegrationReceipt, failed: boolean, now = Date.now(), error: string | null = null): boolean {
    const givenUp = failed && row.attempts + 1 >= RECEIPT_MAX_ATTEMPTS;
    return this.db.transaction(() => {
      const changes = this.db.prepare(`UPDATE receipts SET attempts=attempts+?,next_at=?,lease=NULL,lease_until=0,
        last_error=COALESCE(?,last_error),failed_at=?
        WHERE id=? AND stage=? AND lease=? AND lease_until>?`)
        .run(failed ? 1 : 0, now + (failed ? retryDelay(row.attempts) : 5000), error, givenUp ? now : 0, row.id, row.stage, row.lease, now).changes;
      if (!changes || !givenUp) return false;
      this.db.prepare(`DELETE FROM receipts WHERE id IN (
        SELECT id FROM receipts WHERE connection_id=? AND failed_at>0
        ORDER BY failed_at DESC,rowid DESC LIMIT -1 OFFSET ?)`).run(row.connection_id, MAX_FAILED_PER_CONNECTION);
      return true;
    }).immediate();
  }

  /** What is still on its way for one connection, delivered receipts aside. */
  receiptCounts(connectionId: string): IntegrationReceiptCounts {
    return this.db.prepare(`SELECT COALESCE(SUM(failed_at>0),0) AS failed,
        COALESCE(SUM(failed_at=0 AND attempts>0),0) AS retrying,
        COALESCE(SUM(failed_at=0 AND attempts=0),0) AS queued
      FROM receipts WHERE connection_id=? AND stage!='delivered'`).get(connectionId) as IntegrationReceiptCounts;
  }
  /** Receipts someone may have to act on, failed first, newest first. */
  listTroubled(connectionId: string, status: IntegrationReceiptStatus | null, limit: number): TroubledReceipt[] {
    const filter = status === 'failed' ? 'failed_at>0' : status === 'retrying' ? 'failed_at=0 AND attempts>0' : '(failed_at>0 OR attempts>0)';
    return this.db.prepare(`SELECT * FROM receipts WHERE connection_id=? AND stage!='delivered' AND ${filter}
      ORDER BY failed_at>0 DESC,created_at DESC,rowid DESC LIMIT ?`).all(connectionId, limit) as TroubledReceipt[];
  }
  /**
   * Sends a failed or waiting receipt back to the worker, at the stage it
   * reached: a mission already created is not created again, and a reply
   * already partly sent resumes from its checkpoint. One still being processed
   * is left alone. Returns false when there is nothing to replay.
   */
  replay(id: string, now = Date.now()): boolean {
    return this.db.transaction(() => {
      const row = this.getReceipt(id);
      if (!row || row.stage === 'delivered' || !(row.failed_at > 0 || row.attempts > 0) || row.lease_until > now) return false;
      if (row.failed_at > 0 && this.liveCount() >= MAX_LIVE_RECEIPTS) throw new IntegrationQueueError(503, 'Integration queue full');
      this.db.prepare('UPDATE receipts SET failed_at=0,attempts=0,next_at=?,lease=NULL,lease_until=0 WHERE id=?').run(now, id);
      return true;
    }).immediate();
  }
  /** `replay` for every failed receipt of a connection. Returns how many went back. */
  replayFailed(connectionId: string, now = Date.now()): number {
    return this.db.transaction(() => {
      const failed = (this.db.prepare('SELECT COUNT(*) AS n FROM receipts WHERE connection_id=? AND failed_at>0').get(connectionId) as { n: number }).n;
      if (failed && this.liveCount() + failed > MAX_LIVE_RECEIPTS) throw new IntegrationQueueError(503, 'Integration queue full');
      return this.db.prepare('UPDATE receipts SET failed_at=0,attempts=0,next_at=?,lease=NULL,lease_until=0 WHERE connection_id=? AND failed_at>0')
        .run(now, connectionId).changes;
    }).immediate();
  }
  /** Gives up on a failed receipt for good. Only a failed one: the others are still owed. */
  discardFailed(id: string): boolean {
    return this.db.prepare('DELETE FROM receipts WHERE id=? AND failed_at>0').run(id).changes > 0;
  }
  /**
   * Drops delivered receipts older than `cutoff`. A delivered receipt only
   * serves to deduplicate a provider that sends the same message again, which
   * happens within minutes or hours, never months; kept forever they made the
   * file grow with every message (TODO #547). Receipts still on their way are
   * never touched. Short batches: the worker writes to the same file.
   */
  pruneDelivered(cutoff: number, batch = 1000): number {
    return this.pruneBatches(`DELETE FROM receipts WHERE rowid IN (
      SELECT rowid FROM receipts WHERE stage='delivered' AND created_at<? LIMIT ?)`, cutoff, batch);
  }
  /** Drops the receipts that failed before `cutoff`: nobody replayed them in time. */
  pruneFailed(cutoff: number, batch = 1000): number {
    return this.pruneBatches(`DELETE FROM receipts WHERE rowid IN (
      SELECT rowid FROM receipts WHERE failed_at>0 AND failed_at<? LIMIT ?)`, cutoff, batch);
  }
  private pruneBatches(sql: string, cutoff: number, batch: number): number {
    const stmt = this.db.prepare(sql);
    let dropped = 0;
    for (;;) {
      const changes = stmt.run(cutoff, batch).changes;
      dropped += changes;
      if (changes < batch) return dropped;
    }
  }
  close(): void { this.db.close(); }
}
