/**
 * The persistent egress journal (TODO #590, T3): one row per connection a
 * mission made through the proxy, and the hosts each project has already
 * reached.
 *
 * A row holds what `EgressRecord` holds — mission, method, host, port,
 * status, byte counts, duration, upstream error code — and nothing else: the
 * proxy never hands over the credential, nor the path or query string of a
 * plain-HTTP request, so there is nothing here to leak them.
 *
 * Retention is bounded twice so one chatty mission cannot fill the database:
 * a per-mission cap applied on every insert, and an age limit plus a global
 * cap applied by the hourly sweep (and every few hundred inserts in between).
 * The known hosts are kept apart, capped per project: they are the memory the
 * new-host alert reads, and must outlive the rows that taught them.
 *
 * The tables live here rather than in `db.ts`: the feature owns its schema.
 * Additive only — an older daemon ignores them.
 */
import { db } from '../db.js';
import type { EgressRecord } from './proxy.js';

export interface EgressRetention {
  /** Rows kept per mission; the oldest go first. */
  perMission: number;
  /** Rows kept across all missions. */
  total: number;
  /** Rows older than this go, whatever the counts. */
  maxAgeMs: number;
  /** Known hosts kept per project; the earliest learnt go first. */
  hostsPerProject: number;
}

export const EGRESS_RETENTION: Readonly<EgressRetention> = Object.freeze({
  perMission: 2_000,
  total: 200_000,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  hostsPerProject: 5_000,
});

/** How many inserts between two global sweeps, on top of the hourly one. */
const SWEEP_EVERY_INSERTS = 500;
/** A host name is at most 253 characters; anything longer is cut, never refused. */
const HOST_MAX = 253;

let schemaReady = false;

export function ensureEgressSchema(): void {
  if (schemaReady) return;
  db.exec(`
CREATE TABLE IF NOT EXISTS egress_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  method TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  status INTEGER NOT NULL,
  bytes_out INTEGER NOT NULL,
  bytes_in INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_egress_log_mission ON egress_log(mission_id, id);
CREATE INDEX IF NOT EXISTS idx_egress_log_started ON egress_log(started_at);

CREATE TABLE IF NOT EXISTS egress_known_hosts (
  project_key TEXT NOT NULL,
  host TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  first_mission_id TEXT NOT NULL,
  PRIMARY KEY (project_key, host)
);
CREATE INDEX IF NOT EXISTS idx_egress_known_hosts_mission ON egress_known_hosts(first_mission_id);
CREATE INDEX IF NOT EXISTS idx_egress_known_hosts_age ON egress_known_hosts(project_key, first_seen_at);
`);
  schemaReady = true;
}

/** Lower case, no trailing dot, bounded: `Example.COM.` and `example.com` are one host. */
export function normalizeEgressHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '').slice(0, HOST_MAX);
}

let insertsSinceSweep = 0;

