/**
 * POST /api/agents/:name/rename — an anonymous caller is refused even on the
 * first-run loopback (no account yet, auth not required), and renaming the
 * main orchestrator re-records it whichever way it was found.
 */
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-agent-rename-'));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
await import('../../../tests/helpers/claude-provider.js');

const { registerRoutes } = await import('./routes.js');
const { agentDir } = await import('../../paths.js');
const { dbApi } = await import('../../db.js');
const { mainAgentName, MAIN_AGENT_KEY } = await import('../../main-agent.js');

const TOKEN = 'witness-daemon-token';
const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: false }));
app.use(express.json());
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

function seed(name: string): void {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'system-prompt.md'), 'test');
  writeFileSync(join(agentDir(name), 'config.json'), '{}');
}

async function rename(name: string, newName: string, bearer?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/agents/${encodeURIComponent(name)}/rename`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify({ newName }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test('an anonymous caller is refused on the first-run loopback', async () => {
  assert.equal(dbApi.countUsers(), 0, 'first run: the middleware lets an anonymous request through');
  seed('victim');
  const r = await rename('victim', 'taken-over');
  assert.equal(r.status, 401);
  assert.equal(existsSync(agentDir('victim')), true);
  assert.equal(existsSync(agentDir('taken-over')), false);
});

test('renaming the main orchestrator found by its legacy name records the new one', async () => {
  seed('TIMON.main');
  assert.equal(dbApi.getAllSettings()[MAIN_AGENT_KEY], undefined, 'nothing recorded: found by fallback');
  assert.equal(mainAgentName(), 'TIMON.main');
  const r = await rename('TIMON.main', 'Nova', TOKEN);
  assert.equal(r.status, 200);
  assert.equal(r.json.name, 'Nova');
  assert.equal(mainAgentName(), 'Nova');
});

test('an existing target is a 409 that names the conflict', async () => {
  seed('first');
  seed('second');
  const r = await rename('first', 'second', TOKEN);
  assert.equal(r.status, 409);
  assert.match(String(r.json.error), /already exists/);
  assert.equal(existsSync(agentDir('first')), true);
});
