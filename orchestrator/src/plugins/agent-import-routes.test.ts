/**
 * The agent import's routes (plugins/agent-import, built `lib/index.js`),
 * through the real plugin context, the daemon's body parser and a real HTTP
 * server: refusals first — anonymous, an account that may not create agents,
 * somebody else's token, a replayed token, an archive changed on disk, an
 * invalid body — then what an owner gets, and what never leaks.
 */
import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';
import { createPluginContext, daemonHost, type PluginContext } from './context.js';
import { readManifest } from './manifest.js';
import { integrationRegistries } from './integration-host.js';
import { createHttpPlugin } from '../kernel/http-service.js';
import { createBodyParser } from '../kernel/body-parser.js';
import { dbApi } from '../db.js';
import { getAgent, readDoc } from '../agent.js';
import { forgeZip } from '../../../plugins/agent-import/test/zip-writer.js';
import { mountOfficialProviders } from '../../tests/helpers/official-providers.js';
import { startPluginWorkflowTriggers } from '../workflows/plugin-triggers.js';

await mountOfficialProviders();

const pkg = (await import('../../../plugins/agent-import/package.json', { with: { type: 'json' } })).default as { rooks: unknown };
const lib = await import('../../../plugins/agent-import/lib/index.js') as {
  apply(ctx: PluginContext): void;
  STAGES_PER_ACCOUNT: number;
};

/** The smallest valid zip: an end-of-central-directory record and nothing else. */
const EMPTY_ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });

