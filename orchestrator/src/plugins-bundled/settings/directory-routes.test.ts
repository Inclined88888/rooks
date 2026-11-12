/**
 * The folder browser a window uses when the folder lives on another machine
 * (TIM-0136). The refusals first: a listing of the disk is no public read.
 * Then what it lists: folders only, built by the daemon, with their parent.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import express from 'express';

await import('../../../tests/helpers/paid-license.js');
const { registerDirectoryRoutes, filesystemRoots } = await import('./directory-routes.js');
const { dbApi } = await import('../../db.js');

const admin = createTestAccount(dbApi, { email: 'dir-admin@example.com', name: 'admin', passwordHash: 'x', isSuperadmin: true });
const member = createTestAccount(dbApi, { email: 'dir-member@example.com', name: 'member', passwordHash: 'x' });
dbApi.createMission('dir-mission', 'acme.coder', 'look around', undefined, admin.id);

type Fake = { kind: 'daemon-token' | 'session' | 'api-token' | 'device'; userId?: string; missionId?: string | null; permissions?: string[] };
const app = express();
app.use((req, _res, next) => {
  const raw = req.header('x-test-auth');
  if (raw) {
    const fake = JSON.parse(raw) as Fake;
    const user = fake.userId ? dbApi.getUserById(fake.userId) ?? null : null;
    req.auth = {
      kind: fake.kind, user,
      isSuperadmin: fake.kind === 'daemon-token' || !!user?.is_superadmin,
      missionId: fake.missionId ?? null,
      ...(fake.kind === 'api-token' ? { permissions: fake.permissions ?? [] } : {}),
    };
  }
  next();
});
registerDirectoryRoutes(app);
const server = createServer(app);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

const root = mkdtempSync(join(tmpdir(), 'rooks-dirs-'));
mkdirSync(join(root, 'beta'));
mkdirSync(join(root, 'Alpha'));
mkdirSync(join(root, '.hidden'));
writeFileSync(join(root, 'notes.md'), 'not a folder');
let linked = false;
try { symlinkSync(join(root, 'beta'), join(root, 'gamma-link'), 'dir'); linked = true; } catch { /* Windows without the right to make links. */ }

