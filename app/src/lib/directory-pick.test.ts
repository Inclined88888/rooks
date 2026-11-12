import test from 'node:test';
import assert from 'node:assert/strict';
import { directoryPickSource, nativePickerReachesDaemon, openingListing, pickDirectory, readDirectories } from './directory-pick';

test('no desktop bridge: the picker is reported unavailable, not silently skipped', async () => {
  assert.deepEqual(await pickDirectory(null, ''), { status: 'unavailable' });
  assert.deepEqual(await pickDirectory({}, '/x'), { status: 'unavailable' });
});

test('a chosen folder is returned as-is, and the current value seeds the dialog', async () => {
  const seen: Array<string | undefined> = [];
  const result = await pickDirectory({
    selectDirectory: async (defaultPath) => { seen.push(defaultPath); return 'C:\\Users\\me\\Vault'; },
  }, '/old/vault');
  assert.deepEqual(result, { status: 'chosen', path: 'C:\\Users\\me\\Vault' });
  assert.deepEqual(seen, ['/old/vault']);
});

test('an empty current value passes no default path', async () => {
  let received: string | undefined = 'unset';
  await pickDirectory({ selectDirectory: async (d) => { received = d; return null; } }, '');
  assert.equal(received, undefined);
});

test('cancelling the dialog is not an error', async () => {
  assert.deepEqual(await pickDirectory({ selectDirectory: async () => null }, ''), { status: 'cancelled' });
});

test('a rejected dialog is reported as failed', async () => {
  assert.deepEqual(
    await pickDirectory({ selectDirectory: async () => { throw new Error('boom'); } }, ''),
    { status: 'failed' },
  );
});

test('TIM-0136: the OS dialog only when the active daemon runs on this computer', () => {
  const desktop = { selectDirectory: async () => null };
  assert.equal(directoryPickSource(desktop, 'local'), 'native');
  assert.equal(directoryPickSource(desktop, 'nas-01'), 'daemon');
  // A browser has no dialog handing back a path: the daemon lists its folders.
  assert.equal(directoryPickSource(null, 'local'), 'daemon');
  assert.equal(directoryPickSource({}, 'local'), 'daemon');
  assert.equal(nativePickerReachesDaemon('local'), true);
  assert.equal(nativePickerReachesDaemon('nas-01'), false);
});

const LISTING = { path: '/srv/vault', parent: '/srv', entries: [{ name: 'notes', path: '/srv/vault/notes', hidden: false }], truncated: false, home: '/home/robin', roots: ['/'] };

function fakeFetch(answers: Array<{ status: number; body: unknown }>, seen: string[]): typeof fetch {
  return (async (url: string) => {
    seen.push(url);
    const next = answers.shift() ?? { status: 500, body: {} };
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
}

test('a level is read from the proxy, the path encoded in the query', async () => {
  const seen: string[] = [];
  const out = await readDirectories('/srv/my vault', fakeFetch([{ status: 200, body: LISTING }], seen));
  assert.deepEqual(out, { ok: true, listing: LISTING });
  assert.deepEqual(seen, ['/api/ui/host/directories?path=%2Fsrv%2Fmy%20vault']);
});

test('the daemon names its refusals; a 404 without a name is an older daemon', async () => {
  const run = (status: number, body: unknown) => readDirectories('/x', fakeFetch([{ status, body }], []));
  assert.deepEqual(await run(404, { error: 'not_found' }), { ok: false, error: 'not_found' });
  assert.deepEqual(await run(403, { error: 'unreadable' }), { ok: false, error: 'unreadable' });
  assert.deepEqual(await run(403, { error: 'forbidden', code: 'account_lacks_permission' }), { ok: false, error: 'forbidden' });
  assert.deepEqual(await run(401, { error: 'unauthorized' }), { ok: false, error: 'forbidden' });
  assert.deepEqual(await run(404, '<html>Cannot GET</html>'), { ok: false, error: 'outdated' });
  assert.deepEqual(await run(200, { nope: true }), { ok: false, error: 'failed' });
});

test('the browser opens on the home folder when the current value is gone from that machine', async () => {
  const seen: string[] = [];
  const out = await openingListing('/old/vault', fakeFetch([{ status: 404, body: { error: 'not_found' } }, { status: 200, body: LISTING }], seen));
  assert.equal(out.ok, true);
  assert.deepEqual(seen, ['/api/ui/host/directories?path=%2Fold%2Fvault', '/api/ui/host/directories']);
});

test('an older daemon is not retried on the home folder', async () => {
  const seen: string[] = [];
  const out = await openingListing('/old/vault', fakeFetch([{ status: 404, body: '' }], seen));
  assert.deepEqual(out, { ok: false, error: 'outdated' });
  assert.equal(seen.length, 1);
});

// File mode (TODO #791).
const FILE_MODE = { kind: 'file', accept: ['.tgz', '.TAR.GZ', '.zip'] } as const;

test('file mode: the filter travels lower-cased, every file is `*`', async () => {
  const seen: string[] = [];
  const listing = { ...LISTING, files: [] };
  await readDirectories('/srv', fakeFetch([{ status: 200, body: listing }], seen), FILE_MODE);
  await readDirectories(null, fakeFetch([{ status: 200, body: listing }], seen), { kind: 'file', accept: [] });
  assert.deepEqual(seen, [
    '/api/ui/host/directories?path=%2Fsrv&files=.tgz%2C.tar.gz%2C.zip',
    '/api/ui/host/directories?files=*',
  ]);
});

test('file mode: a daemon without it is outdated, whether it refuses the key or ignores it', async () => {
  const run = (status: number, body: unknown) => readDirectories('/x', fakeFetch([{ status, body }], []), FILE_MODE);
  assert.deepEqual(await run(400, { error: 'invalid_query' }), { ok: false, error: 'outdated' });
  assert.deepEqual(await run(200, LISTING), { ok: false, error: 'outdated' });
  // Folder mode keeps reading a bare 400 as a failure, and a listing without files as one.
  assert.deepEqual(await readDirectories('/x', fakeFetch([{ status: 400, body: { error: 'invalid_query' } }], [])), { ok: false, error: 'failed' });
  assert.deepEqual(await readDirectories('/x', fakeFetch([{ status: 200, body: LISTING }], [])), { ok: true, listing: LISTING });
});

test('file mode: the opening keeps the mode on its fall back to the home folder', async () => {
  const seen: string[] = [];
  const out = await openingListing('/gone/claude', fakeFetch([{ status: 404, body: { error: 'not_found' } }, { status: 200, body: { ...LISTING, files: [] } }], seen), { kind: 'file', accept: [] });
  assert.equal(out.ok, true);
  assert.deepEqual(seen, ['/api/ui/host/directories?path=%2Fgone%2Fclaude&files=*', '/api/ui/host/directories?files=*']);
});
