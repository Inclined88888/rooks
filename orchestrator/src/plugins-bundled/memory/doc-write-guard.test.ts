/**
 * TODO #240: an agent edits its own identity docs (SOUL.md…), an orchestrator
 * those of the agents it orchestrates, and nobody else's. The rule lives on
 * the daemon routes, keyed on the mission token, never on a parameter.
 *
 * Mounted like the daemon (auth, then the global JSON parser): the CLI and the
 * MCP send `{ content }` as JSON, the UI sends text/plain, and both must land.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-doc-write-'));
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const OPERATOR = 'doc-write-operator-token';
const { dbApi } = await import('../../db.js');
const { agentDir } = await import('../../paths.js');
const { issueMissionApiToken } = await import('../../users/api-tokens.js');
const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { createBodyParser } = await import('../../kernel/body-parser.js');
const { registerRoutes: memory } = await import('./routes.js');

for (const [name, config] of Object.entries<Record<string, unknown>>({
  _main: { role: 'orchestrator', permission_mode: 'default' },
  lead: { permission_mode: 'default' },
  'lead.sub': { reports_to: 'lead', permission_mode: 'default' },
  'lead.high': { reports_to: 'lead', permission_mode: 'bypassPermissions' },
  outsider: { permission_mode: 'default' },
})) {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'system-prompt.md'), 'test');
  writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify({ cwd: process.env.TIMON_HOME, ...config }));
}
const owner = createTestAccount(dbApi, { email: 'owner@example.test', name: 'Owner', passwordHash: 'x', isSuperadmin: true });
function mission(agent: string): { id: string; bearer: string } {
  const id = randomUUID();
  dbApi.createMission(id, agent, 'doc write test', undefined, owner.id);
  return { id, bearer: issueMissionApiToken(id) };
}

const app = express();
app.use(createDaemonAuthMiddleware({ token: OPERATOR, required: true }));
app.use(createBodyParser());
memory(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.closeAllConnections(); server.close(); });

const docPath = (agent: string, file: string) => join(agentDir(agent), file);
const docUrl = (agent: string, file: string) => `${base}/api/agents/${agent}/docs/${file}`;

function put(agent: string, file: string, content: unknown, bearer: string | null, headers: Record<string, string> = {}) {
  return fetch(docUrl(agent, file), {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
    body: JSON.stringify(content),
  });
}
function del(agent: string, file: string, bearer: string | null) {
  return fetch(docUrl(agent, file), {
    method: 'DELETE',
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

test('an agent writes its own identity doc, sent as JSON', async () => {
  const r = await put('lead', 'SOUL.md', { content: '# Lead\nI lead.' }, mission('lead').bearer);
  assert.equal(r.status, 200);
  assert.equal(readFileSync(docPath('lead', 'SOUL.md'), 'utf8'), '# Lead\nI lead.');
});

test('an agent cannot write the docs of an agent outside its orchestration', async () => {
  const r = await put('outsider', 'SOUL.md', { content: 'hijacked' }, mission('lead').bearer);
  assert.equal(r.status, 403);
  assert.match(((await r.json()) as { reason: string }).reason, /does not orchestrate "outsider"/);
  assert.equal(existsSync(docPath('outsider', 'SOUL.md')), false);
  assert.ok(dbApi.listAuditLog(50).some((row) => row.action === 'agent.doc_write_denied'));
  // Upward is outside too: a subordinate does not orchestrate its manager.
  assert.equal((await put('lead', 'SOUL.md', { content: 'x' }, mission('lead.sub').bearer)).status, 403);
  assert.equal(readFileSync(docPath('lead', 'SOUL.md'), 'utf8'), '# Lead\nI lead.');
});

test('an orchestrator writes the docs of the agents it orchestrates, not above its own level', async () => {
  assert.equal((await put('lead.sub', 'SOUL.md', { content: 'sub' }, mission('lead').bearer)).status, 200);
  assert.equal(readFileSync(docPath('lead.sub', 'SOUL.md'), 'utf8'), 'sub');
  assert.equal((await put('outsider', 'NOTES.md', { content: 'x' }, mission('_main').bearer)).status, 200);
  const high = await put('lead.high', 'SOUL.md', { content: 'x' }, mission('lead').bearer);
  assert.equal(high.status, 403);
  assert.equal(existsSync(docPath('lead.high', 'SOUL.md')), false);
});

test('deleting a doc follows the same rule', async () => {
  writeFileSync(docPath('outsider', 'KEEP.md'), 'keep');
  assert.equal((await del('outsider', 'KEEP.md', mission('lead').bearer)).status, 403);
  assert.equal(readFileSync(docPath('outsider', 'KEEP.md'), 'utf8'), 'keep');
  writeFileSync(docPath('lead.sub', 'OLD.md'), 'old');
  assert.equal((await del('lead.sub', 'OLD.md', mission('lead').bearer)).status, 200);
  assert.equal(existsSync(docPath('lead.sub', 'OLD.md')), false);
  assert.equal((await del('lead', 'system-prompt.md', mission('lead').bearer)).status, 400);
});

test('an operator claiming a mission is held to that mission\'s rule', async () => {
  const lead = mission('lead');
  const r = await put('outsider', 'SOUL.md', { content: 'x' }, OPERATOR, { 'X-TIMON-Mission': lead.id });
  assert.equal(r.status, 403);
  assert.equal(existsSync(docPath('outsider', 'SOUL.md')), false);
});

test('an anonymous caller is refused and writes nothing', async () => {
  assert.equal((await put('lead', 'ANON.md', { content: 'x' }, null)).status, 401);
  assert.equal((await del('lead', 'SOUL.md', null)).status, 401);
  assert.equal(existsSync(docPath('lead', 'ANON.md')), false);
  assert.equal(readFileSync(docPath('lead', 'SOUL.md'), 'utf8'), '# Lead\nI lead.');
});

test('a path traversal in the file or agent name is refused', async () => {
  const bearer = mission('lead').bearer;
  assert.equal((await put('lead', '..%2Fconfig.json', { content: '{}' }, bearer)).status, 400);
  assert.equal((await put('lead', '..%2F..%2Fescape.md', { content: 'x' }, bearer)).status, 400);
  assert.equal((await put('..%2Foutsider', 'SOUL.md', { content: 'x' }, bearer)).status, 400);
  assert.equal((await put('..%2Foutsider', 'SOUL.md', { content: 'x' }, OPERATOR)).status, 400);
  assert.equal(JSON.parse(readFileSync(join(agentDir('lead'), 'config.json'), 'utf8')).permission_mode, 'default');
  assert.equal(existsSync(docPath('outsider', 'SOUL.md')), false);
});

test('a mission cannot create the directory of an unknown agent, nor a case twin', async () => {
  assert.equal((await put('ghost', 'SOUL.md', { content: 'x' }, mission('_main').bearer)).status, 404);
  assert.equal(existsSync(agentDir('ghost')), false);
  assert.equal((await put('LEAD.SUB', 'CASE.md', { content: 'case' }, mission('lead').bearer)).status, 200);
  assert.equal(readFileSync(docPath('lead.sub', 'CASE.md'), 'utf8'), 'case');
});

test('the UI keeps writing text/plain, an operator anywhere, and an empty save clears the doc', async () => {
  const text = await fetch(docUrl('outsider', 'UI.md'), {
    method: 'PUT', headers: { 'content-type': 'text/plain; charset=utf-8', authorization: `Bearer ${OPERATOR}` }, body: 'from the editor',
  });
  assert.equal(text.status, 200);
  assert.equal(readFileSync(docPath('outsider', 'UI.md'), 'utf8'), 'from the editor');
  const empty = await fetch(docUrl('outsider', 'UI.md'), {
    method: 'PUT', headers: { 'content-type': 'text/plain; charset=utf-8', authorization: `Bearer ${OPERATOR}` }, body: '',
  });
  assert.equal(empty.status, 200);
  assert.equal(readFileSync(docPath('outsider', 'UI.md'), 'utf8'), '');
});

test('a malformed body is refused rather than written as an empty doc', async () => {
  writeFileSync(docPath('lead', 'BODY.md'), 'kept');
  assert.equal((await put('lead', 'BODY.md', { text: 'x' }, OPERATOR)).status, 400);
  assert.equal((await put('lead', 'BODY.md', { content: 42 }, OPERATOR)).status, 400);
  assert.equal((await put('lead', 'BODY.md', {}, OPERATOR)).status, 400);
  assert.equal(readFileSync(docPath('lead', 'BODY.md'), 'utf8'), 'kept');
});

test('a doc above 2 MB is refused on both transports', async () => {
  const big = 'x'.repeat(2 * 1024 * 1024 + 1);
  assert.equal((await put('lead', 'BIG.md', { content: big }, OPERATOR)).status, 413);
  const text = await fetch(docUrl('lead', 'BIG.md'), {
    method: 'PUT', headers: { 'content-type': 'text/plain', authorization: `Bearer ${OPERATOR}` }, body: big,
  });
  assert.equal(text.status, 413);
  assert.equal(existsSync(docPath('lead', 'BIG.md')), false);
});

test('a JSON read returns the text as a string, even when it parses as JSON', async () => {
  writeFileSync(docPath('lead', 'NUM.md'), '42');
  const r = await fetch(`${docUrl('lead', 'NUM.md')}?format=json`, { headers: { authorization: `Bearer ${mission('outsider').bearer}` } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { name: 'NUM.md', content: '42' });
});
