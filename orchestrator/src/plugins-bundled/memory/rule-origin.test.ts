/**
 * The `plugin:<id>` origin of a rule is the plugin's proof of ownership
 * (`ctx.memory.rules.rm`): no HTTP caller can write it, or rewrite it later.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-rule-origin-'));
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const OPERATOR = 'rule-origin-operator-token';
const { dbApi } = await import('../../db.js');
const { agentDir } = await import('../../paths.js');
const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { createBodyParser } = await import('../../kernel/body-parser.js');
const { registerRoutes: memory } = await import('./routes.js');

mkdirSync(agentDir('lead'), { recursive: true });
writeFileSync(join(agentDir('lead'), 'system-prompt.md'), 'test');
writeFileSync(join(agentDir('lead'), 'config.json'), JSON.stringify({ cwd: process.env.TIMON_HOME }));

const app = express();
app.use(createDaemonAuthMiddleware({ token: OPERATOR, required: true }));
app.use(createBodyParser());
memory(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.closeAllConnections(); server.close(); });

const call = (method: string, path: string, body?: unknown, token: string | null = OPERATOR) => fetch(`${base}${path}`, {
  method,
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test('an anonymous request cannot write a rule', async () => {
  const r = await call('POST', '/api/memory/rules', { scope: 'agent', agent: 'lead', text: 'anon rule' }, null);
  assert.equal(r.status, 401);
});

test('POST refuses a `plugin:` source, whatever its case or spacing', async () => {
  for (const source of ['plugin:acme', 'Plugin:acme', ' plugin:acme']) {
    const r = await call('POST', '/api/memory/rules', { scope: 'agent', agent: 'lead', text: `forged ${source}`, source });
    assert.equal(r.status, 400, source);
  }
  assert.equal(dbApi.listRules({ source: 'plugin:acme' }).length, 0);
});

test('a normal rule keeps working and its `source` stays out of the plugin namespace', async () => {
  const r = await call('POST', '/api/memory/rules', { scope: 'agent', agent: 'lead', text: 'plain rule' });
  assert.equal(r.status, 201);
  const { rule } = await r.json() as { rule: { id: number; source: string } };
  assert.equal(rule.source, 'manual');
});

test('PATCH cannot rewrite the source of a rule', async () => {
  const { rule } = await (await call('POST', '/api/memory/rules', { scope: 'agent', agent: 'lead', text: 'patch me' })).json() as { rule: { id: number } };
  await call('PATCH', `/api/memory/rules/${rule.id}`, { source: 'plugin:acme', text: 'patched' });
  const row = dbApi.getRule(rule.id);
  assert.equal(row?.text, 'patched');
  assert.equal(row?.source, 'manual');
});
