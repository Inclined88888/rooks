/**
 * A plugin's own SQLite database (`ctx.sql`, permission `storage:sql`, API 15).
 *
 * One file per plugin, `plugins-data/<id>/plugin.db`, opened by the core and
 * never the daemon's database. The plugin declares `"migrations": "<folder>"`
 * in its manifest: numbered `.sql` files the core applies before `apply`, each
 * in a transaction, the reached number kept in `PRAGMA user_version`. A
 * migration that fails leaves the plugin unmounted (`skipped:migration`), never
 * half migrated.
 *
 * The API is narrow on purpose: prepared statements and transactions. No
 * `ATTACH` (it would open another file, the daemon's database included), no
 * extension loading, and a size ceiling. Account ids are plain strings: there
 * is no foreign key towards the core's tables, which live in another file.
 */
import Database from 'better-sqlite3';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { PluginSqlDatabase, PluginSqlStatement } from './contract/core.js';

/** File name of a plugin's database inside its data folder. */
export const PLUGIN_DB_FILE = 'plugin.db';
/** Size ceiling of a plugin's database. */
export const PLUGIN_DB_MAX_BYTES = 256 * 1024 * 1024;
/** Most migration files a plugin may ship. */
export const PLUGIN_DB_MAX_MIGRATIONS = 500;

export type PluginMigration = { number: number; name: string; sql: string };

export class PluginDbError extends Error {}

const MIGRATION_FILE = /^(\d{1,6})[-_][A-Za-z0-9._-]+\.sql$/;
// What would reach outside the plugin's own file, or run native code.
const FORBIDDEN_SQL = /\b(ATTACH|DETACH)\b|\bload_extension\s*\(/i;

/** Refuses a statement that would open another file or load native code. */
export function assertPluginSql(sql: string): void {
  if (typeof sql !== 'string' || !sql.trim()) throw new PluginDbError('empty SQL statement');
  if (FORBIDDEN_SQL.test(sql)) throw new PluginDbError('ATTACH, DETACH and load_extension are not allowed in a plugin database');
}

/**
 * The migration folder a manifest declares, resolved inside the package. A path
 * that leaves the package is refused: migrations ship with the plugin.
 */
export function resolveMigrationsDir(packageDir: string, declared: string): string {
  if (isAbsolute(declared)) throw new PluginDbError(`\`migrations\` must be a folder of the package, not ${declared}`);
  const dir = resolve(packageDir, declared);
  const rel = relative(resolve(packageDir), dir);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PluginDbError('`migrations` must stay inside the package');
  }
  return dir;
}

/**
 * Reads `NNN-name.sql` files, ordered by number. Numbers start at 1 and follow
 * each other: a gap or a duplicate would make `user_version` ambiguous.
 */
export function readMigrations(dir: string): PluginMigration[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new PluginDbError('the `migrations` folder does not exist');
  const out: PluginMigration[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.toLowerCase().endsWith('.sql')) continue;
    const m = MIGRATION_FILE.exec(name);
    if (!m) throw new PluginDbError(`migration file ${name} must be named NNN-name.sql`);
    const sql = readFileSync(join(dir, name), 'utf8');
    assertPluginSql(sql);
    out.push({ number: Number(m[1]), name, sql });
  }
  if (out.length > PLUGIN_DB_MAX_MIGRATIONS) throw new PluginDbError(`more than ${PLUGIN_DB_MAX_MIGRATIONS} migrations`);
  out.sort((a, b) => a.number - b.number);
  out.forEach((mig, i) => {
    if (mig.number !== i + 1) {
      throw new PluginDbError(`migrations must be numbered 1, 2, 3… without gap or duplicate (found ${mig.name} at position ${i + 1})`);
    }
  });
  return out;
}

/** Opens (and creates) a plugin's database with its ceilings. */
export function openPluginDb(file: string): Database.Database {
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  // Locks are short-lived: wait a little rather than fail on a busy file.
  db.pragma('busy_timeout = 5000');
  const pageSize = Number(db.pragma('page_size', { simple: true })) || 4096;
  db.pragma(`max_page_count = ${Math.max(1, Math.floor(PLUGIN_DB_MAX_BYTES / pageSize))}`);
  return db;
}

/**
 * Applies the migrations above the database's `user_version`, each in its own
 * transaction. Returns the version reached. A version above the last shipped
 * migration means the plugin was downgraded: refused, the data stays as it is.
 */
export function migratePluginDb(db: Database.Database, migrations: readonly PluginMigration[]): number {
  const current = Number(db.pragma('user_version', { simple: true })) || 0;
  const last = migrations.length ? migrations[migrations.length - 1]!.number : 0;
  if (current > last) {
    throw new PluginDbError(`the database is at version ${current} but this version of the plugin only knows ${last}: a downgrade is refused`);
  }
  for (const mig of migrations) {
    if (mig.number <= current) continue;
    try {
      db.transaction(() => {
        db.exec(mig.sql);
        db.pragma(`user_version = ${mig.number}`);
      })();
    } catch (err) {
      throw new PluginDbError(`migration ${mig.name} failed: ${(err as Error).message}`);
    }
  }
  return last;
}

/** The facade a plugin receives as `ctx.sql`. */
export function pluginSqlFacade(db: Database.Database, isOpen: () => boolean): PluginSqlDatabase {
  const live = (): Database.Database => {
    if (!isOpen()) throw new PluginDbError('the plugin database is closed (the plugin was unloaded)');
    return db;
  };
  return {
    prepare(sql: string): PluginSqlStatement {
      assertPluginSql(sql);
      const stmt = live().prepare(sql);
      return {
        get: (...params: unknown[]) => stmt.get(...params) as Record<string, unknown> | undefined,
        all: (...params: unknown[]) => stmt.all(...params) as Record<string, unknown>[],
        run: (...params: unknown[]) => {
          const r = stmt.run(...params);
          return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
        },
      };
    },
    transaction<T>(fn: () => T): T {
      return live().transaction(fn)();
    },
  };
}

/** Path of a plugin's database inside its data folder. */
export function pluginDbFile(dataDir: string): string {
  return join(dataDir, PLUGIN_DB_FILE);
}
