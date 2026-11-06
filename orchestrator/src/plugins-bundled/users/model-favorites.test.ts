/**
 * ModelPicker favourites — GET / PUT /api/prefs/model-favorites. Anonymous
 * is refused by the route itself (the witness middleware lets anonymous
 * through, as on a fresh install), two accounts never see each other's
 * stars, a daemon-token with no account reads `[]` and cannot write, and the
 * body is zod-strict and bounded.
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

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-model-favorites-'));
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE, hashSessionToken, issueSessionToken } = await import('../../users/session.js');
const { MODEL_FAVORITES_MAX, parseStoredModelFavorites } = await import('../../users/model-favorites.js');

const TOKEN = 'witness-model-favorites-daemon-token';
const PATH = '/api/prefs/model-favorites';

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

function sessionFor(userId: string): string {
  const raw = issueSessionToken();
  dbApi.createSession({ tokenHash: hashSessionToken(raw), userId, expiresAt: Date.now() + 60_000 });
  return raw;
}

async function call(
  method: string,
  opts: { body?: unknown; cookie?: string; bearer?: string } = {},
): Promise<{ status: number; json: { favorites?: unknown; error?: unknown } }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${PATH}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  return { status: res.status, json: await res.json() as { favorites?: unknown; error?: unknown } };
}

test('anonymous is refused by the route, on read and on write', async () => {
  assert.equal(dbApi.countUsers(), 0, 'the middleware lets anonymous through only with no account');
  assert.equal((await call('GET')).status, 401);
  assert.equal((await call('PUT', { body: { favorites: [] } })).status, 401);
});

test('daemon-token without an account: GET is empty, PUT is 403', async () => {
  const get = await call('GET', { bearer: TOKEN });
  assert.equal(get.status, 200);
  assert.deepEqual(get.json.favorites, []);
  const put = await call('PUT', { bearer: TOKEN, body: { favorites: [{ backend: 'claude', model: 'opus' }] } });
  assert.equal(put.status, 403);
});

test('A and B keep their own stars; neither reads nor overwrites the other', async () => {
  const ada = createTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', passwordHash: 'x', isSuperadmin: false });
  const bob = createTestAccount(dbApi, { email: 'bob@example.com', name: 'Bob', passwordHash: 'x', isSuperadmin: false });
  const adaCookie = sessionFor(ada.id);
  const bobCookie = sessionFor(bob.id);

  const adaList = [
    { backend: 'claude@krz', model: 'opus' },
    { backend: 'claude', model: 'opus' },
  ];
  const put = await call('PUT', { cookie: adaCookie, body: { favorites: adaList } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json.favorites, adaList, 'the same model on two accounts is two favourites, order kept');

  const bobRead = await call('GET', { cookie: bobCookie });
  assert.equal(bobRead.status, 200);
  assert.deepEqual(bobRead.json.favorites, [], 'B does not see A\'s stars');

  const bobPut = await call('PUT', { cookie: bobCookie, body: { favorites: [{ backend: 'codex', model: 'gpt-5.5' }] } });
  assert.equal(bobPut.status, 200);
  const adaRead = await call('GET', { cookie: adaCookie });
  assert.deepEqual(adaRead.json.favorites, adaList, 'B writing his list leaves A\'s untouched');

  // Anonymous, once accounts exist, is the middleware's 401.
  assert.equal((await call('GET')).status, 401);

  // The chrome prefs of a row created by the favourites stay the defaults.
  assert.equal(dbApi.userPrefsGet(bob.id).scheme, dbApi.userPrefsGet(null).scheme);
});

test('the body is strict and bounded; duplicates collapse', async () => {
  const carl = createTestAccount(dbApi, { email: 'carl@example.com', name: 'Carl', passwordHash: 'x', isSuperadmin: false });
  const cookie = sessionFor(carl.id);
  const pair = { backend: 'claude', model: 'opus' };

  const tooMany = Array.from({ length: MODEL_FAVORITES_MAX + 1 }, (_, i) => ({ backend: 'claude', model: `m${i}` }));
  assert.equal((await call('PUT', { cookie, body: { favorites: tooMany } })).status, 400);
  assert.equal((await call('PUT', { cookie, body: { favorites: [{ ...pair, extra: 1 }] } })).status, 400);
  assert.equal((await call('PUT', { cookie, body: { favorites: [pair], user: 'someone' } })).status, 400);
  assert.equal((await call('PUT', { cookie, body: { favorites: [{ backend: '', model: 'opus' }] } })).status, 400);
  assert.equal((await call('PUT', { cookie, body: { favorites: [{ backend: 'x'.repeat(129), model: 'opus' }] } })).status, 400);
  assert.equal((await call('PUT', { cookie, body: { favorites: [{ backend: 'claude', model: 'x'.repeat(257) }] } })).status, 400);
  assert.equal((await call('PUT', { cookie, body: {} })).status, 400);

  const max = Array.from({ length: MODEL_FAVORITES_MAX }, (_, i) => ({ backend: 'claude', model: `m${i}` }));
  assert.equal((await call('PUT', { cookie, body: { favorites: max } })).status, 200);

  const dup = await call('PUT', { cookie, body: { favorites: [pair, { backend: 'codex', model: 'gpt-5.5' }, pair] } });
  assert.equal(dup.status, 200);
  assert.deepEqual(dup.json.favorites, [pair, { backend: 'codex', model: 'gpt-5.5' }]);

  const cleared = await call('PUT', { cookie, body: { favorites: [] } });
  assert.deepEqual(cleared.json.favorites, []);
});

test('a malformed stored value reads as an empty list, never a throw', () => {
  assert.deepEqual(parseStoredModelFavorites('not json'), []);
  assert.deepEqual(parseStoredModelFavorites('{"backend":"claude"}'), []);
  assert.deepEqual(
    parseStoredModelFavorites('[{"backend":"claude","model":"opus"},{"backend":3},null]'),
    [{ backend: 'claude', model: 'opus' }],
  );
});
