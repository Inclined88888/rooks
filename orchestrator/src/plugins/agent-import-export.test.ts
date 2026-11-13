/**
 * The export of the agent import (SUG-0084), through the real plugin context,
 * the daemon's body parser and a real HTTP server: refusals first — anonymous,
 * an account that may not read agents, an invalid body, an unknown agent —
 * then what never leaves (a secret value of any kind), and the round trip:
 * the archive staged, previewed and applied by the same engine. A malformed
 * archive and a `../` path are refused at the import.
 */
import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createRequire } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import { createPluginContext, daemonHost, type PluginContext } from './context.js';
import { readManifest } from './manifest.js';
import { createHttpPlugin } from '../kernel/http-service.js';
import { createBodyParser } from '../kernel/body-parser.js';
import { dbApi } from '../db.js';
import { readDoc, upsertAgent, writeDoc, patchAgentConfig } from '../agent.js';
import { loadConfig } from '../agent-config.js';
import { upsertMcp } from '../mcp.js';
import { setAgentSkills } from '../skill-attachments.js';
import { insertTrigger } from '../triggers/store.js';
import { forgeZip } from '../../../plugins/agent-import/test/zip-writer.js';
import { mountOfficialProviders } from '../../tests/helpers/official-providers.js';
import { setMcpHostLookupForTest } from '../mcp-url-guard.js';

// The zip library of the plugin, from the plugin's own dependencies (the orchestrator has none).
const { unzipSync, strFromU8 } = createRequire(new URL('../../../plugins/agent-import/package.json', import.meta.url))('fflate') as {
  unzipSync(data: Uint8Array): Record<string, Uint8Array>;
  strFromU8(data: Uint8Array): string;
};

await mountOfficialProviders();
setMcpHostLookupForTest(async () => [{ address: '93.184.215.14', family: 4 }]);
test.after(() => { setMcpHostLookupForTest(null); });

const pkg = (await import('../../../plugins/agent-import/package.json', { with: { type: 'json' } })).default as { rooks: unknown };
const lib = await import('../../../plugins/agent-import/lib/index.js') as { apply(ctx: PluginContext): void };

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });

async function loaded(): Promise<{ base: string }> {
  const root = new Context();
  const app = express();
  app.use((req, _res, next) => {
    const user = dbApi.getUserById(String(req.headers['x-test-user'] ?? ''));
    if (user) req.auth = { kind: 'session', user, isSuperadmin: user.is_superadmin };
    next();
  });
  app.use(createBodyParser());
  await root.plugin(createHttpPlugin(app));
  let inner!: Context;
  await root.plugin({ name: 'holder', apply(ctx: Context) { inner = ctx; } });
  const manifest = readManifest(pkg);
  assert.ok(manifest.ok, manifest.ok ? '' : manifest.message);
  lib.apply(createPluginContext(inner, { manifest: manifest.manifest, version: '0.1.0' }, daemonHost(root)));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  cleanup.push(async () => {
    await new Promise((resolve) => server.close(resolve));
    await root.fiber.dispose();
  });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/plugins/agent-import` };
}

function account(name: string, permissions: string[]): string {
  const id = randomUUID();
  createTestAccount(dbApi, { id, email: `${name}-${id}@example.test`, name, passwordHash: 'unused', status: 'active' });
  grantTestPermissions(dbApi, id, ['plugin:agent-import', ...permissions]);
  return id;
}

type Answer = { status: number; body: Record<string, unknown>; bytes: Buffer; type: string };

async function call(base: string, method: string, route: string, user: string | null, body?: unknown, type = 'application/json'): Promise<Answer> {
  const headers: Record<string, string> = {};
  if (user) headers['x-test-user'] = user;
  if (body !== undefined) headers['content-type'] = type;
  const payload = body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body);
  const res = await fetch(`${base}/${route}`, { method, headers, body: payload });
  const bytes = Buffer.from(await res.arrayBuffer());
  const kind = res.headers.get('content-type') ?? '';
  return { status: res.status, type: kind, bytes, body: kind.startsWith('application/json') && bytes.length ? JSON.parse(bytes.toString('utf8')) as Record<string, unknown> : {} };
}

let seq = 0;
/** An agent with everything an export reads, and a secret in every place one could hide. */
function richAgent(owner: string): string {
  const name = `exp-${++seq}`;
  upsertAgent({ name, system_prompt: `You are ${name}.`, config: { role: 'coder', backend: 'claude', model: 'opus', directives: 'Be brief.', mcp_servers: [`${name}-web`, `${name}-local`] } });
  writeDoc(name, 'SOUL.md', `# ${name}\n\nI am ${name}.`);
  writeDoc(name, 'USER.md', 'The owner likes tea.');
  upsertMcp({ id: `${name}-web`, name: 'Web search', transport: { type: 'http', url: 'https://mcp.example.com/sse?api_key=QUERY-SECRET', headers: { Authorization: 'Bearer HEADER-SECRET' } } });
  upsertMcp({ id: `${name}-local`, name: 'Local tool', transport: { type: 'stdio', command: 'tool', args: ['--token', 'ARG-SECRET'], env: { TOOL_KEY: 'ENV-SECRET' } } });
  dbApi.insertRule({ scope: 'agent', agent: name, kind: 'preference', text: `${name} prefers short answers.` });
  const team = dbApi.createTeam(`tm-${name}`, `Team ${name}`, { color: '#abcdef', ownerUserId: owner });
  patchAgentConfig(name, { team: team.id });
  insertTrigger({
    name: 'Morning', slug: null, source: 'schedule', enabled: false, config: { cron: '30 8 * * *', tz: 'Europe/Paris' }, filter: null,
    actions: [{ type: 'task', agent: name, prompt: 'Morning brief.', raw: true } as never], secret: 'TRIGGER-SECRET', ownerUserId: owner,
    createdBy: 'user', creatorAgent: null, actingAgent: null, grants: [], nextRunAt: null,
  });
  return name;
}

