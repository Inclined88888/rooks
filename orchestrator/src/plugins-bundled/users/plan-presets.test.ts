/**
 * Series-planner presets — GET / PUT /api/prefs/plan-presets. Anonymous is
 * refused by the route itself, two accounts never see each other's presets, a
 * daemon-token with no account reads `[]` and cannot write, the body is
 * zod-strict and bounded, and `updatedAt` is the daemon's.
 *
 * Witness server on 127.0.0.1:0, never :3000.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-plan-presets-'));
await import('../../../tests/helpers/paid-license.js');
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE, hashSessionToken, issueSessionToken } = await import('../../users/session.js');
const { PLAN_PRESETS_MAX, PLAN_PRESET_NAME_MAX, parseStoredPlanPresets } = await import('../../users/plan-presets.js');

const TOKEN = 'witness-plan-presets-daemon-token';
const PATH = '/api/prefs/plan-presets';

const app = express();
// `required: false`: anonymous reaches the route while no account exists, so
// the refusal tested first is the route's own, not the middleware's.
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: false }));
app.use(express.json());
registerRoutes(app, { setupPolicy: 'free' });

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness must not take the production port');
const base = `http://127.0.0.1:${port}`;

test.after(() => { server.close(); });

type StoredPreset = { id: string; name: string; roles: Record<string, { backend: string; model: string }>; updatedAt: number };

function sessionFor(userId: string): string {
  const raw = issueSessionToken();
  dbApi.createSession({ tokenHash: hashSessionToken(raw), userId, expiresAt: Date.now() + 60_000 });
  return raw;
}

async function call(
  method: string,
  opts: { body?: unknown; cookie?: string; bearer?: string } = {},
): Promise<{ status: number; json: { presets?: StoredPreset[]; error?: unknown } }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${PATH}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  return { status: res.status, json: await res.json() as { presets?: StoredPreset[]; error?: unknown } };
}

const NIGHT = {
  id: 'p-night',
  name: 'Night',
  roles: {
    code: { backend: 'claude@krz', model: 'opus' },
    review: { backend: 'codex', model: 'gpt-5.5' },
  },
};

test('anonymous is refused by the route, on read and on write', async () => {
  assert.equal(dbApi.countUsers(), 0, 'the middleware lets anonymous through only with no account');
  assert.equal((await call('GET')).status, 401);
  assert.equal((await call('PUT', { body: { presets: [NIGHT] } })).status, 401);
});

test('daemon-token without an account: GET is empty, PUT is 403', async () => {
  const get = await call('GET', { bearer: TOKEN });
  assert.equal(get.status, 200);
  assert.deepEqual(get.json.presets, []);
  assert.equal((await call('PUT', { bearer: TOKEN, body: { presets: [NIGHT] } })).status, 403);
});

test('A and B keep their own presets; neither reads nor overwrites the other', async () => {
  const ada = createTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', passwordHash: 'x', isSuperadmin: false });
  const bob = createTestAccount(dbApi, { email: 'bob@example.com', name: 'Bob', passwordHash: 'x', isSuperadmin: false });
  const adaCookie = sessionFor(ada.id);
  const bobCookie = sessionFor(bob.id);

  const put = await call('PUT', { cookie: adaCookie, body: { presets: [NIGHT] } });
  assert.equal(put.status, 200);
  assert.equal(put.json.presets?.length, 1);
  assert.deepEqual({ ...put.json.presets?.[0], updatedAt: 0 }, { ...NIGHT, updatedAt: 0 });

  const bobRead = await call('GET', { cookie: bobCookie });
  assert.equal(bobRead.status, 200);
  assert.deepEqual(bobRead.json.presets, [], 'B does not see A\'s presets');

  const bobPut = await call('PUT', {
    cookie: bobCookie,
    body: { presets: [{ id: 'p-night', name: 'Night', roles: { doc: { backend: 'claude', model: 'haiku' } } }] },
  });
  assert.equal(bobPut.status, 200);
  const adaRead = await call('GET', { cookie: adaCookie });
  assert.deepEqual(adaRead.json.presets, put.json.presets, 'B writing a preset of the same id and name leaves A\'s untouched');

  // Anonymous, once accounts exist, is the middleware's 401.
  assert.equal((await call('GET')).status, 401);
  assert.equal((await call('PUT', { body: { presets: [] } })).status, 401);

  // The chrome prefs and the favourites of a row created by the presets stay untouched.
  assert.equal(dbApi.userPrefsGet(bob.id).scheme, dbApi.userPrefsGet(null).scheme);
  assert.deepEqual(dbApi.userModelFavoritesGet(bob.id), []);
});

test('the body is strict and bounded', async () => {
  const carl = createTestAccount(dbApi, { email: 'carl@example.com', name: 'Carl', passwordHash: 'x', isSuperadmin: false });
  const cookie = sessionFor(carl.id);
  const pair = { backend: 'claude', model: 'opus' };
  const preset = (over: Record<string, unknown>) => ({ id: 'p1', name: 'One', roles: { code: pair }, ...over });
  const put = async (presets: unknown) => (await call('PUT', { cookie, body: { presets } })).status;

  const tooMany = Array.from({ length: PLAN_PRESETS_MAX + 1 }, (_, i) => preset({ id: `p${i}`, name: `n${i}` }));
  assert.equal(await put(tooMany), 400);
  assert.equal(await put([preset({ name: '' })]), 400);
  assert.equal(await put([preset({ name: '   ' })]), 400);
  assert.equal(await put([preset({ name: 'x'.repeat(PLAN_PRESET_NAME_MAX + 1) })]), 400);
  assert.equal(await put([preset({ id: '' })]), 400);
  assert.equal(await put([preset({ roles: {} })]), 400, 'a preset with no role is refused');
  assert.equal(await put([preset({ roles: { planner: pair } })]), 400, 'an unknown role is refused');
  assert.equal(await put([preset({ roles: { code: { ...pair, extra: 1 } } })]), 400);
  assert.equal(await put([preset({ roles: { code: { backend: '', model: 'opus' } } })]), 400);
  assert.equal(await put([preset({ roles: { code: { backend: 'x'.repeat(129), model: 'opus' } } })]), 400);
  assert.equal(await put([preset({ roles: { code: { backend: 'claude', model: 'x'.repeat(257) } } })]), 400);
  assert.equal(await put([preset({ owner: 'someone' })]), 400);
  assert.equal(await put([preset({ updatedAt: -1 })]), 400);
  assert.equal((await call('PUT', { cookie, body: { presets: [], user: 'someone' } })).status, 400);
  assert.equal((await call('PUT', { cookie, body: {} })).status, 400);

  const max = Array.from({ length: PLAN_PRESETS_MAX }, (_, i) => preset({ id: `p${i}`, name: `n${i}` }));
  assert.equal(await put(max), 200);
  assert.equal(await put([preset({ name: 'x'.repeat(PLAN_PRESET_NAME_MAX) })]), 200);
});

test('duplicates collapse by id and by name; updatedAt is stamped by the daemon, kept when nothing changed', async () => {
  const dana = createTestAccount(dbApi, { email: 'dana@example.com', name: 'Dana', passwordHash: 'x', isSuperadmin: false });
  const cookie = sessionFor(dana.id);
  const day = { id: 'p-day', name: '  Day ', roles: { review: { backend: 'codex', model: 'gpt-5.5' }, code: { backend: 'claude', model: 'opus' } } };

  const before = Date.now();
  const first = await call('PUT', {
    cookie,
    body: { presets: [day, { ...NIGHT, name: 'night' }, { ...NIGHT, id: 'other', name: 'DAY' }, { ...day, name: 'Again' }] },
  });
  assert.equal(first.status, 200);
  const stored = first.json.presets ?? [];
  assert.deepEqual(stored.map((p) => [p.id, p.name]), [['p-day', 'Day'], ['p-night', 'night']], 'first id and first name win, names trimmed');
  assert.deepEqual(Object.keys(stored[0].roles), ['code', 'review'], 'roles stored in the canonical order');
  assert.ok(stored.every((p) => p.updatedAt >= before));

  // A client sending a date of its own does not set it; an unchanged preset keeps its stamp.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const renamed = await call('PUT', {
    cookie,
    body: { presets: [{ ...stored[0], updatedAt: 1 }, { ...stored[1], name: 'Nightly', updatedAt: 1 }] },
  });
  const [dayAfter, nightAfter] = renamed.json.presets ?? [];
  assert.equal(dayAfter.updatedAt, stored[0].updatedAt, 'unchanged preset keeps its date');
  assert.ok(nightAfter.updatedAt > stored[1].updatedAt, 'renamed preset is stamped now');
  assert.notEqual(nightAfter.updatedAt, 1);

  const cleared = await call('PUT', { cookie, body: { presets: [] } });
  assert.deepEqual(cleared.json.presets, []);
});

test('a malformed stored value reads as an empty list, a malformed preset is skipped, never a throw', () => {
  assert.deepEqual(parseStoredPlanPresets('not json'), []);
  assert.deepEqual(parseStoredPlanPresets('{"id":"x"}'), []);
  assert.deepEqual(
    parseStoredPlanPresets(JSON.stringify([
      { id: 'a', name: 'A', roles: { code: { backend: 'claude', model: 'opus' } }, updatedAt: 3 },
      { id: 'b', name: 'B', roles: {} },
      { id: 'c', name: 'C', roles: { planner: { backend: 'claude', model: 'opus' } } },
      null,
    ])),
    [{ id: 'a', name: 'A', roles: { code: { backend: 'claude', model: 'opus' } }, updatedAt: 3 }],
  );
});
