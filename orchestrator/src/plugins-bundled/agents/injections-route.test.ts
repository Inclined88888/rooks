/**
 * GET /api/agents/:name/injections — the injections of an agent at spawn.
 *
 * The access control first (the refusal of an anonymous caller is the test that
 * counts), then that a vault secret does not travel over HTTP. Isolated
 * ROOKS_HOME, witness on 127.0.0.1:0.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-agents-injections-'));
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { upsertAgent } = await import('../../agent.js');
const { setRedactionSource } = await import('../../secrets/redact.js');
const { upsertSkill } = await import('../../skills.js');
const { dbApi } = await import('../../db.js');

const TOKEN = 'witness-daemon-token';
const SECRET = 'vault-secret-value-77b1c0de';

upsertAgent({ name: 'inj-route', system_prompt: `# prompt\nkey=${SECRET}\n`, config: { role: 'coder' } });

async function serve(required: boolean): Promise<{ base: string; close: () => void }> {
  const app = express();
  app.use(createDaemonAuthMiddleware({ token: TOKEN, required }));
  app.use(express.json());
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  assert.notEqual(port, 3001, 'the witness must not take the production port');
  return { base: `http://127.0.0.1:${port}`, close: () => { server.close(); } };
}

const strict = await serve(true);
// Auth not required and no user yet: the historical open API. The route must
// still refuse — it exposes memory rules and project files.
const open = await serve(false);
test.after(() => { strict.close(); open.close(); });

const get = (base: string, path: string, bearer?: string) =>
  fetch(`${base}${path}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });

test('an anonymous caller is refused, whether or not auth is required', async () => {
  assert.equal((await get(strict.base, '/api/agents/inj-route/injections')).status, 401);
  assert.equal((await get(open.base, '/api/agents/inj-route/injections')).status, 401);
  assert.equal((await get(strict.base, '/api/agents/inj-route/injections', 'wrong-token')).status, 401);
});

test('the daemon token reads the ordered blocks', async () => {
  const res = await get(strict.base, '/api/agents/inj-route/injections', TOKEN);
  assert.equal(res.status, 200);
  const body = await res.json() as { agent: string; blocks: { id: string; order: number }[] };
  assert.equal(body.agent, 'inj-route');
  assert.equal(body.blocks[0]!.id, 'preamble');
  assert.deepEqual(body.blocks.map((b) => b.order), body.blocks.map((_, i) => i + 1));
});

test('a vault secret does not leave in the response', async () => {
  const previous = setRedactionSource(() => [SECRET]);
  try {
    const res = await get(strict.base, '/api/agents/inj-route/injections', TOKEN);
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.ok(!text.includes(SECRET));
    assert.match(text, /key=\*\*\*/);
  } finally {
    setRedactionSource(previous);
  }
});

test('an unknown agent is a 404 and a stray query parameter a 400', async () => {
  assert.equal((await get(strict.base, '/api/agents/nobody-here/injections', TOKEN)).status, 404);
  assert.equal((await get(strict.base, '/api/agents/inj-route/injections?x=1', TOKEN)).status, 400);
});

test('a mission of the agent adds its extra skills to the skills block; a mission of another agent is ignored', async () => {
  upsertSkill('inj-route-task', '---\nname: inj-route-task\n---\ntask protocol\n');
  upsertAgent({ name: 'inj-route-other', system_prompt: '# other\n', config: { role: 'coder' } });
  dbApi.createMission('inj-route-m1', 'inj-route', 'a kanban task');
  dbApi.setMissionExtras('inj-route-m1', ['inj-route-task'], null);
  dbApi.createMission('inj-route-m2', 'inj-route-other', 'not this agent');
  dbApi.setMissionExtras('inj-route-m2', ['inj-route-task'], null);
  const skills = async (query: string): Promise<string[]> => {
    const res = await get(strict.base, `/api/agents/inj-route/injections${query}`, TOKEN);
    assert.equal(res.status, 200);
    const body = await res.json() as { blocks: { id: string; items: { label: string }[] }[] };
    return body.blocks.find((b) => b.id === 'skills')?.items.map((i) => i.label) ?? [];
  };
  assert.deepEqual(await skills('?mission_id=inj-route-m1'), ['inj-route-task']);
  assert.deepEqual(await skills('?mission_id=inj-route-m2'), [], 'another agent\'s mission lends nothing');
  assert.deepEqual(await skills(''), []);
});

const put = (base: string, path: string, body: string, bearer?: string) =>
  fetch(`${base}${path}`, { method: 'PUT', body, headers: { 'content-type': 'text/plain', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } });

test('the global instructions: an anonymous caller can neither read nor write, whether or not auth is required', async () => {
  for (const server of [strict, open]) {
    assert.equal((await get(server.base, '/api/global-instructions')).status, 401);
    assert.equal((await put(server.base, '/api/global-instructions', 'x')).status, 401);
  }
  assert.equal((await put(strict.base, '/api/global-instructions', 'x', 'wrong-token')).status, 401);
});

test('the global instructions are written and read back with the daemon token, and the cap holds', async () => {
  const written = await put(strict.base, '/api/global-instructions', 'Answer in French.\n', TOKEN);
  assert.equal(written.status, 200);
  const read = await (await get(strict.base, '/api/global-instructions', TOKEN)).json() as { content: string; path: string; max_chars: number };
  assert.equal(read.content, 'Answer in French.\n');
  assert.match(read.path, /global-instructions\.md$/);
  const tooLong = await put(strict.base, '/api/global-instructions', 'x'.repeat(read.max_chars + 1), TOKEN);
  assert.equal(tooLong.status, 400);
  assert.equal((await (await get(strict.base, '/api/global-instructions', TOKEN)).json() as { content: string }).content, 'Answer in French.\n', 'a refused write leaves the file alone');
});