const SECRETS = ['QUERY-SECRET', 'HEADER-SECRET', 'ARG-SECRET', 'ENV-SECRET', 'TRIGGER-SECRET'];

const manifestOf = (bytes: Buffer): Record<string, unknown> & { agents: Array<Record<string, unknown>> } => {
  const files = unzipSync(new Uint8Array(bytes));
  assert.deepEqual(Object.keys(files), ['rooks-agent-import.json']);
  return JSON.parse(strFromU8(files['rooks-agent-import.json']!)) as Record<string, unknown> & { agents: Array<Record<string, unknown>> };
};

test('refused: anonymous, an account that may not read agents, an invalid body, an unknown agent', async () => {
  const { base } = await loaded();
  const name = richAgent('nobody');
  assert.equal((await call(base, 'GET', 'agents', null)).status, 401);
  assert.equal((await call(base, 'POST', 'export', null, { agents: [name] })).status, 401);
  const stranger = account('stranger', ['skills:manage']);
  assert.equal((await call(base, 'GET', 'agents', stranger)).status, 403);
  const refused = await call(base, 'POST', 'export', stranger, { agents: [name] });
  assert.equal(refused.status, 403);
  assert.equal(refused.bytes.includes(Buffer.from(`You are ${name}`)), false);

  const reader = account('reader', ['agents:read']);
  for (const body of [{}, { agents: [] }, { all: false }, { agents: [name], all: true }, { agents: [name], extra: 1 }, { agents: Array.from({ length: 101 }, (_, i) => `a${i}`) }]) {
    assert.equal((await call(base, 'POST', 'export', reader, body)).status, 400, JSON.stringify(body).slice(0, 80));
  }
  const unknown = await call(base, 'POST', 'export', reader, { agents: [name, 'no-such-agent-here'] });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, 'not_found');
});

test('an export carries the agent and the NAMES of its secrets, never a value', async () => {
  const { base } = await loaded();
  const reader = account('reader2', ['agents:read']);
  const name = richAgent(reader);
  const list = await call(base, 'GET', 'agents', reader);
  assert.ok((list.body.agents as Array<{ name: string }>).some((a) => a.name === name));

  const res = await call(base, 'POST', 'export', reader, { agents: [name] });
  assert.equal(res.status, 200, res.bytes.toString('utf8').slice(0, 300));
  assert.equal(res.type, 'application/zip');
  const text = strFromU8(unzipSync(new Uint8Array(res.bytes))['rooks-agent-import.json']!);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `${secret} never leaves`);
  assert.ok(!res.bytes.includes(Buffer.from('SECRET')), 'nor in the raw archive');

  const manifest = manifestOf(res.bytes);
  assert.equal((manifest.source as { app: string }).app, 'rooks');
  const agent = manifest.agents[0]!;
  assert.equal(agent.displayName, name);
  assert.equal(agent.instructions, `You are ${name}.`);
  assert.equal(agent.directives, 'Be brief.');
  assert.deepEqual((agent.docs as Array<{ name: string }>).map((d) => d.name), ['SOUL.md', 'USER.md']);
  assert.deepEqual(agent.hints, { backend: 'claude', model: 'opus', role: 'coder' });
  assert.match(String(agent.sourceRef), new RegExp(`^rooks:[a-f0-9]{16}:${name}$`));
  const servers = agent.mcpServers as Array<{ name: string; transport: string; url?: string; command?: string; secretNames?: string[] }>;
  assert.deepEqual(servers.find((s) => s.transport === 'http'), { name: 'Web search', transport: 'http', url: 'https://mcp.example.com/sse', secretNames: ['Authorization'] });
  assert.deepEqual(servers.find((s) => s.transport === 'stdio'), { name: 'Local tool', transport: 'stdio', secretNames: ['TOOL_KEY'] });
  assert.deepEqual(agent.routines, [{ name: 'Morning', instruction: 'Morning brief.', schedule: { kind: 'cron', expression: '30 8 * * *' }, timezone: 'Europe/Paris', enabledInSource: false }]);
  assert.deepEqual((manifest.groups as Array<{ name: string; members: string[] }>).map((g) => [g.name, g.members]), [[`Team ${name}`, [agent.key]]]);

  // Another account reads the agent, not the team or the routine of the first.
  const other = account('reader3', ['agents:read']);
  const theirs = manifestOf((await call(base, 'POST', 'export', other, { agents: [name] })).bytes);
  assert.equal(theirs.groups, undefined);
  assert.equal(theirs.agents[0]!.routines, undefined);
});

