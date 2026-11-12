import './test-home.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

const { agentDir } = await import('./paths.js');
await import('../tests/helpers/claude-provider.js');

const { registerRoutes } = await import('./plugins-bundled/agents/routes.js');

mkdirSync(agentDir('scoped'), { recursive: true });
writeFileSync(join(agentDir('scoped'), 'config.json'), JSON.stringify({ cwd: process.env.ROOKS_HOME }));
const scope = () => (JSON.parse(readFileSync(join(agentDir('scoped'), 'config.json'), 'utf8')) as { memory_scope?: string }).memory_scope;

async function patch(body: unknown): Promise<Response> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = { kind: 'api-token', user: null, isSuperadmin: true, permissions: ['*'] };
    next();
  });
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    return await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agents/scoped/config`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('PATCH config applies memory_scope (`rooks agent set-scope` used to be a silent no-op)', async () => {
  assert.equal((await patch({ memory_scope: 'AGENT' })).status, 200);
  assert.equal(scope(), 'AGENT');
});

test('PATCH config refuses an unknown memory_scope', async () => {
  assert.equal((await patch({ memory_scope: 'EVERYTHING' })).status, 400);
  assert.equal(scope(), 'AGENT');
});
