import type { Statement } from 'better-sqlite3';
import { getDb } from './db';

// Lazy prepared statements — see token.ts for the rationale (avoids
// opening the SQLite handle at module load, which breaks `next build`).
let stmts: { insert: Statement; recent: Statement } | null = null;
function S() {
  if (stmts) return stmts;
  const d = getDb();
  stmts = {
    insert: d.prepare(
      `INSERT INTO remote_audit (token_id, client_name, method, path, status, ip, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    recent: d.prepare(
      `SELECT * FROM remote_audit WHERE token_id = ? ORDER BY id DESC LIMIT ?`,
    ),
  };
  return stmts;
}

export function audit(entry: {
  tokenId: string | null;
  clientName: string | null;
  method: string;
  path: string;
  status: number;
  ip: string | null;
}): void {
  S().insert.run(
    entry.tokenId,
    entry.clientName,
    entry.method,
    entry.path,
    entry.status,
    entry.ip,
    Date.now(),
  );
}

export function recentForToken(tokenId: string, limit = 20) {
  return S().recent.all(tokenId, limit);
}
