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

function seed(name: string, config: Record<string, unknown> = {}) {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify({ cwd: process.env.TIMON_HOME, ...config }));
}
const reportsTo = (name: string) => (JSON.parse(readFileSync(join(agentDir(name), 'config.json'), 'utf8')) as { reports_to?: string | null }).reports_to;

seed('boss');
seed('lead', { reports_to: 'boss' });
seed('dev', { reports_to: 'lead' });

async function patch(name: string, body: unknown, permissions: string[] = ['agents:manage']): Promise<Response> {
  const app = express();
  app.use(express.json());
  // Stand-in for the daemon's auth middleware.
  app.use((req, _res, next) => {
    req.auth = { kind: 'api-token', user: null, isSuperadmin: permissions.includes('*'), permissions };
    next();
  });
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    return await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agents/${name}/config`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('a caller without agents:manage cannot move an agent in the hierarchy', async () => {
  assert.equal((await patch('dev', { reports_to: 'boss' }, [])).status, 403);
  assert.equal(reportsTo('dev'), 'lead');
});

test('reports_to refuses an unknown agent, the agent itself and a cycle', async () => {
  assert.equal((await patch('dev', { reports_to: 'ghost' }, ['*'])).status, 400);
  assert.equal((await patch('dev', { reports_to: 'dev' }, ['*'])).status, 400);
  assert.equal((await patch('boss', { reports_to: 'dev' }, ['*'])).status, 400, 'boss ← lead ← dev');
  assert.equal((await patch('dev', { reports_to: 42 }, ['*'])).status, 400);
  assert.equal(reportsTo('boss'), undefined);
  assert.equal(reportsTo('dev'), 'lead');
});

test('reports_to moves an agent, and null hands it back to the default', async () => {
  assert.equal((await patch('dev', { reports_to: 'boss' }, ['*'])).status, 200);
  assert.equal(reportsTo('dev'), 'boss');
  assert.equal((await patch('dev', { reports_to: null }, ['*'])).status, 200);
  assert.equal(reportsTo('dev'), null);
});

test('saving an agent from the editor keeps its reporting line and team', async () => {
  seed('keeper', { reports_to: 'boss', team: 'core', role: 'coder' });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = { kind: 'api-token', user: null, isSuperadmin: true, permissions: ['*'] };
    next();
  });
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agents`;
  const post = (config: Record<string, unknown>) => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'keeper', system_prompt: 'x', config: { cwd: process.env.TIMON_HOME, role: 'coder', ...config } }),
  });
  try {
    assert.equal((await post({})).status, 200);
    const cfg = JSON.parse(readFileSync(join(agentDir('keeper'), 'config.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(cfg.reports_to, 'boss');
    assert.equal(cfg.team, 'core');
    assert.equal((await post({ reports_to: 'keeper' })).status, 400, 'the editor path validates it too');
    assert.equal((await post({ reports_to: null })).status, 200);
    assert.equal(reportsTo('keeper'), null);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
