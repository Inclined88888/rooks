/**
 * Numeric settings carry inclusive bounds (TIM-0124): an out-of-range value
 * is refused with a 400 that names the range, nothing reaches the database,
 * and the bounds travel to the UI with the setting.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { registerRoutes } from './routes.js';
import { createDaemonAuthMiddleware } from '../http/auth.js';
import { dbApi } from '../../db.js';
import { hashSessionToken, SESSION_COOKIE } from '../../users/session.js';
import { resolve, setSetting } from '../../settings.js';

const app = express();
app.use(createDaemonAuthMiddleware({ token: 'test-daemon', required: false }));
app.use(express.json());
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/settings`;
test.after(() => { server.close(); });

for (const key of ['TIMON_DAY_START_HOUR', 'TIMON_DAY_END_HOUR']) delete process.env[key];
const admin = createTestAccount(dbApi, { email: 'bounds@example.com', name: 'Admin', passwordHash: 'unused', isSuperadmin: true });
dbApi.createSession({ userId: admin.id, tokenHash: hashSessionToken('bounds-session'), expiresAt: Date.now() + 60_000 });
const cookie = `${SESSION_COOKIE}=bounds-session`;

const put = (key: string, value: unknown) => fetch(`${base}/${key}`, {
  method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ value }),
});

test('an hour outside its range is refused with a 400 naming the range', async () => {
  for (const [key, value, range] of [
    ['TIMON_DAY_END_HOUR', 25, 'between 0 and 24'],
    ['TIMON_DAY_END_HOUR', -1, 'between 0 and 24'],
    ['TIMON_DAY_START_HOUR', 24, 'between 0 and 23'],
  ] as const) {
    const res = await put(key, value);
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.ok(body.error.includes(`(${key}) must be ${range}, got ${value}`), body.error);
    assert.equal(dbApi.getAllSettings()[key], undefined);
  }
});

test('the edges stay valid: end=24 (always day) and end=0 (always night)', async () => {
  for (const [key, value] of [['TIMON_DAY_END_HOUR', 24], ['TIMON_DAY_END_HOUR', 0], ['TIMON_DAY_START_HOUR', 23], ['TIMON_DAY_START_HOUR', 0]] as const) {
    assert.equal((await put(key, value)).status, 200);
    assert.equal(resolve(key)?.value, value);
  }
  setSetting('TIMON_DAY_START_HOUR', null);
  setSetting('TIMON_DAY_END_HOUR', null);
});

test('the bounds are sent with the setting; unbounded settings say null', async () => {
  const data = await (await fetch(base, { headers: { cookie } })).json() as {
    settings: { key: string; min: number | null; max: number | null }[];
  };
  const find = (key: string) => data.settings.find((s) => s.key === key);
  assert.deepEqual({ min: find('TIMON_DAY_START_HOUR')?.min, max: find('TIMON_DAY_START_HOUR')?.max }, { min: 0, max: 23 });
  assert.deepEqual({ min: find('TIMON_DAY_END_HOUR')?.min, max: find('TIMON_DAY_END_HOUR')?.max }, { min: 0, max: 24 });
  assert.deepEqual({ min: find('TIMON_MAX_PARALLEL')?.min, max: find('TIMON_MAX_PARALLEL')?.max }, { min: null, max: null });
});
