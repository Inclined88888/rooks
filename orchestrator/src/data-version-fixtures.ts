/**
 * What the data-version.*.test.ts files share. They are several files because
 * the runner's time limit covers a whole file, and these tests copy and verify
 * real snapshots: on a machine whose disk is busy, 77 of them in one file ran
 * past it (TODO #657).
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backupsDir,
  protectDataBeforeOpen,
  restoreRequestFile,
  writeDataVersion,
  type DataFiles,
  type RestoreStep,
} from './data-version.js';

export function home(): DataFiles {
  const dir = mkdtempSync(join(tmpdir(), 'timon-data-version-'));
  return { home: dir, dbPath: join(dir, 'timon.db'), configPath: join(dir, 'timon.config.json') };
}

/** Fixture databases do not wait on the disk: no test here survives a power
 *  cut, and their fsyncs were 1,250 of the 1,850 of a run (TODO #657). */
export function fixtureDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('synchronous = OFF');
  return db;
}

/** A WAL database with a row that only lives in the -wal file while `live` stays open. */
export function seed(files: DataFiles, value: string): Database.Database {
  const db = fixtureDb(files.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec('CREATE TABLE IF NOT EXISTS notes (value TEXT)');
  db.prepare('INSERT INTO notes (value) VALUES (?)').run(value);
  return db;
}

export function notes(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare('SELECT value FROM notes ORDER BY rowid').all() as { value: string }[]).map((r) => r.value);
  } finally {
    db.close();
  }
}

export const quiet = { warn: () => {} };

export const integrationsPath = (files: DataFiles): string => join(files.home, 'integrations.db');

/** Same as `seed`, for the messaging receipts and per-user connections database. */
export function seedIntegrations(files: DataFiles, value: string): Database.Database {
  return seed({ ...files, dbPath: integrationsPath(files) }, value);
}

export function requestRestore(files: DataFiles, snapshot: string, version: string): void {
  mkdirSync(backupsDir(files.home), { recursive: true });
  writeFileSync(restoreRequestFile(files.home), JSON.stringify({ id: 'r1', snapshot, version, requestedAt: 1 }));
}

/** 0.1.1 data, then 0.1.2 ran on them and wrote more; the user went back to 0.1.1. */
export function downgraded(): DataFiles {
  const files = home();
  seedPlugins(files, 'before');
  writeFileSync(files.configPath, '{"v":"0.1.1"}');
  seed(files, 'before the update').close();
  seedIntegrations(files, 'receipt before the update').close();
  writeDataVersion(files.home, '0.1.1');
  assert.equal(protectDataBeforeOpen(files, '0.1.2', quiet), 'snapshot');
  writeFileSync(files.configPath, '{"v":"0.1.2"}');
  seedPlugins(files, 'after');
  seedIntegrations(files, 'receipt after the update').close();
  return files;
}

/**
 * Every live file a restore may touch, hashed; `null` when absent. An empty
 * -wal holds nothing: SQLite creates one whenever the base is opened, even to
 * read it for the copy of what a restore would replace.
 */
export function liveState(files: DataFiles): Record<string, string | null> {
  const read = (path: string): string | null =>
    (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null);
  const wal = `${files.dbPath}-wal`;
  const integrationsWal = `${integrationsPath(files)}-wal`;
  return {
    db: read(files.dbPath),
    wal: existsSync(wal) && statSync(wal).size === 0 ? null : read(wal),
    integrations: read(integrationsPath(files)),
    integrationsWal: existsSync(integrationsWal) && statSync(integrationsWal).size === 0 ? null : read(integrationsWal),
    config: read(files.configPath),
    dataVersion: read(join(files.home, 'data-version')),
    plugins: treeState(join(files.home, 'plugins')),
    pluginData: treeState(join(files.home, 'plugins-data')),
  };
}

export function leftovers(files: DataFiles): string[] {
  return readdirSync(files.home).filter((name) => /\.(restoring|restore-old)$/.test(name))
    .concat(readdirSync(backupsDir(files.home)).filter((name) => name === 'restore-journal.json'));
}

export const FAILING_STEPS: RestoreStep[] = [
  'staged',
  'aside:db', 'aside:config', 'aside:data-version',
  'swap:db', 'swap:config', 'swap:data-version',
  'aside:plugins', 'aside:plugins-data', 'swap:plugins', 'swap:plugins-data',
  'aside:integrations', 'swap:integrations',
];

/** Windows' rename: it never replaces an existing file. */
export function windowsRename(from: string, to: string): void {
  if (existsSync(to)) throw Object.assign(new Error(`EEXIST: file already exists, rename '${from}' -> '${to}'`), { code: 'EEXIST' });
  renameSync(from, to);
}

export function seedPlugins(files: DataFiles, value: string): void {
  for (const slot of ['plugins', 'plugins-data']) {
    mkdirSync(join(files.home, slot, 'sample', 'empty'), { recursive: true });
    writeFileSync(join(files.home, slot, 'sample', 'state'), value);
  }
}

export function treeState(path: string): string | null {
  if (!existsSync(path)) return null;
  return JSON.stringify(readdirSync(path).sort().map((name) => {
    const file = join(path, name);
    return [name, statSync(file).isDirectory() ? treeState(file) : readFileSync(file).toString('hex')];
  }));
}