test('round trip: the archive is staged, previewed and applied by the same engine', async () => {
  const { base } = await loaded();
  const owner = account('owner', ['agents:manage', 'agents:read', 'skills:manage', 'mcp:manage', 'triggers:manage', 'kanban:write']);
  const name = richAgent(owner);
  const archive = (await call(base, 'POST', 'export', owner, { agents: [name] })).bytes;

  const staged = await call(base, 'POST', 'stage', owner, new Uint8Array(archive), 'application/zip');
  assert.equal(staged.status, 201);
  const token = staged.body.token as string;
  const preview = await call(base, 'POST', 'preview', owner, { token });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const p = (preview.body.preview as { agents: Array<{ finalName: string; action: string; role: string; backend: string | null; warnings: string[] }> }).agents[0]!;
  assert.equal(p.action, 'create');
  assert.equal(p.finalName, `rooks.${name}`);
  assert.equal(p.role, 'coder');
  assert.equal(p.backend, 'claude');
  assert.ok(p.warnings.some((w) => w.includes('Authorization')), 'the secret names are listed');

  const applied = await call(base, 'POST', 'apply', owner, { token });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const copy = `rooks.${name}`;
  assert.equal(readDoc(copy, 'SOUL.md'), `# ${name}\n\nI am ${name}.`, 'SOUL.md is kept verbatim');
  assert.equal(readDoc(copy, 'USER.md'), 'The owner likes tea.');
  assert.equal(readDoc(copy, 'system-prompt.md'), `You are ${name}.`);
  const cfg = loadConfig(copy)!;
  assert.equal(cfg.role, 'coder');
  assert.equal(cfg.directives, 'Be brief.');
  assert.equal(cfg.backend, 'claude');
  assert.equal(cfg.model, 'opus');
});

test('the import refuses a malformed archive and a path that climbs out', async () => {
  const { base } = await loaded();
  const owner = account('owner2', ['agents:manage']);
  const preview = async (bytes: Uint8Array) => {
    const staged = await call(base, 'POST', 'stage', owner, bytes, 'application/zip');
    if (staged.status !== 201) return staged;
    return call(base, 'POST', 'preview', owner, { token: staged.body.token });
  };
  const manifest = (over: Record<string, unknown>) => JSON.stringify({
    format: 'rooks-agent-import', version: 1, source: { app: 'rooks', exportedAt: null },
    agents: [{ key: 'a', displayName: 'A', instructions: 'x', sourceRef: 'r', ...over }],
  });
  const garbage = await preview(new Uint8Array(Buffer.from('this is not a zip at all')));
  assert.ok([400, 422].includes(garbage.status), String(garbage.status));
  const climbing = await preview(forgeZip([{ name: '../rooks-agent-import.json', data: manifest({}) }]));
  assert.ok([400, 422].includes(climbing.status), String(climbing.status));
  const docOut = await preview(forgeZip([{ name: 'rooks-agent-import.json', data: manifest({ docs: [{ name: '../SOUL.md', content: 'x' }] }) }]));
  assert.equal(docOut.status, 422);
  const prompt = await preview(forgeZip([{ name: 'rooks-agent-import.json', data: manifest({ docs: [{ name: 'system-prompt.md', content: 'x' }] }) }]));
  assert.equal(prompt.status, 422);
  const companion = await preview(forgeZip([{ name: 'rooks-agent-import.json', data: manifest({ skills: [{ id: 's', content: 'x', companionFiles: ['../../.ssh/id_rsa'] }] }) }]));
  assert.equal(companion.status, 422);
});