/** Journals one connection and trims its mission back to the cap. */
export function recordEgress(record: EgressRecord, retention: EgressRetention = EGRESS_RETENTION): void {
  ensureEgressSchema();
  db.prepare(`INSERT INTO egress_log (mission_id, method, host, port, status, bytes_out, bytes_in, started_at, duration_ms, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    record.missionId, record.method.slice(0, 16), normalizeEgressHost(record.host), record.port, record.status,
    record.bytesOut, record.bytesIn, record.startedAt, record.durationMs, record.error?.slice(0, 64) ?? null,
  );
  // `id < NULL` matches nothing: under the cap, the subquery is empty and nothing goes.
  db.prepare(`DELETE FROM egress_log WHERE mission_id = ? AND id < (
    SELECT id FROM egress_log WHERE mission_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`)
    .run(record.missionId, record.missionId, retention.perMission - 1);
  insertsSinceSweep += 1;
  if (insertsSinceSweep >= SWEEP_EVERY_INSERTS) pruneEgressJournal(Date.now(), retention);
}

/** Age limit, then the global cap. Returns the rows removed. */
export function pruneEgressJournal(now: number = Date.now(), retention: EgressRetention = EGRESS_RETENTION): number {
  ensureEgressSchema();
  insertsSinceSweep = 0;
  const aged = db.prepare('DELETE FROM egress_log WHERE started_at < ?').run(now - retention.maxAgeMs).changes;
  const capped = db.prepare(`DELETE FROM egress_log WHERE id < (
    SELECT id FROM egress_log ORDER BY id DESC LIMIT 1 OFFSET ?)`).run(retention.total - 1).changes;
  return aged + capped;
}

/**
 * Whether `host` is new to `projectKey`, learning it on the way. Only the
 * first caller for a pair gets `true`: the primary key decides, not a read
 * followed by a write.
 */
export function learnEgressHost(
  projectKey: string,
  host: string,
  missionId: string,
  now: number = Date.now(),
  retention: EgressRetention = EGRESS_RETENTION,
): boolean {
  ensureEgressSchema();
  const learnt = db.prepare(`INSERT OR IGNORE INTO egress_known_hosts (project_key, host, first_seen_at, first_mission_id)
    VALUES (?, ?, ?, ?)`).run(projectKey, normalizeEgressHost(host), now, missionId).changes === 1;
  if (learnt) {
    db.prepare(`DELETE FROM egress_known_hosts WHERE project_key = ? AND rowid IN (
      SELECT rowid FROM egress_known_hosts WHERE project_key = ? ORDER BY first_seen_at DESC, rowid DESC LIMIT -1 OFFSET ?)`)
      .run(projectKey, projectKey, retention.hostsPerProject);
  }
  return learnt;
}

export interface EgressConnectionRow {
  id: number;
  method: string;
  host: string;
  port: number;
  status: number;
  bytes_out: number;
  bytes_in: number;
  started_at: number;
  duration_ms: number;
  error: string | null;
}

export interface EgressHostSummary {
  host: string;
  connections: number;
  bytes_out: number;
  bytes_in: number;
  first_at: number;
  last_at: number;
  failures: number;
}

/** Most recent first; `before` is the `id` of the last row of the previous page. */
export function listMissionEgress(missionId: string, opts: { limit: number; before?: number }): { connections: EgressConnectionRow[]; hasMore: boolean } {
  ensureEgressSchema();
  const rows = db.prepare(`SELECT id, method, host, port, status, bytes_out, bytes_in, started_at, duration_ms, error
    FROM egress_log WHERE mission_id = ? AND id < ? ORDER BY id DESC LIMIT ?`)
    .all(missionId, opts.before ?? Number.MAX_SAFE_INTEGER, opts.limit + 1) as EgressConnectionRow[];
  return { connections: rows.slice(0, opts.limit), hasMore: rows.length > opts.limit };
}

/** One line per host over every row the mission still has. */
export function missionEgressHosts(missionId: string): EgressHostSummary[] {
  ensureEgressSchema();
  return db.prepare(`SELECT host, COUNT(*) AS connections, SUM(bytes_out) AS bytes_out, SUM(bytes_in) AS bytes_in,
      MIN(started_at) AS first_at, MAX(started_at) AS last_at,
      SUM(CASE WHEN error IS NOT NULL OR status >= 400 THEN 1 ELSE 0 END) AS failures
    FROM egress_log WHERE mission_id = ? GROUP BY host ORDER BY connections DESC, host LIMIT 500`)
    .all(missionId) as EgressHostSummary[];
}

/** The hosts this mission was the first of its project to reach. */
export function missionNewEgressHosts(missionId: string): Array<{ host: string; first_seen_at: number }> {
  ensureEgressSchema();
  return db.prepare(`SELECT host, first_seen_at FROM egress_known_hosts WHERE first_mission_id = ?
    ORDER BY first_seen_at, host LIMIT 500`).all(missionId) as Array<{ host: string; first_seen_at: number }>;
}
