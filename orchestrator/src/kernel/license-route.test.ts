import '../test-home.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';
import { createHttpPlugin } from './http-service.js';
import { licenseState, setLicenseState } from '../license/runtime.js';
import { unlicensed } from '../license/license.js';

test('a paid route rechecks current rights even while its Cordis fiber stays mounted', async () => {
  const before = licenseState();
  const app = express();
  const root = new Context();
  await root.plugin(createHttpPlugin(app));
  const fiber = await root.plugin({ name: '@rooks/dreams', inject: ['http'], apply(ctx: Context) {
    ctx.http.router().post('/paid', (_req, res) => { res.json({ ran: true }); });
  } });
  app.get('/free', (_req, res) => { res.json({ free: true }); });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const paid = () => fetch(`${url}/paid`, { method: 'POST' });
  try {
    const valid = { ...unlicensed('missing'), status: 'valid' as const, reason: null,
      planId: 'paid', localFree: false, capabilities: undefined, edition: 'expert' as const, modules: ['@rooks/dreams'] };
    setLicenseState(valid);
    assert.equal((await paid()).status, 200);
    setLicenseState({ ...valid, modules: [] });
    assert.equal((await paid()).status, 403);
    assert.equal((await fetch(`${url}/free`)).status, 200);
    setLicenseState(valid);
    assert.equal((await paid()).status, 200);
    // A revoked licence falls back to Free, which covers every module.
    setLicenseState(unlicensed('revoked'));
    assert.equal((await paid()).status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fiber.dispose();
    setLicenseState(before);
  }
});
