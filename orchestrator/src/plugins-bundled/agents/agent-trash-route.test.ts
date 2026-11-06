/**
 * /api/agent-trash (TODO #476) — refused to an anonymous caller even on the
 * first-run loopback, restore and purge behind `agents:manage`, and the purge
 * kept to a person: a mission is refused.
 */
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-agent-trash-route-'));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
delete process.env.TIMON_AGENT_TRASH_ENABLED;

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
await import('../../../tests/helpers/claude-provider.js');

const { registerRoutes } = await import('./routes.js');
const { agentDir } = await import('../../paths.js');
const { dbApi } = await import('../../db.js');
const { listAgentTrash } = await import('../../agent-trash.js');

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
  writeFileSync(join(agentDir(name), 'system-prompt.md'), `prompt of ${name}`);
  writeFileSync(join(agentDir(name), 'config.json'), '{"role":"coder"}');
  writeFileSync(join(agentDir(name), 'SOUL.md'), `soul of ${name}`);
}

async function call(method: string, path: string, opts: { bearer?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}), ...(opts.headers ?? {}) },
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test('an anonymous caller is refused every trash route on the first-run loopback', async () => {
  assert.equal(dbApi.countUsers(), 0, 'first run: the middleware lets an anonymous request through');
  seed('victim');
  const del = await call('DELETE', '/api/agents/victim', { bearer: TOKEN });
  assert.equal(del.status, 200);
  const id = String(del.json.trash_id);
  assert.match(id, /-victim$/);

  assert.equal((await call('GET', '/api/agent-trash')).status, 401);
  assert.equal((await call('POST', `/api/agent-trash/${encodeURIComponent(id)}/restore`)).status, 401);
  assert.equal((await call('DELETE', `/api/agent-trash/${encodeURIComponent(id)}`)).status, 401);
  assert.equal(existsSync(agentDir('victim')), false, 'not restored');
  assert.ok(listAgentTrash().some((e) => e.id === id), 'not purged');
});

test('list, restore, then a 409 when the name is taken again', async () => {
  const listed = await call('GET', '/api/agent-trash', { bearer: TOKEN });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.enabled, true);
  assert.equal(listed.json.retention_days, 30);
  const entries = listed.json.entries as Array<{ id: string; name: string; deleted_by: string | null }>;
  const entry = entries.find((e) => e.name === 'victim');
  assert.ok(entry);
  assert.equal(entry.deleted_by, 'daemon');

  const restored = await call('POST', `/api/agent-trash/${encodeURIComponent(entry.id)}/restore`, { bearer: TOKEN });
  assert.equal(restored.status, 200);
  assert.equal(restored.json.name, 'victim');
  assert.ok(existsSync(join(agentDir('victim'), 'SOUL.md')));

  const again = await call('DELETE', '/api/agents/victim', { bearer: TOKEN });
  seed('victim');
  const conflict = await call('POST', `/api/agent-trash/${encodeURIComponent(String(again.json.trash_id))}/restore`, { bearer: TOKEN });
  assert.equal(conflict.status, 409);
  assert.match(String(conflict.json.error), /already exists/);
});

test('unknown ids are a 404, never a path outside the trash', async () => {
  assert.equal((await call('POST', '/api/agent-trash/nope/restore', { bearer: TOKEN })).status, 404);
  assert.equal((await call('DELETE', `/api/agent-trash/${encodeURIComponent('../agents')}`, { bearer: TOKEN })).status, 404);
  assert.ok(existsSync(agentDir('victim')));
});

test('a mission may not purge; the operator may', async () => {
  const entry = listAgentTrash().find((e) => e.name === 'victim');
  assert.ok(entry);
  const missionId = randomUUID();
  seed('caller');
  dbApi.createMission(missionId, 'caller', 'work');
  const fromMission = await call('DELETE', `/api/agent-trash/${encodeURIComponent(entry.id)}`, {
    bearer: TOKEN, headers: { 'X-TIMON-Mission': missionId },
  });
  assert.equal(fromMission.status, 403);
  assert.ok(listAgentTrash().some((e) => e.id === entry.id));

  const purged = await call('DELETE', `/api/agent-trash/${encodeURIComponent(entry.id)}`, { bearer: TOKEN });
  assert.equal(purged.status, 200);
  assert.ok(!listAgentTrash().some((e) => e.id === entry.id));
  assert.equal((await call('DELETE', `/api/agent-trash/${encodeURIComponent(entry.id)}`, { bearer: TOKEN })).status, 404);
});

test('TODO #623: purging an entry from before takes its skill attachments; a refused caller moves nothing', async () => {
  const { readFileSync } = await import('node:fs');
  const { AGENT_TRASH_DIR } = await import('../../paths.js');
  const { listSkillAttachments, putSkillAttachment } = await import('../../skill-attachments.js');
  const { trashedAgentSkills } = await import('../../agent-trash.js');
  seed('old.skilled');
  const del = await call('DELETE', '/api/agents/old.skilled', { bearer: TOKEN });
  const id = String(del.json.trash_id);
  // As a version before the fix left it: no `skills` in the entry, the rows still in the table.
  const file = join(AGENT_TRASH_DIR, id, 'entry.json');
  const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  delete stored.skills;
  writeFileSync(file, JSON.stringify(stored));
  putSkillAttachment({ skill: 'sk-old', scope: 'agent', target: 'old.skilled', mode: 'import', exclude: false });
  const rows = () => listSkillAttachments({ scope: 'agent', target: 'old.skilled' }).length;

  assert.equal((await call('DELETE', `/api/agent-trash/${encodeURIComponent(id)}`)).status, 401);
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'caller', 'work');
  const fromMission = await call('DELETE', `/api/agent-trash/${encodeURIComponent(id)}`, {
    bearer: TOKEN, headers: { 'X-TIMON-Mission': missionId },
  });
  assert.equal(fromMission.status, 403);
  assert.equal(rows(), 1, 'a refused purge leaves the table alone');
  assert.equal(trashedAgentSkills(id), null, 'and the entry too');

  assert.equal((await call('DELETE', `/api/agent-trash/${encodeURIComponent(id)}`, { bearer: TOKEN })).status, 200);
  assert.equal(rows(), 0, 'gone with the entry');
});
