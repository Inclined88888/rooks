/**
 * The seven account tables the core used to keep (roles, groups, memberships,
 * invitations) leave its schema: the plugin that serves the accounts keeps them
 * in its own database (TODO #906, decision 5 of 05/11/2026). An install that
 * updates before that plugin has copied them must lose nothing, so at the first
 * open of the database their rows are written to a file of the home, readable
 * by the owner only, and only then dropped. The plugin reads that file once,
 * through `ctx.accountProvider.readLegacy(table)`.
 *
 * Also dropped: `users.role_id` (M.8's one role per account), whose content M.9
 * already carried into groups, and whose reference to `roles` would make every
 * insert into `users` fail once `roles` is gone. Its assignments are written with
 * the `user_roles` rows all the same, so a database older than M.9 loses none.
 *
 * Opens nothing itself: `db.ts` hands it the database, `data-version.ts` reads
 * the closed list, so neither import cycles through the other.
 */
import type { Database } from 'better-sqlite3';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tightenToOwner } from '../host/owner-only.js';

/** The account tables the multi-user plugin takes over, children before parents. */
export const LEGACY_ACCOUNT_TABLES = ['roles', 'role_permissions', 'user_roles', 'groups', 'group_roles', 'user_groups', 'invitations'] as const;
export type LegacyAccountTable = (typeof LEGACY_ACCOUNT_TABLES)[number];

/** Drop order: a table goes before the one its foreign keys point at. */
const DROP_ORDER: readonly LegacyAccountTable[] = ['user_groups', 'group_roles', 'user_roles', 'role_permissions', 'invitations', 'groups', 'roles'];

type Row = Record<string, unknown>;
type LegacyFile = { version: 1; exportedAt: number; tables: Partial<Record<LegacyAccountTable, Row[]>> };

export function isLegacyAccountTable(value: unknown): value is LegacyAccountTable {
  return typeof value === 'string' && (LEGACY_ACCOUNT_TABLES as readonly string[]).includes(value);
}

function presentTables(db: Database): LegacyAccountTable[] {
  const names = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name));
  return LEGACY_ACCOUNT_TABLES.filter((table) => names.has(table));
}

function hasUserRoleColumn(db: Database): boolean {
  return (db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).some((c) => c.name === 'role_id');
}

/** Whether this database still holds anything the move has to take out. */
export function legacyAccountTablesPresent(db: Database): boolean {
  return presentTables(db).length > 0 || hasUserRoleColumn(db);
}

function readFile(file: string): LegacyFile | null {
  if (!existsSync(file)) return null;
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('tables' in parsed)) return null;
  const tables = (parsed as { tables: unknown }).tables;
  if (typeof tables !== 'object' || tables === null) return null;
  const out: LegacyFile = { version: 1, exportedAt: Number((parsed as { exportedAt?: unknown }).exportedAt) || 0, tables: {} };
  for (const table of LEGACY_ACCOUNT_TABLES) {
    const rows = (tables as Record<string, unknown>)[table];
    if (Array.isArray(rows)) out.tables[table] = rows.filter((row): row is Row => typeof row === 'object' && row !== null && !Array.isArray(row));
  }
  return out;
}

/**
 * Rows already in the file are kept: a version reinstalled in between may have
 * recreated the tables empty and filled them again, and neither copy may be lost.
 */
function merge(previous: Row[] | undefined, current: Row[]): Row[] {
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const row of [...(previous ?? []), ...current]) {
    const key = JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** Written next to its final name, then renamed: a crash leaves the old file or the new one, never half of one. */
function writeOwnerOnly(file: string, content: string): void {
  const temp = `${file}.tmp`;
  rmSync(temp, { force: true });
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, file);
  tightenToOwner(file);
}

export type LegacyExportOutcome = { exported: LegacyAccountTable[]; rows: number; dropped: boolean };

/**
 * Writes the tables still present into `file`, then drops them and `users.role_id`,
 * in that order. Does nothing on a database that has none of them (a new install,
 * or the second open). If the file cannot be written, nothing is dropped: the
 * tables stay, inert, and the move is tried again at the next open.
 */
export function moveLegacyAccountTables(db: Database, file: string, now: number = Date.now()): LegacyExportOutcome {
  const tables = presentTables(db);
  const roleColumn = hasUserRoleColumn(db);
  if (!tables.length && !roleColumn) return { exported: [], rows: 0, dropped: false };

  let rows = 0;
  if (tables.length) {
    let previous: LegacyFile | null = null;
    try {
      previous = readFile(file);
    } catch (err) {
      console.warn(`[users] ${file} is unreadable, the former account tables stay in the database: ${(err as Error).message}`);
      return { exported: [], rows: 0, dropped: false };
    }
    const next: LegacyFile = { version: 1, exportedAt: now, tables: { ...(previous?.tables ?? {}) } };
    for (const table of tables) {
      const current = db.prepare(`SELECT * FROM ${table}`).all() as Row[];
      if (table === 'user_roles' && roleColumn) {
        current.push(...db.prepare(`SELECT id AS user_id, role_id FROM users WHERE role_id IS NOT NULL`).all() as Row[]);
      }
      rows += current.length;
      next.tables[table] = merge(previous?.tables[table], current);
    }
    try {
      writeOwnerOnly(file, `${JSON.stringify(next, null, 2)}\n`);
    } catch (err) {
      console.warn(`[users] could not write ${file}, the former account tables stay in the database: ${(err as Error).message}`);
      return { exported: [], rows: 0, dropped: false };
    }
  }

  db.transaction(() => {
    if (roleColumn) {
      db.exec(`DROP INDEX IF EXISTS idx_users_role`);
      db.exec(`ALTER TABLE users DROP COLUMN role_id`);
    }
    for (const table of DROP_ORDER) db.exec(`DROP TABLE IF EXISTS ${table}`);
  })();
  if (rows > 0) console.log(`[users] ${rows} row(s) of the former account tables moved to ${file}`);
  return { exported: tables, rows, dropped: true };
}

/** One table of the file, whole. No file, or a table it does not hold: nothing. */
export function readLegacyAccountRows(file: string, table: LegacyAccountTable): Row[] {
  if (!isLegacyAccountTable(table)) throw new Error(`not a legacy account table: ${String(table)}`);
  const content = readFile(file);
  return content?.tables[table]?.map((row) => ({ ...row })) ?? [];
}
