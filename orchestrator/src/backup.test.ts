/**
 * 4.6 — backup périodique : routine 03:30, `rooks export`, garde 7 archives.
 *
 * ROOKS_HOME jetable, jamais le `~/.rooks/backups` réel. Témoin HTTP sur
 * `127.0.0.1:0`, jamais le :3000 de prod. On ne `kill` un child que s'il
 * a un pid, jamais `0`.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-backup-test-'));
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const HOME = process.env.ROOKS_HOME;
const REAL_ROOKS_BACKUPS = join(homedir(), '.rooks', 'backups');
const ROOKS = fileURLToPath(new URL('../bin/rooks', import.meta.url));

const {
  BACKUP_CRON,
  BACKUP_KEEP,
  BACKUP_ROUTINE_ID,
  backupArchiveName,
  backupStatus,
  backupsDir,
  createRoutine,
  enableBackupRoutine,
  pruneBackupArchives,
  runNightlyBackup,
  tickRoutines,
} = await import('./routines.js');
const { db, dbApi } = await import('./db.js');

function seedConfig(): void {
  mkdirSync(join(HOME, 'agents', 'temoin'), { recursive: true });
  writeFileSync(join(HOME, 'agents', 'temoin', 'config.json'), '{"name":"temoin"}\n');
}

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'rooks-backup-cli-'));
}

function baseEnv(home: string): NodeJS.ProcessEnv {
  const env = { ...process.env, ROOKS_HOME: home, ROOKS_RESOURCE_GUARD_ENABLED: '0' };
  delete env.ROOKS_API_TOKEN;
  delete env.ROOKS_API;
  delete env.ROOKS_ORCH_URL;
  return env;
}

function runRooks(args: string[], env: NodeJS.ProcessEnv): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ROOKS, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer | string) => { stdout += String(c); });
    child.stderr.on('data', (c: Buffer | string) => { stderr += String(c); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function startMock(payload: Record<string, unknown>): Promise<{
  url: string;
  seen: { url: string; method: string }[];
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const seen: { url: string; method: string }[] = [];
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url ?? '', method: req.method ?? '' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('adresse d\'écoute inattendue'));
        return;
      }
      assert.notEqual(addr.port, 3000, 'le témoin ne doit pas prendre le port de prod');
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        seen,
        close: () => new Promise((resClose, rejClose) => {
          server.close((err) => err ? rejClose(err) : resClose());
        }),
      });
    });
  });
}

test('sans enable, status est inactif et le dossier n\'est pas le ~/.rooks réel', () => {
  const st = backupStatus();
  assert.equal(st.enabled, false);
  assert.equal(st.cron, BACKUP_CRON);
  assert.equal(st.keep, BACKUP_KEEP);
  assert.equal(st.routine, null);
  assert.equal(st.dir, join(HOME, 'backups'));
  assert.notEqual(st.dir, REAL_ROOKS_BACKUPS);
  assert.ok(st.dir.startsWith(HOME));
});

test('enable crée la routine 03:30, idempotent, même id', () => {
  const first = enableBackupRoutine();
  assert.equal(first.enabled, true);
  assert.equal(first.cron, '30 3 * * *');
  assert.equal(first.routine?.id, BACKUP_ROUTINE_ID);
  assert.equal(first.routine?.agent_name, 'rooks');
  assert.match(first.routine?.prompt ?? '', /rooks export --out/);
  assert.ok(existsSync(first.dir));
  assert.notEqual(first.dir, REAL_ROOKS_BACKUPS);

  const again = enableBackupRoutine();
  assert.equal(again.routine?.id, BACKUP_ROUTINE_ID);
  const rows = dbApi.listRoutines().filter((r) => r.id === BACKUP_ROUTINE_ID);
  assert.equal(rows.length, 1);
});

test('prune garde les 7 plus récents par nom de date', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rooks-backup-prune-'));
  for (let day = 10; day <= 18; day++) {
    writeFileSync(join(dir, `rooks-2026-08-${day}.tar.gz`), `archive-${day}`);
  }
  writeFileSync(join(dir, 'notes.txt'), 'ne pas toucher');
  const dropped = pruneBackupArchives(dir, 7);
  assert.deepEqual(dropped, ['rooks-2026-08-11.tar.gz', 'rooks-2026-08-10.tar.gz']);
  const left = readdirSync(dir).sort();
  assert.deepEqual(left, [
    'notes.txt',
    'rooks-2026-08-12.tar.gz',
    'rooks-2026-08-13.tar.gz',
    'rooks-2026-08-14.tar.gz',
    'rooks-2026-08-15.tar.gz',
    'rooks-2026-08-16.tar.gz',
    'rooks-2026-08-17.tar.gz',
    'rooks-2026-08-18.tar.gz',
  ]);
});

test('runNightlyBackup écrit sous ROOKS_HOME/backups, pas un home réel', () => {
  seedConfig();
  const when = new Date(2026, 7, 21, 3, 30, 0);
  const result = runNightlyBackup(when);
  const expected = join(HOME, 'backups', 'rooks-2026-08-21.tar.gz');
  assert.equal(result.out, expected);
  assert.ok(existsSync(expected), 'archive créée');
  assert.ok(result.bytes > 0);
  assert.ok(!result.out.startsWith(REAL_ROOKS_BACKUPS));
  assert.equal(backupArchiveName(when), 'rooks-2026-08-21.tar.gz');
  const listing = readFileSync(expected); // existence + non vide
  assert.ok(listing.length > 0);
});

test('runNightlyBackup ne garde que 7 archives', () => {
  const dir = backupsDir();
  mkdirSync(dir, { recursive: true });
  for (let day = 1; day <= 8; day++) {
    const n = String(day).padStart(2, '0');
    writeFileSync(join(dir, `rooks-2026-07-${n}.tar.gz`), `old-${n}`);
  }
  const result = runNightlyBackup(new Date(2026, 7, 22, 3, 30, 0));
  assert.ok(existsSync(result.out));
  const archives = readdirSync(dir).filter((n) => /^rooks-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(n)).sort();
  assert.equal(archives.length, 7);
  assert.ok(archives.includes('rooks-2026-08-22.tar.gz'));
  assert.ok(!archives.includes('rooks-2026-07-01.tar.gz'));
});

test('tick de la routine backup : archive, zéro task Kanban', async () => {
  enableBackupRoutine();
  db.prepare('UPDATE triggers SET next_run_at = ? WHERE id = ?').run(1, BACKUP_ROUTINE_ID);
  const before = dbApi.listTasks().length;
  await tickRoutines();
  assert.equal(dbApi.listTasks().length, before, 'le backup ne crée pas de task');
  const today = backupArchiveName();
  assert.ok(existsSync(join(HOME, 'backups', today)));
  const row = dbApi.getRoutine(BACKUP_ROUTINE_ID);
  assert.ok(row?.last_run_at && row.last_run_at > 0);
  assert.ok(row.next_run_at && row.next_run_at > Date.now());
});

test('tick d\'une routine normale crée toujours une task', async () => {
  const r = createRoutine({
    name: 'ping',
    agent_name: 'temoin',
    prompt: 'noop',
    cron_expr: '0 4 * * *',
  });
  db.prepare('UPDATE triggers SET next_run_at = ? WHERE id = ?').run(1, r.id);
  const before = dbApi.listTasks().length;
  await tickRoutines();
  const tasks = dbApi.listTasks();
  assert.equal(tasks.length, before + 1);
  assert.ok(tasks.some((t) => t.title === 'ping' && t.routine_id === r.id));
});

test('rooks backup enable : POST /api/backup/enable sur le témoin, pas le :3000', async () => {
  const home = freshHome();
  const mock = await startMock({
    ok: true,
    enabled: true,
    cron: '30 3 * * *',
    keep: 7,
    dir: join(home, 'backups'),
    last_run_at: null,
    next_run_at: Date.now() + 3_600_000,
    archives: [],
  });
  try {
    const env = baseEnv(home);
    env.ROOKS_API_TOKEN = 'tok';
    const r = await runRooks(['--daemon', mock.url, 'backup', 'enable'], env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(mock.seen.length, 1);
    assert.equal(mock.seen[0]?.method, 'POST');
    assert.equal(mock.seen[0]?.url, '/api/backup/enable');
    assert.match(r.stdout, /enabled/);
  } finally {
    await mock.close();
  }
});

test('rooks backup status : GET /api/backup/status', async () => {
  const home = freshHome();
  const mock = await startMock({
    enabled: false,
    cron: '30 3 * * *',
    keep: 7,
    dir: join(home, 'backups'),
    last_run_at: null,
    next_run_at: null,
    archives: [],
  });
  try {
    const env = baseEnv(home);
    env.ROOKS_API_TOKEN = 'tok';
    const r = await runRooks(['--daemon', mock.url, 'backup', 'status', '--json'], env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(mock.seen[0]?.method, 'GET');
    assert.equal(mock.seen[0]?.url, '/api/backup/status');
    const parsed = JSON.parse(r.stdout) as { enabled: boolean };
    assert.equal(parsed.enabled, false);
  } finally {
    await mock.close();
  }
});

test('rooks backup sans sous-commande : exit 64', async () => {
  const r = await runRooks(['backup'], baseEnv(freshHome()));
  assert.equal(r.code, 64);
  assert.match(r.stderr, /rooks backup <enable\|status>/);
});
