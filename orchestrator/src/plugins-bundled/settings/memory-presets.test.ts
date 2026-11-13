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
import { resolve, invalidateSettingsCache } from '../../settings.js';

const app = express();
app.use(createDaemonAuthMiddleware({ token: 'test-daemon', required: false }));
app.use(express.json());
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/settings`;
test.after(() => { server.close(); });
const apply = (body: unknown, cookie?: string) => fetch(`${base}/resource-memory-preset`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
});

test('anonymous preset writes are refused even before setup', async () => {
  assert.equal((await apply({ ramGb: 8 })).status, 401);
  assert.equal(dbApi.getAllSettings().ROOKS_MISSION_MEM_MAX_GB, undefined);
});

test('session permissions, validation, effective defaults and immediate cache invalidation', async () => {
  for (const key of ['ROOKS_MISSION_MEM_MAX_GB', 'ROOKS_DAY_MEM_MAX_GB', 'ROOKS_NIGHT_MEM_MAX_GB']) delete process.env[key];
  const admin = createTestAccount(dbApi, { email: 'admin@example.com', name: 'Admin', passwordHash: 'unused', isSuperadmin: true });
  const user = createTestAccount(dbApi, { email: 'user@example.com', name: 'User', passwordHash: 'unused' });
  for (const [row, token] of [[admin, 'admin-session'], [user, 'user-session']] as const) {
    dbApi.createSession({ userId: row.id, tokenHash: hashSessionToken(token), expiresAt: Date.now() + 60_000 });
  }
  const cookie = `${SESSION_COOKIE}=admin-session`;
  assert.equal((await apply({ ramGb: 8 }, `${SESSION_COOKIE}=user-session`)).status, 403);
  for (const invalid of [{ ramGb: 12 }, { ramGb: '8' }, {}, { ramGb: 8, extra: true }, null]) {
    assert.equal((await apply(invalid, cookie)).status, 400);
  }
  invalidateSettingsCache();
  resolve('ROOKS_MISSION_MEM_MAX_GB');
  assert.equal((await apply({ ramGb: 8 }, cookie)).status, 200);
  for (const [key, value] of [['ROOKS_MISSION_MEM_MAX_GB', 2], ['ROOKS_DAY_MEM_MAX_GB', 3], ['ROOKS_NIGHT_MEM_MAX_GB', 4]] as const) {
    assert.equal(resolve(key)?.value, value);
    assert.equal(resolve(key)?.source, 'db');
  }
  const response = await fetch(base, { headers: { cookie } });
  const data = await response.json() as { resourceMemory: { detectedRamGb: number; autoClassGb: number }; settings: { key: string; default: number }[] };
  assert.ok(data.resourceMemory.detectedRamGb > 0);
  assert.ok([8, 16, 32, 64].includes(data.resourceMemory.autoClassGb));
  assert.equal(data.settings.find((s) => s.key === 'ROOKS_DAY_MEM_MAX_GB')?.default, resolve('ROOKS_DAY_MEM_MAX_GB')?.def.default);
});
