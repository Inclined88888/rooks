import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOKS_HOME, MISSION_MAP_PATH } from '../paths';
import type { InboundMessage } from './types';

export class ChannelQueueFull extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export type Receipt = { id: string; channel: string; payload: string; agent: string; mission_id: string | null; attempts: number; lease: string | null };
export type Reply = { mission_id: string; channel: string; context: string; text: string | null; part: number; attempts: number; lease: string | null };
const retryDelay = (attempts: number) => Math.min(300_000, 1000 * 2 ** Math.min(attempts, 8));

/** A separate WAL database shared by app and workers, opened only at runtime. */
export class ChannelStore {
  readonly db: Database.Database;
  constructor(path: string, legacyPath?: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    chmodSync(path, 0o600);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inbox (
        id TEXT PRIMARY KEY, channel TEXT NOT NULL, external_id TEXT NOT NULL,
        payload TEXT NOT NULL, agent TEXT NOT NULL, mission_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
        lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        UNIQUE(channel, external_id)
      );
      CREATE TABLE IF NOT EXISTS replies (
        mission_id TEXT PRIMARY KEY, channel TEXT NOT NULL, context TEXT NOT NULL,
        text TEXT, part INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
        lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS cursors (channel TEXT PRIMARY KEY, offset INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT);
      CREATE INDEX IF NOT EXISTS inbox_received ON inbox(channel,created_at);
      CREATE INDEX IF NOT EXISTS inbox_due ON inbox(next_at) WHERE mission_id IS NULL;
      CREATE INDEX IF NOT EXISTS replies_due ON replies(next_at) WHERE delivered=0;
    `);
    if (legacyPath && existsSync(legacyPath)) this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM metadata WHERE key='legacy-imported'").get()) return;
      const entries = JSON.parse(readFileSync(legacyPath, 'utf8')) as Record<string, { channel: string; replyContext: unknown }>;
      for (const [missionId, entry] of Object.entries(entries)) this.addReply(missionId, entry.channel, entry.replyContext);
      this.db.prepare("INSERT INTO metadata VALUES ('legacy-imported','1')").run();
    }).immediate();
  }
  accept(inbound: InboundMessage, agent: string, externalId: string, now = Date.now()): Receipt {
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM inbox WHERE channel=? AND external_id=?').get(inbound.channel, externalId) as Receipt | undefined;
      if (existing) return existing;
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM inbox WHERE mission_id IS NULL').get() as { n: number };
      if (count.n >= 10_000) throw new ChannelQueueFull(503, 'channel inbox full');
      const recent = this.db.prepare('SELECT COUNT(*) AS n FROM inbox WHERE channel=? AND created_at>?').get(inbound.channel, now - 60_000) as { n: number };
      if (recent.n >= 30) throw new ChannelQueueFull(429, 'channel rate limited');
      const id = randomUUID();
      this.db.prepare('INSERT INTO inbox(id,channel,external_id,payload,agent,created_at) VALUES (?,?,?,?,?,?)').run(id, inbound.channel, externalId, JSON.stringify(inbound), agent, now);
      return this.db.prepare('SELECT * FROM inbox WHERE id=?').get(id) as Receipt;
    }).immediate();
  }
  claimInbox(now = Date.now()): Receipt | undefined {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM inbox WHERE mission_id IS NULL AND next_at<=? AND lease_until<=? ORDER BY created_at LIMIT 1').get(now, now) as Receipt | undefined;
      if (!row) return;
      const lease = randomUUID();
      this.db.prepare('UPDATE inbox SET lease=?,lease_until=? WHERE id=?').run(lease, now + 120_000, row.id);
      return { ...row, lease };
    }).immediate();
  }
  completeInbox(row: Receipt, missionId: string): void {
    this.db.transaction(() => {
      const changed = this.db.prepare('UPDATE inbox SET mission_id=?,lease=NULL,lease_until=0 WHERE id=? AND lease=?').run(missionId, row.id, row.lease);
      if (!changed.changes) return;
      const inbound = JSON.parse(row.payload) as InboundMessage;
      this.addReply(missionId, row.channel, inbound.replyContext);
    }).immediate();
  }
  failInbox(row: Receipt, now = Date.now()): void {
    this.db.prepare('UPDATE inbox SET attempts=attempts+1,next_at=?,lease=NULL,lease_until=0 WHERE id=? AND lease=?').run(now + retryDelay(row.attempts), row.id, row.lease);
  }
  addReply(missionId: string, channel: string, context: unknown): void {
    this.db.prepare('INSERT OR IGNORE INTO replies(mission_id,channel,context) VALUES (?,?,?)').run(missionId, channel, JSON.stringify(context));
  }
  getReply(missionId: string): Reply | undefined {
    return this.db.prepare('SELECT * FROM replies WHERE mission_id=? AND delivered=0').get(missionId) as Reply | undefined;
  }
  claimReply(now = Date.now()): Reply | undefined {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM replies WHERE delivered=0 AND next_at<=? AND lease_until<=? ORDER BY next_at, rowid LIMIT 1').get(now, now) as Reply | undefined;
      if (!row) return;
      const lease = randomUUID();
      this.db.prepare('UPDATE replies SET lease=?,lease_until=? WHERE mission_id=?').run(lease, now + 120_000, row.mission_id);
      return { ...row, lease };
    }).immediate();
  }
  saveReplyText(row: Reply, text: string): void {
    this.db.prepare('UPDATE replies SET text=? WHERE mission_id=? AND lease=?').run(text, row.mission_id, row.lease);
  }
  saveReplyPart(row: Reply, part: number): void {
    this.db.prepare('UPDATE replies SET part=?,lease_until=? WHERE mission_id=? AND lease=?').run(part, Date.now() + 120_000, row.mission_id, row.lease);
  }
  deferReply(row: Reply, failed: boolean, now = Date.now()): void {
    this.db.prepare('UPDATE replies SET attempts=attempts+?,next_at=?,lease=NULL,lease_until=0 WHERE mission_id=? AND lease=?')
      .run(failed ? 1 : 0, now + (failed ? retryDelay(row.attempts) : 5000), row.mission_id, row.lease);
  }
  completeReply(missionId: string, lease?: string | null): void {
    if (lease) this.db.prepare('UPDATE replies SET delivered=1,lease=NULL,lease_until=0 WHERE mission_id=? AND lease=?').run(missionId, lease);
    else this.db.prepare('UPDATE replies SET delivered=1 WHERE mission_id=?').run(missionId);
  }
  cursor(channel: string): number {
    return (this.db.prepare('SELECT offset FROM cursors WHERE channel=?').get(channel) as { offset: number } | undefined)?.offset ?? 0;
  }
  setCursor(channel: string, offset: number): void {
    this.db.prepare('INSERT INTO cursors VALUES (?,?) ON CONFLICT(channel) DO UPDATE SET offset=MAX(offset,excluded.offset)').run(channel, offset);
  }
  close(): void { this.db.close(); }
}
let singleton: ChannelStore | undefined;
export function channelStore(): ChannelStore {
  return singleton ??= new ChannelStore(join(ROOKS_HOME, 'channels.db'), MISSION_MAP_PATH);
}