async function loaded(): Promise<{ plugin: PluginContext; base: string }> {
  const root = new Context();
  const app = express();
  // What the daemon's auth middleware sets for a signed-in account, named by a test header.
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
  const plugin = createPluginContext(inner, { manifest: manifest.manifest, version: '0.1.0' }, daemonHost(root));
  lib.apply(plugin);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  cleanup.push(async () => {
    await new Promise((resolve) => server.close(resolve));
    await root.fiber.dispose();
  });
  return { plugin, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/plugins/agent-import` };
}

function account(name: string, permissions: string[] = ['agents:manage']): string {
  const id = randomUUID();
  createTestAccount(dbApi, { id, email: `${name}-${id}@example.test`, name, passwordHash: 'unused', status: 'active' });
  grantTestPermissions(dbApi, id, ['plugin:agent-import', ...permissions]);
  return id;
}

type Answer = { status: number; body: Record<string, unknown> };

async function post(base: string, route: string, user: string | null, body?: unknown, type = 'application/json'): Promise<Answer> {
  const headers: Record<string, string> = {};
  if (user) headers['x-test-user'] = user;
  if (body !== undefined) headers['content-type'] = type;
  const payload = body === undefined ? undefined
    : Buffer.isBuffer(body) ? new Uint8Array(body)
      : typeof body === 'string' ? body : JSON.stringify(body);
  const res = await fetch(`${base}/${route}`, { method: 'POST', headers, body: payload });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

async function stage(base: string, user: string, bytes: Buffer = EMPTY_ZIP): Promise<string> {
  const res = await post(base, 'stage', user, bytes, 'application/zip');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(typeof res.body.token, 'string');
  return res.body.token as string;
}

function stagingFolders(plugin: PluginContext): string[] {
  const dir = join(plugin.storage.dir, 'staging');
  return existsSync(dir) ? readdirSync(dir) : [];
}

/** Stages and returns the token with the folder that holds its archive. */
async function stageTracked(plugin: PluginContext, base: string, user: string): Promise<{ token: string; folder: string }> {
  const before = new Set(stagingFolders(plugin));
  const token = await stage(base, user);
  const folder = stagingFolders(plugin).find((name) => !before.has(name));
  assert.ok(folder, 'the archive has a folder of its own');
  return { token, folder: join(plugin.storage.dir, 'staging', folder) };
}

test('an anonymous caller is refused on every route, before anything is read or written', async () => {
  const { plugin, base } = await loaded();
  const before = stagingFolders(plugin).length;
  assert.equal((await post(base, 'stage', null, EMPTY_ZIP, 'application/zip')).status, 401);
  for (const route of ['preview', 'apply', 'discard']) {
    const res = await post(base, route, null, { token: 'a'.repeat(43) });
    assert.equal(res.status, 401, route);
    assert.equal(res.body.code, 'unauthorized', route);
  }
  assert.equal(stagingFolders(plugin).length, before, 'nothing staged for an anonymous caller');
});

test('an account that may not create agents is refused on every route', async () => {
  const { base } = await loaded();
  const reader = account('reader', []);
  assert.equal((await post(base, 'stage', reader, EMPTY_ZIP, 'application/zip')).status, 403);
  for (const route of ['preview', 'apply', 'discard']) {
    assert.equal((await post(base, route, reader, { token: 'a'.repeat(43) })).status, 403, route);
  }
});

test('stage answers a token with the SHA-256 of the bytes; an archive without a manifest is a 422', async () => {
  const { base } = await loaded();
  const ada = account('ada');
  const res = await post(base, 'stage', ada, EMPTY_ZIP, 'application/x-zip-compressed');
  assert.equal(res.status, 201);
  assert.match(String(res.body.token), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(res.body.sha256, createHash('sha256').update(EMPTY_ZIP).digest('hex'));
  assert.equal(res.body.size, EMPTY_ZIP.length);
  const preview = await post(base, 'preview', ada, { token: res.body.token });
  assert.equal(preview.status, 422);
  assert.equal(preview.body.code, 'invalid_manifest');
  assert.match(String(preview.body.error), /rooks-agent-import\.json/);
  // A preview does not spend the token.
  assert.equal((await post(base, 'preview', ada, { token: res.body.token })).status, 422);
});

test("another account's token answers like an unknown one, and stays usable by its owner", async () => {
  const { base } = await loaded();
  const ada = account('ada');
  const bob = account('bob');
  const token = await stage(base, ada);
  for (const route of ['preview', 'apply', 'discard']) {
    const res = await post(base, route, bob, { token });
    assert.equal(res.status, 404, route);
    assert.equal(res.body.code, 'not_found', route);
  }
  assert.equal((await post(base, 'preview', ada, { token })).status, 422, 'not burnt by the stranger');
});

test('a token is single-use: apply spends it, a replay is refused and the archive is gone', async () => {
  const { plugin, base } = await loaded();
  const ada = account('ada');
  const { token, folder } = await stageTracked(plugin, base, ada);
  const first = await post(base, 'apply', ada, { token });
  assert.equal(first.status, 422, 'no manifest in the archive');
  assert.equal(first.body.code, 'invalid_manifest');
  assert.equal(existsSync(folder), false, 'the archive is removed once its token is spent');
  for (const route of ['apply', 'preview', 'discard']) {
    assert.equal((await post(base, route, ada, { token })).status, 404, `${route} after apply`);
  }
});

test('two concurrent applies of one token: only one gets past the token', async () => {
  const { base } = await loaded();
  const ada = account('ada');
  const token = await stage(base, ada);
  const answers = await Promise.all([post(base, 'apply', ada, { token }), post(base, 'apply', ada, { token })]);
  assert.deepEqual(answers.map((a) => a.status).sort(), [404, 422]);
});

test('an archive changed on disk after stage is refused by apply and by preview', async () => {
  const { plugin, base } = await loaded();
  const ada = account('ada');
  const applied = await stageTracked(plugin, base, ada);
  appendFileSync(join(applied.folder, 'source.zip'), 'tampered');
  const refused = await post(base, 'apply', ada, { token: applied.token });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'archive_changed');
  assert.equal(existsSync(applied.folder), false, 'an altered archive is not kept');
  assert.equal((await post(base, 'apply', ada, { token: applied.token })).status, 404, 'and its token is spent');

  const previewed = await stageTracked(plugin, base, ada);
  appendFileSync(join(previewed.folder, 'source.zip'), 'tampered');
  assert.equal((await post(base, 'preview', ada, { token: previewed.token })).status, 409);
  assert.equal(existsSync(previewed.folder), false);
});

test('an invalid body is a 400, a wrong type a 415, and nothing is staged', async () => {
  const { plugin, base } = await loaded();
  const ada = account('ada');
  for (const route of ['preview', 'apply', 'discard']) {
    const bodies: unknown[] = [undefined, {}, { token: 'short' }, { token: 'a'.repeat(43), extra: 1 }, { token: 42 }, '[1,2]'];
    if (route !== 'discard') {
      bodies.push(
        { token: 'a'.repeat(43), options: { unknown: true } },
        { token: 'a'.repeat(43), options: { prefix: 'Bad Prefix' } },
        { token: 'a'.repeat(43), options: { agents: [{ sourceRef: 'x', elements: { shell: true } }] } },
      );
    } else {
      bodies.push({ token: 'a'.repeat(43), options: {} });
    }
    for (const body of bodies) {
      const res = await post(base, route, ada, body);
      assert.equal(res.status, 400, `${route} ${JSON.stringify(body)}`);
      assert.equal(res.body.code, 'invalid');
    }
  }
  const before = stagingFolders(plugin).length;
  const notZip = await post(base, 'stage', ada, Buffer.from('MZ not a zip at all'), 'application/zip');
  assert.equal(notZip.status, 400);
  assert.equal(notZip.body.code, 'not_a_zip');
  assert.equal((await post(base, 'stage', ada, Buffer.from('PK'), 'application/zip')).body.code, 'not_a_zip', 'too short to be one');
  assert.equal((await post(base, 'stage', ada, { token: 'x' })).status, 415, 'JSON is not an archive');
  assert.equal((await post(base, 'stage', ada, 'PK\u0003\u0004', 'text/plain')).status, 415);
  assert.equal(stagingFolders(plugin).length, before, 'a refused upload leaves no folder');
});

test('discard removes the staging; an account holds a bounded number of them', async () => {
  const { plugin, base } = await loaded();
  const ada = account('ada');
  const { token, folder } = await stageTracked(plugin, base, ada);
  const res = await post(base, 'discard', ada, { token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { discarded: true });
  assert.equal(existsSync(folder), false);
  assert.equal((await post(base, 'preview', ada, { token })).status, 404);

  const bob = account('bob');
  for (let i = 0; i < lib.STAGES_PER_ACCOUNT; i += 1) await stage(base, bob);
  const over = await post(base, 'stage', bob, EMPTY_ZIP, 'application/zip');
  assert.equal(over.status, 429);
  assert.equal(over.body.code, 'too_many');
  await stage(base, ada);
});

test('the token is never stored, logged nor echoed in an error', async () => {
  const { plugin, base } = await loaded();
  const ada = account('ada');
  const bob = account('bob');
  const logged: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ['log', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  }
  let token = '';
  const answers: string[] = [];
  try {
    token = await stage(base, ada);
    for (const route of ['preview', 'apply', 'discard']) answers.push(JSON.stringify((await post(base, route, bob, { token })).body));
    answers.push(JSON.stringify((await post(base, 'apply', ada, { token })).body));
    answers.push(JSON.stringify((await post(base, 'apply', ada, { token })).body));
  } finally {
    Object.assign(console, original);
  }
  assert.ok(token);
  for (const line of [...logged, ...answers]) assert.ok(!line.includes(token), `token leaked: ${line}`);
  const stored = JSON.stringify(await plugin.storage.kv.list());
  assert.ok(!stored.includes(token), 'the store keys records by a digest of the token');
});

test('apply declares the event agent-import:applied@1, whose payload is checked', async () => {
  await loaded();
  const event = integrationRegistries.events.get('agent-import:applied@1')?.definition;
  assert.ok(event, 'the event is registered');
  const payload = { sourceRef: 'hermes:default', agent: 'hermes.default', origin: 'plugin:agent-import', sourceApp: 'hermes' };
  assert.deepEqual(event.payloadSchema.parse(payload), payload);
  assert.throws(() => event.payloadSchema.parse({ ...payload, sourceRef: '' }));
  assert.throws(() => event.payloadSchema.parse({ ...payload, archive: 'bytes' }), 'nothing beyond the declared fields');
});

test('a staged manifest is previewed with the choices, then applied agent by agent', async () => {
  const { base } = await loaded();
  // The runtime that delivers business events: agent-import:applied@1 is published for real.
  const stopRuntime = startPluginWorkflowTriggers(false);
  cleanup.push(stopRuntime);
  const ada = account('ada', ['agents:manage', 'skills:manage', 'events:publish']);
  const manifest = {
    format: 'rooks-agent-import',
    version: 1,
    source: { app: 'routes-e2e', exportedAt: '2026-11-03T10:00:00Z' },
    agents: [
      { key: 'scout', displayName: 'Scout', soul: 'I scout.', instructions: 'Scout things.', sourceRef: 'scout-ref',
        skills: [{ id: 'scout-notes', content: '---\nname: scout-notes\n---\n\nTake notes.\n' }] },
      { key: 'skipped', displayName: 'Skipped', sourceRef: 'skipped-ref' },
    ],
  };
  const zip = Buffer.from(forgeZip([{ name: 'rooks-agent-import.json', data: JSON.stringify(manifest), method: 8 }]));
  const token = await stage(base, ada, zip);
  const options = { agents: [{ sourceRef: 'skipped-ref', include: false }, { sourceRef: 'scout-ref', elements: { soul: false } }] };
  const preview = await post(base, 'preview', ada, { token, options });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.ready, true);
  const agents = (preview.body.preview as { agents: Array<Record<string, unknown>> }).agents;
  assert.deepEqual(agents.map((a) => [a.finalName, a.action]), [['routes-e2e.scout', 'create'], ['routes-e2e.skipped', 'skip']]);
  assert.deepEqual((agents[0]!.elements as Record<string, unknown>).soul, { count: 1, selected: false });

  const logged: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  let applied: Answer;
  try {
    applied = await post(base, 'apply', ada, { token, options });
  } finally {
    console.warn = original;
  }
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const results = (applied.body as { agents: Array<Record<string, unknown>> }).agents;
  assert.deepEqual(results.map((a) => [a.agent, a.status]), [['routes-e2e.scout', 'created'], [null, 'skipped']]);
  assert.ok(getAgent('routes-e2e.scout'));
  assert.equal(getAgent('routes-e2e.skipped'), null);
  assert.equal(readDoc('routes-e2e.scout', 'SOUL.md'), null, 'an unticked element is not written');
  assert.ok(!logged.some((line) => line.includes('could not be published')), logged.join('\n'));
  assert.equal((await post(base, 'apply', ada, { token, options })).status, 404, 'the token is spent');
});

/* ── export-skill ───────────────────────────────────────────────────────── */

async function getSkill(base: string, user: string | null): Promise<Response> {
  return fetch(`${base}/export-skill`, { headers: user ? { 'x-test-user': user } : {} });
}

test('export-skill: an anonymous caller is refused', async () => {
  const { base } = await loaded();
  const res = await getSkill(base, null);
  assert.equal(res.status, 401);
  assert.equal((await res.json() as { code?: string }).code, 'unauthorized');
});

test('export-skill: an account that may not create agents is refused', async () => {
  const { base } = await loaded();
  const res = await getSkill(base, account('reader', ['agents:read']));
  assert.equal(res.status, 403);
  assert.equal((await res.json() as { code?: string }).code, 'forbidden');
});

test('export-skill: an importer gets the SKILL.md of the package, byte for byte', async () => {
  const { base } = await loaded();
  const res = await getSkill(base, account('importer'));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/markdown/);
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="SKILL.md"');
  const file = fileURLToPath(new URL('../../../plugins/agent-import/skills/rooks-export/SKILL.md', import.meta.url));
  // Line endings aside: a Windows checkout may hold the file as CRLF.
  const lf = (text: string): string => text.replace(/\r\n/g, '\n');
  assert.equal(lf(await res.text()), lf(readFileSync(file, 'utf8')), 'lib/index.js is rebuilt from the current SKILL.md');
});