async function list(path: string | null, who: Fake | null, files?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const params = new URLSearchParams();
  if (path !== null) params.set('path', path);
  if (files !== undefined) params.set('files', files);
  const query = params.size ? `?${params.toString()}` : '';
  const res = await fetch(`${base}/api/host/directories${query}`, {
    headers: who ? { 'x-test-auth': JSON.stringify(who) } : {},
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

const asAdmin: Fake = { kind: 'session', userId: admin.id };

test('an anonymous caller is refused, even before any check of the path', async () => {
  assert.equal((await list(root, null)).status, 401);
});

test('a signed-in member who may store no folder is refused', async () => {
  const out = await list(root, { kind: 'session', userId: member.id });
  assert.equal(out.status, 403);
  assert.equal(out.json.error, 'forbidden');
});

test('an agent mission is refused, even launched by a superadmin', async () => {
  assert.equal((await list(root, { kind: 'api-token', userId: admin.id, missionId: 'dir-mission' })).status, 403);
});

test('the folders of a directory, sorted, without its files, with their parent', async () => {
  const out = await list(root, asAdmin);
  assert.equal(out.status, 200);
  assert.equal(out.json.path, root);
  assert.equal(out.json.parent, dirname(root));
  assert.equal(out.json.truncated, false);
  const entries = out.json.entries as Array<{ name: string; path: string; hidden: boolean }>;
  const expected = ['.hidden', 'Alpha', 'beta', ...(linked ? ['gamma-link'] : [])];
  assert.deepEqual(entries.map((e) => e.name), expected);
  assert.deepEqual(entries.find((e) => e.name === 'Alpha'), { name: 'Alpha', path: join(root, 'Alpha'), hidden: false });
  assert.equal(entries.find((e) => e.name === '.hidden')?.hidden, true);
  assert.ok(Array.isArray(out.json.roots) && (out.json.roots as string[]).length > 0);
});

test('a remote machine reaches it with its device token', async () => {
  assert.equal((await list(root, { kind: 'device', userId: admin.id })).status, 200);
});

test('without a path it opens on the home folder', async () => {
  const out = await list(null, asAdmin);
  assert.equal(out.status, 200);
  assert.equal(typeof out.json.home, 'string');
  assert.equal(out.json.path, out.json.home);
});

test('a filesystem root has no parent', async () => {
  const top = parse(root).root;
  const out = await list(top, asAdmin);
  assert.equal(out.status, 200);
  assert.equal(out.json.parent, null);
});

test('a relative path, a file and a missing folder are refused by name', async () => {
  assert.deepEqual(await list('relative/dir', asAdmin), { status: 400, json: { error: 'relative_path' } });
  assert.deepEqual(await list(join(root, 'notes.md'), asAdmin), { status: 400, json: { error: 'not_a_directory' } });
  assert.deepEqual(await list(join(root, 'nope'), asAdmin), { status: 404, json: { error: 'not_found' } });
});

test('an unknown query key is refused', async () => {
  const res = await fetch(`${base}/api/host/directories?path=${encodeURIComponent(root)}&content=1`, {
    headers: { 'x-test-auth': JSON.stringify(asAdmin) },
  });
  assert.equal(res.status, 400);
});

// File mode (TODO #791): the refusals first, each with the filter set, so the
// new branch is proven to sit behind the same gate and a stricter one.
const settingsWriter: Fake = { kind: 'api-token', permissions: ['settings:write'] };

test('file mode: an anonymous caller is refused', async () => {
  assert.equal((await list(root, null, '*')).status, 401);
});

test('file mode: an agent mission is refused, even launched by a superadmin', async () => {
  assert.equal((await list(root, { kind: 'api-token', userId: admin.id, missionId: 'dir-mission' }, '*')).status, 403);
});

test('file mode: a member who may store no folder is refused', async () => {
  assert.equal((await list(root, { kind: 'session', userId: member.id }, '*')).status, 403);
});

test('file mode: a caller who may list folders but is no superadmin is refused', async () => {
  assert.equal((await list(root, settingsWriter)).status, 200);
  const out = await list(root, settingsWriter, '*');
  assert.equal(out.status, 403);
  assert.equal(out.json.error, 'forbidden');
  assert.equal(out.json.files, undefined);
});

const fileRoot = mkdtempSync(join(tmpdir(), 'rooks-files-'));
mkdirSync(join(fileRoot, 'pkg'));
writeFileSync(join(fileRoot, 'plugin.tgz'), 'x');
writeFileSync(join(fileRoot, 'other.TAR.GZ'), 'x');
writeFileSync(join(fileRoot, 'bundle.zip'), 'x');
writeFileSync(join(fileRoot, 'notes.md'), 'x');
writeFileSync(join(fileRoot, '.env'), 'x');
writeFileSync(join(fileRoot, '.zip'), 'x');
let fileLinked = false;
try {
  symlinkSync(join(fileRoot, 'plugin.tgz'), join(fileRoot, 'linked.tgz'), 'file');
  symlinkSync(join(fileRoot, 'gone.tgz'), join(fileRoot, 'dangling.tgz'), 'file');
  fileLinked = true;
} catch { /* Windows without the right to make links. */ }

test('file mode: the files of the level, sorted, apart from its folders', async () => {
  const out = await list(fileRoot, asAdmin, '*');
  assert.equal(out.status, 200);
  assert.deepEqual((out.json.entries as Array<{ name: string }>).map((e) => e.name), ['pkg']);
  const files = out.json.files as Array<{ name: string; path: string; hidden: boolean }>;
  const expected = ['.env', '.zip', 'bundle.zip', ...(fileLinked ? ['linked.tgz'] : []), 'notes.md', 'other.TAR.GZ', 'plugin.tgz'];
  assert.deepEqual(files.map((f) => f.name), expected);
  assert.deepEqual(files.find((f) => f.name === 'plugin.tgz'), { name: 'plugin.tgz', path: join(fileRoot, 'plugin.tgz'), hidden: false });
  assert.equal(files.find((f) => f.name === '.env')?.hidden, true);
  assert.equal(out.json.selected, undefined);
});

test('file mode: a window driving this machine with a superadmin\'s device token gets the files', async () => {
  const out = await list(fileRoot, { kind: 'device', userId: admin.id }, '*');
  assert.equal(out.status, 200);
  assert.ok(Array.isArray(out.json.files));
  assert.equal((await list(fileRoot, { kind: 'device', userId: member.id }, '*')).status, 403);
});

test('file mode: a filter keeps the endings asked, whatever their case', async () => {
  const out = await list(fileRoot, asAdmin, '.tgz,.tar.gz,.zip');
  const names = (out.json.files as Array<{ name: string }>).map((f) => f.name);
  // `.zip` alone is a dotfile named zip, not an archive.
  assert.deepEqual(names, ['bundle.zip', ...(fileLinked ? ['linked.tgz'] : []), 'other.TAR.GZ', 'plugin.tgz']);
});

test('file mode: a path naming a file opens its folder, the file selected', async () => {
  const out = await list(join(fileRoot, 'notes.md'), asAdmin, '*');
  assert.equal(out.status, 200);
  assert.equal(out.json.path, fileRoot);
  assert.equal(out.json.selected, join(fileRoot, 'notes.md'));
});

test('file mode: a file out of the filter opens its folder, nothing selected', async () => {
  const out = await list(join(fileRoot, 'notes.md'), asAdmin, '.tgz,.tar.gz,.zip');
  assert.equal(out.status, 200);
  assert.equal(out.json.path, fileRoot);
  assert.equal(out.json.selected, undefined);
  assert.ok(!(out.json.files as Array<{ name: string }>).some((f) => f.name === 'notes.md'));
  // In the filter, the same request selects it, whatever the case of its ending.
  const kept = await list(join(fileRoot, 'other.TAR.GZ'), asAdmin, '.tgz,.tar.gz,.zip');
  assert.equal(kept.json.selected, join(fileRoot, 'other.TAR.GZ'));
});

test('folder mode is unchanged: no files field, a file is still no folder', async () => {
  const out = await list(fileRoot, asAdmin);
  assert.equal(out.json.files, undefined);
  assert.equal((await list(join(fileRoot, 'notes.md'), asAdmin)).json.error, 'not_a_directory');
});

test('file mode: a filter that could name a path is refused', async () => {
  for (const bad of ['1', '../x', '.tgz/..', '.a,..', '.a\\b', 'tgz', '.a.b.c', '']) {
    assert.equal((await list(fileRoot, asAdmin, bad)).status, 400, bad);
  }
});

test('Windows roots are the drives that answer', () => {
  const present = new Set(['C:\\', 'D:\\']);
  assert.deepEqual(filesystemRoots('win32', (p) => present.has(p)), ['C:\\', 'D:\\']);
  assert.equal(filesystemRoots('linux').length, 1);
});
