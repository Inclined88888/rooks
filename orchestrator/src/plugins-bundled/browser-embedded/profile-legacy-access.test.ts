import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { dbApi } from '../../db.js';
import { registerRoutes } from './routes.js';

test('missions with a fixed profile cannot inspect or launch legacy browsers, including disabled assignments', async () => {
  let missionId: string | null = null;
  const app = express();
  app.use((req, _res, next) => {
    // Trusted middleware fixture; identity is never taken from the payload.
    req.auth = { kind: 'api-token', missionId, user: null, isSuperadmin: false, actorId: 'profile-test', permissions: [] };
    next();
  });
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const profile of [null, `bp-${randomUUID()}`]) {
      missionId = randomUUID();
      dbApi.createMission(missionId, 'scoped-browser-agent', 'test', undefined, 'profile-test');
      dbApi.setMissionBrowserProfile(missionId, profile);
      // Invalid slug is deliberate: even if the guard regresses, this witness
      // cannot start a real Docker container.
      for (const [method, path] of [
        ['GET', '/api/browser'],
        ['GET', '/api/browser/!invalid/status'],
        ['POST', '/api/browser/!invalid/start'],
        ['POST', '/api/browser/!invalid/stop'],
      ]) {
        const response = await fetch(`${origin}${path}`, { method });
        assert.equal(response.status, 403, `${method} ${path} must refuse a ${profile === null ? 'disabled' : 'fixed'} profile`);
        assert.match((await response.json() as { error: string }).error, /assigned browser profile/);
      }
    }
    missionId = randomUUID();
    dbApi.createMission(missionId, 'legacy-browser-agent', 'legacy fixture', undefined, 'profile-test');
    assert.equal((await fetch(`${origin}/api/browser`)).status, 200, 'an unresolved historical mission retains the legacy read path');
    missionId = null;
    assert.equal((await fetch(`${origin}/api/browser`)).status, 200, 'operator access remains available');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
