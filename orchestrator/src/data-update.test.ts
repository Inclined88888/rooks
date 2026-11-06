import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import express from 'express';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { Agent, get } from 'node:http';
import {
  approveDataUpdate, assertDataUpdateApproved, protectDataBeforeOpen, readDataVersion, readSnapshotFailure, updateApprovalFile,
  updateNeedsApproval, writeDataVersion, DataUpdatePendingError,
} from './data-version.js';
import { createDataUpdate, ensureUpdateToken, mountDataUpdateRoutes, updateTokenFile } from './data-update.js';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'timon-update-'));
  const files = { home, dbPath: join(home, 'timon.db'), configPath: join(home, 'timon.config.json') };
  const db = new Database(files.dbPath);
  db.exec('CREATE TABLE original (value TEXT); INSERT INTO original VALUES (\'preserve\')');
  db.close();
  return files;
}

test('refusal and repeated restarts leave the legacy database and metadata untouched', () => {
  const files = fixture();
  try {
    const before = readFileSync(files.dbPath);
    for (let i = 0; i < 3; i++) {
      assert.equal(updateNeedsApproval(files, '0.1.1'), true);
      assert.throws(() => assertDataUpdateApproved(files, '0.1.1'), DataUpdatePendingError);
      assert.equal(createDataUpdate(files, '0.1.1', { migrate: async () => assert.fail() }).status().status, 'pending');
    }
    assert.deepEqual(readFileSync(files.dbPath), before);
    assert.equal(readDataVersion(files.home), null);
    assert.equal(existsSync(updateApprovalFile(files.home)), false);
    assert.equal(existsSync(join(files.home, 'backups')), false);
  } finally { rmSync(files.home, { recursive: true, force: true }); }
});

test('approval is version-specific; equal, downgrade and empty installations do not wait', () => {
  const files = fixture();
  try {
    writeDataVersion(files.home, '0.1.1');
    assert.equal(updateNeedsApproval(files, '0.1.1'), false);
    assert.equal(updateNeedsApproval(files, '0.1.0'), false);
    approveDataUpdate(files.home, '0.1.2');
    assert.equal(updateNeedsApproval(files, '0.1.2'), false);
    assert.equal(updateNeedsApproval(files, '0.1.3'), true);
    rmSync(files.dbPath);
    assert.equal(updateNeedsApproval(files, '0.1.3'), false);
  } finally { rmSync(files.home, { recursive: true, force: true }); }
});

