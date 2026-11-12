/**
 * The `@rooks/machines` module mounts the fleet routes through the claimed
 * router, without colliding with the device routes it sits next to.
 */
import '../../test-home.js';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { createHttpPlugin } = await import('../../kernel/http-service.js');
const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerDeviceRoutes } = await import('../../users/devices-http.js');
const machines = await import('./index.js');

test('the module declares itself and mounts /api/machines*', async () => {
  assert.equal(machines.manifest.name, '@rooks/machines');
  assert.deepEqual(machines.inject, ['http', 'db']);
  const app = express();
  app.use(createDaemonAuthMiddleware({ token: 'witness-daemon-token', required: true }));
  app.use(express.json());
  const ctx = new Context();
  await ctx.plugin(createHttpPlugin(app));
  registerDeviceRoutes(ctx.http.router());
  assert.doesNotThrow(() => machines.apply(ctx));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as AddressInfo;
    assert.notEqual(port, 3000, 'the witness must not take the production port');
    // Mounted (an unknown route would be 401 too, so ask with the operator token:
    // the fleet refuses it with its own 403, an unmounted path would be 404).
    const res = await fetch(`http://127.0.0.1:${port}/api/machines`, { headers: { authorization: 'Bearer witness-daemon-token' } });
    assert.equal(res.status, 403);
    const missing = await fetch(`http://127.0.0.1:${port}/api/machines-nope`, { headers: { authorization: 'Bearer witness-daemon-token' } });
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});
