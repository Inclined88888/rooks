import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { REMOTE_DB_PATH } from '../paths';

/**
 * SQLite handle for the remote API (tokens + audit log).
 *
 * Lazy: opening the DB at module-load time breaks `next build`, because
 * Next collects page data with multiple workers in parallel, each of
 * which imports this module and races on the WAL-mode exclusive lock →
 * one wins, the others throw SQLITE_BUSY and the whole build fails.
 *
 * Deferring `new Database()` until first call means build-time imports
 * (force-dynamic routes only need the module shape, not a live handle)
 * never touch the filesystem.
 */
let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  mkdirSync(dirname(REMOTE_DB_PATH), { recursive: true });
  _db = new Database(REMOTE_DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
CREATE TABLE IF NOT EXISTS remote_tokens (
  id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  call_count INTEGER NOT NULL DEFAULT 0,
  last_called_at INTEGER
);

CREATE TABLE IF NOT EXISTS remote_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id TEXT,
  client_name TEXT,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  ip TEXT,
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_token ON remote_audit(token_id, id DESC);
`);
  return _db;
}

export type RemoteTokenRow = {
  id: string;
  client_name: string;
  token_hash: string;
  issued_at: number;
  expires_at: number;
  revoked: number;
  call_count: number;
  last_called_at: number | null;
};

export type AuditRow = {
  id: number;
  token_id: string | null;
  client_name: string | null;
  method: string;
  path: string;
  status: number;
  ip: string | null;
  timestamp: number;
};