test('authenticated explicit approval snapshots before migration, validates version, and serializes requests', async () => {
  const files = fixture();
  let release!: () => void;
  let migrations = 0;
  const update = createDataUpdate(files, '0.1.1', { migrate: async () => {
    migrations++;
    assert.equal(existsSync(join(files.home, 'backups', 'pre-0.1.1', 'timon.db')), true);
    await new Promise<void>((resolve) => { release = resolve; });
  } });
  const app = express();
  const token = ensureUpdateToken(files.home);
  mountDataUpdateRoutes(app, update, token);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/update`;
  const post = (body: unknown, auth = token, extra: Record<string, string> = {}) => fetch(`${base}/approve`, {
    method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await fetch(`${base}/status`)).status, 401);
    assert.equal((await post({ version: '0.1.1', approve: true }, '')).status, 401);
    assert.equal((await post({ version: '0.1.1', approve: true }, 'daemon-token')).status, 401);
    assert.equal((await post({ version: '0.1.1', approve: true }, token, { Origin: 'http://localhost' })).status, 401);
    assert.equal((await post({ version: '0.1.1', approve: false })).status, 400);
    assert.equal((await post({ version: '0.1.2', approve: true })).status, 409);
    assert.equal(existsSync(updateApprovalFile(files.home)), false);
    const pending = post({ version: '0.1.1', approve: true });
    const deadline = Date.now() + 2_000;
    while (migrations === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(migrations, 1);
    assert.equal((await post({ version: '0.1.1', approve: true })).status, 409);
    release();
    assert.equal((await pending).status, 200);
    assert.equal((await post({ version: '0.1.1', approve: true })).status, 200);
    assert.equal(migrations, 1);
    assert.equal(update.status().status, 'ready');
    assert.equal(readDataVersion(files.home), '0.1.1');
    const cli = await promisify(execFile)(process.execPath, ['bin/timon', 'update', 'status'], {
      env: { ...process.env, TIMON_HOME: files.home, PORT: String(address.port), TIMON_API: 'http://invalid.example', TIMON_API_TOKEN: 'irrelevant' },
      timeout: 5_000,
    });
    assert.equal((JSON.parse(cli.stdout) as { status: string }).status, 'ready');
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(files.home, { recursive: true, force: true }); }
});

test('failed destructive backup blocks migration, stays retryable, and additive failures warn', async () => {
  for (const destructive of [true, false]) {
    const files = fixture();
    let migrations = 0;
    try {
      writeFileSync(join(files.home, 'backups'), 'not a directory');
      const update = createDataUpdate(files, '0.1.1', {
        migrate: async () => { migrations++; },
        destructive: destructive ? [{ id: 'drop-original', breaks: ['original'], applied: () => false }] : [],
      });
      assert.equal(await update.approve(), destructive ? 500 : 200);
      assert.equal(migrations, destructive ? 0 : 1);
      assert.equal(readDataVersion(files.home), null);
      assert.equal(update.status().backup.failure?.blocking, destructive);
      assert.equal(update.status().backup.failure?.partial, undefined);
      assert.equal(readSnapshotFailure(files.home)?.blocking, destructive);
      if (destructive) {
        assert.match(update.status().error ?? '', /could not save a copy/);
        rmSync(join(files.home, 'backups'));
        assert.equal(await update.approve(), 200);
        assert.equal(migrations, 1);
      }
    } finally { rmSync(files.home, { recursive: true, force: true }); }
  }
});

test('the real entry point serves pending health before any database or config migration', { timeout: 25_000 }, async () => {
  const files = fixture();
  writeFileSync(files.configPath, JSON.stringify({ version: 0 }));
  const before = readFileSync(files.dbPath);
  const configBefore = readFileSync(files.configPath);
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/boot.ts'], {
    env: { ...process.env, TIMON_HOME: files.home, PORT: String(address.port), TIMON_DESKTOP_SERVICE: '1', TIMON_RESOURCE_GUARD_ENABLED: '0' },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const exited = once(child, 'exit');
  try {
    let ready = false;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const res = await fetch(`http://127.0.0.1:${address.port}/api/health`, { signal: AbortSignal.timeout(500) });
        const body = await res.json() as { status: string };
        if (body.status === 'update_pending') { ready = true; break; }
      } catch { /* Bounded wait for the cold TypeScript entry point. */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, output);
    assert.ok(existsSync(updateTokenFile(files.home)));
    assert.deepEqual(readFileSync(files.dbPath), before);
    assert.deepEqual(readFileSync(files.configPath), configBefore);
    assert.equal(readDataVersion(files.home), null);
    child.kill();
    await exited;
    // Exercise the real migration handoff without starting host jobs in the test process.
    const witness = join(files.home, 'migration-witness.mjs');
    writeFileSync(witness, `
      import { createServer } from 'node:net';
      import { waitForDataUpdate } from ${JSON.stringify(new URL('./data-update-boot.ts', import.meta.url).href)};
      await waitForDataUpdate();
      const server = createServer().listen(${address.port}, '127.0.0.1', () => {
        console.log('port reclaimed');
        server.close();
      });
    `);
    const migrate = spawn(process.execPath, ['--import', 'tsx', witness], {
      env: { ...process.env, TIMON_HOME: files.home, PORT: String(address.port), TIMON_DESKTOP_SERVICE: '1', TIMON_RESOURCE_GUARD_ENABLED: '0' },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
    });
    let migrationOutput = '';
    migrate.stdout.on('data', (chunk: Buffer) => { migrationOutput += chunk.toString(); });
    migrate.stderr.on('data', (chunk: Buffer) => { migrationOutput += chunk.toString(); });
    const migrated = once(migrate, 'exit');
    const agent = new Agent({ keepAlive: true });
    try {
      let version: string | undefined;
      const deadline = Date.now() + 10_000;
      while (!version && Date.now() < deadline) {
        try {
          const status = await fetch(`http://127.0.0.1:${address.port}/api/update/status`, {
            headers: { Authorization: `Bearer ${readFileSync(updateTokenFile(files.home), 'utf8').trim()}` },
            signal: AbortSignal.timeout(500),
          });
          version = (await status.json() as { daemonVersion: string }).daemonVersion;
        } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
      }
      assert.ok(version, migrationOutput);
      // Keep a real idle socket open while the CLI approves on another connection.
      await new Promise<void>((resolve, reject) => {
        const request = get(`http://127.0.0.1:${address.port}/api/health`, { agent }, (res) => {
          assert.equal(res.headers.connection, 'keep-alive');
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
          // TODO #477: the desktop only offers an update to a daemon that says it is packaged.
          res.on('end', () => { assert.equal((JSON.parse(body) as { packaged?: unknown }).packaged, true); resolve(); });
        });
        request.on('error', reject);
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(Object.values(agent.freeSockets).flat().length, 1);
      const cli = await promisify(execFile)(process.execPath, ['bin/timon', 'update', 'approve', version], {
        env: { ...process.env, TIMON_HOME: files.home, PORT: String(address.port) }, timeout: 10_000,
      });
      assert.equal((JSON.parse(cli.stdout) as { status: string }).status, 'ready');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const exit = await Promise.race([
          migrated,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`Port handoff waited for keep-alive: ${migrationOutput}`)), 1500);
          }),
        ]);
        assert.equal(exit[0], 0, migrationOutput);
        assert.match(migrationOutput, /port reclaimed/);
      } finally { clearTimeout(timer); }
      const db = new Database(files.dbPath, { readonly: true });
      try { assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'users'").get()); }
      finally { db.close(); }
      assert.equal(readDataVersion(files.home), version);
    } finally { agent.destroy(); migrate.kill(); await migrated; }
  } finally { child.kill(); await exited; rmSync(files.home, { recursive: true, force: true }); }
});

test('approval status counts plugin data and returns completed copy progress', async () => {
  const files = fixture();
  try {
    const base = createDataUpdate(files, '0.1.1', { migrate: async () => {} }).status().backup.requiredBytes;
    mkdirSync(join(files.home, 'plugins-data'));
    writeFileSync(join(files.home, 'plugins-data', 'payload'), Buffer.alloc(1024 * 1024));
    const update = createDataUpdate(files, '0.1.1', { migrate: async () => {} });
    assert.ok((update.status().backup.requiredBytes ?? 0) > (base ?? 0) + 1024 * 1024);
    assert.equal(await update.approve(), 200);
    assert.equal(update.status().backup.progress?.phase, 'complete');
    assert.equal(update.status().backup.progress?.copiedBytes, 1024 * 1024);
  } finally { rmSync(files.home, { recursive: true, force: true }); }
});

test('a partial backup reaches the update window as the failure recorded on disk', async () => {
  const files = fixture();
  try {
    mkdirSync(join(files.home, 'plugins', 'sample'), { recursive: true });
    // Refused by the plugin backup: database and configuration are saved, the plugins are not.
    writeFileSync(join(files.home, 'plugins-data'), 'not a directory');
    const update = createDataUpdate(files, '0.1.1', { migrate: async () => {} });
    assert.equal(await update.approve(), 200);
    const failure = update.status().backup.failure;
    assert.equal(failure?.partial, true);
    assert.equal(failure?.blocking, false);
    assert.deepEqual(failure, readSnapshotFailure(files.home));
    assert.equal(failure?.at, JSON.parse(readFileSync(join(files.home, 'backups', 'snapshot-failure.json'), 'utf8')).at);
  } finally { rmSync(files.home, { recursive: true, force: true }); }
});

test('without any copy, the update window gets the last attempt, the one db.ts makes again when it loads', async () => {
  const files = fixture();
  try {
    // A configuration the copy cannot read: nothing is saved, the migration is additive.
    mkdirSync(files.configPath);
    const update = createDataUpdate(files, '0.1.1', { migrate: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      // What importing db.ts does: data-version did not move, so it tries the copy again.
      protectDataBeforeOpen(files, '0.1.1', { warn: () => {} });
    } });
    assert.equal(await update.approve(), 200);
    const failure = update.status().backup.failure;
    assert.equal(failure?.blocking, false);
    assert.equal(failure?.partial, undefined);
    // The desktop marks this one as shown: the main window must not find a newer one to show again.
    assert.equal(failure?.at, JSON.parse(readFileSync(join(files.home, 'backups', 'snapshot-failure.json'), 'utf8')).at);
  } finally { rmSync(files.home, { recursive: true, force: true }); }
});
