/**
 * `/api/backends/custom` — who may add a backend, and where the key goes.
 *
 * The refusals come first: a profile decides where prompts are sent, and the
 * form stores a key reserved to its backend (TODO #531, 5-B). Isolated ROOKS_HOME, witnesses on 127.0.0.1:0.
 */
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../../../tests/helpers/accounts.js';

const HOME = mkdtempSync(join(tmpdir(), 'rooks-custom-backends-'));
process.env.ROOKS_HOME = HOME;
await import('../../../tests/helpers/paid-license.js');
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerCustomBackendRoutes } = await import('./custom-routes.js');
const { dbApi } = await import('../../db.js');
const { createSecret, deleteSecret } = await import('../../secrets/store.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { SETUP_ROLE_PRESETS } = await import('../../../tests/helpers/presets.js');
const { isBackendName } = await import('../../backends/index.js');
const { activeProfiles } = await import('../../backends/registry.js');
const { catalogBackend } = await import('../../backends/catalog.js');

const TOKEN = 'witness-daemon-token';
const KEY = 'sk-witness-9d2e7b41';
/** The key the #571 tests post the way the `rooks backend` CLI will. */
const CLI_KEY = 'sk-cli-witness-5f0c2a';

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerCustomBackendRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** Stand-in provider: accepts KEY and CLI_KEY, refuses anything else, records what it got. */
const seen: { url: string; authorization: string | undefined }[] = [];
const provider = createServer((req, res) => {
  seen.push({ url: req.url ?? '', authorization: req.headers.authorization });
  if (![`Bearer ${KEY}`, `Bearer ${CLI_KEY}`].includes(req.headers.authorization ?? '')) { res.writeHead(401).end('bad key'); return; }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'witness-1' }] }));
});
provider.listen(0, '127.0.0.1');
await once(provider, 'listening');
const providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
{
  const { mountOfficialProviders } = await import('../../../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

test.after(() => { server.close(); provider.close(); });

function sessionCookie(res: Response): string | undefined {
  const lines = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const line of lines) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; bearer?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, text, res };
}

const setup = await call('POST', '/api/auth/setup', { body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' } });
assert.equal(setup.status, 201);
const adminCookie = sessionCookie(setup.res)!;

const created = await postTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', password: 'ada-secret' });
const adaId = (created.json as { user: { id: string } }).user.id;
// Every permission the catalogue knows short of `*`: the surface must stay
// closed to it — being superadmin is not a permission one can be granted.
grantTestPermissions(dbApi, adaId, ['settings', 'settings:write', 'secrets:manage', 'plugins:manage', ...SETUP_ROLE_PRESETS.flatMap((p) => p.permissions).filter((p) => p !== '*')]);
const adaCookie = sessionCookie((await call('POST', '/api/auth/login', { body: { email: 'ada@example.com', password: 'ada-secret' } })).res)!;
assert.ok(adminCookie && adaCookie);

const form = { name: 'Witness LLM', baseUrl: providerUrl, key: KEY, protocol: 'openai-responses', models: ['witness-1'] };
const ROUTES: [string, string, unknown?][] = [
  ['GET', '/api/backends/manage'],
  ['PATCH', '/api/backends/manage/claude', { disabled: true }],
  ['GET', '/api/backends/custom'],
  ['POST', '/api/backends/custom', form],
  ['POST', '/api/backends/custom/test', { protocol: 'openai-responses', baseUrl: providerUrl, key: KEY }],
  ['PATCH', '/api/backends/custom/witness-llm', { name: 'Renamed' }],
  ['DELETE', '/api/backends/custom/witness-llm'],
];

test('an anonymous request is refused on every route, and nothing is written', async () => {
  const before = seen.length;
  for (const [method, path, body] of ROUTES) {
    assert.equal((await call(method, path, { body })).status, 401, `${method} ${path}`);
  }
  assert.equal(existsSync(join(HOME, 'backends', 'witness-llm.json')), false);
  assert.equal(dbApi.listSecrets().length, 0);
  assert.equal(seen.length, before, 'no outbound call on behalf of an anonymous caller');
});

test('a signed-in user who is not superadmin is refused, whatever was granted', async () => {
  for (const [method, path, body] of ROUTES) {
    assert.equal((await call(method, path, { body, cookie: adaCookie })).status, 403, `${method} ${path}`);
  }
  assert.equal(dbApi.listSecrets().length, 0);
});

test('a rejected body is not echoed back', async () => {
  const out = await call('POST', '/api/backends/custom', { cookie: adminCookie, body: { ...form, baseUrl: 'ftp://x', cmd: KEY } });
  assert.equal(out.status, 400);
  assert.doesNotMatch(out.text, /sk-witness/);
});

test('the form stores the key reserved to its backend, never global, and the backend is dispatchable at once', async () => {
  const out = await call('POST', '/api/backends/custom', { cookie: adminCookie, body: form });
  assert.equal(out.status, 201, out.text);
  assert.doesNotMatch(out.text, /sk-witness/);
  const backend = (out.json as { backend: { id: string; active: boolean; reason: string | null } }).backend;
  assert.deepEqual([backend.id, backend.active, backend.reason], ['witness-llm', true, null]);

  const file = readFileSync(join(HOME, 'backends', 'witness-llm.json'), 'utf8');
  assert.doesNotMatch(file, /sk-witness/, 'the file carries a reference, never the key');
  assert.match(file, /"secret": "BACKEND_WITNESS_LLM_API_KEY"/);

  const secret = dbApi.listSecrets().find((row) => row.name === 'BACKEND_WITNESS_LLM_API_KEY');
  assert.deepEqual(secret?.grants, [{ scope_kind: 'backend', scope_ref: 'witness-llm' }]);
  assert.equal(isBackendName('witness-llm'), true);
  // Nothing but the backend's own process: not the vault slice of a mission
  // on another backend, not a plugin.
  const { secretsEnvFor } = await import('../../secrets/env.js');
  const { readPluginSecret } = await import('../../secrets/plugins.js');
  assert.equal(secretsEnvFor({ agent: 'acme.coder', project: 'acme' })['BACKEND_WITNESS_LLM_API_KEY'], undefined);
  assert.equal(readPluginSecret('witness-provider', 'BACKEND_WITNESS_LLM_API_KEY'), undefined);

  const resolved = await activeProfiles().find((p) => p.profile.id === 'witness-llm')!.runtimeFor({});
  assert.equal(resolved.runtime.env['BACKEND_WITNESS_LLM_API_KEY'], KEY, 'resolved at spawn, from the vault');
  assert.equal(resolved.runtime.providerConfig?.baseUrl, providerUrl);
});

test('the listing shows the address and never the key', async () => {
  const out = await call('GET', '/api/backends/custom', { cookie: adminCookie });
  assert.equal(out.status, 200);
  assert.doesNotMatch(out.text, /sk-witness/);
  const row = (out.json as { backends: { id: string; baseUrl: string; hasVaultKey: boolean }[] }).backends[0]!;
  assert.deepEqual([row.id, row.baseUrl, row.hasVaultKey], ['witness-llm', providerUrl, true]);
});

test('adding the same backend twice is a conflict, and a product id is refused', async () => {
  assert.equal((await call('POST', '/api/backends/custom', { cookie: adminCookie, body: form })).status, 409);
  const hijack = await call('POST', '/api/backends/custom', { cookie: adminCookie, body: { ...form, id: 'claude', key: undefined } });
  assert.equal(hijack.status, 409);
  assert.equal(existsSync(join(HOME, 'backends', 'claude.json')), false, 'rolled back');
});

test('Test tells a good key from a refused one from a dead address', async () => {
  const outcome = async (body: unknown) => ((await call('POST', '/api/backends/custom/test', { cookie: adminCookie, body })).json as { outcome: string }).outcome;
  assert.equal(await outcome({ protocol: 'openai-responses', baseUrl: providerUrl, key: KEY }), 'ok');
  assert.equal(await outcome({ protocol: 'openai-responses', baseUrl: providerUrl, key: 'wrong' }), 'key-refused');
  assert.equal(await outcome({ protocol: 'openai-responses', baseUrl: 'http://127.0.0.1:1/v1', key: KEY }), 'unreachable');
  assert.equal(await outcome({ id: 'witness-llm' }), 'ok', 'a saved backend is tested with its own vault key');
});

test('a saved key cannot be pointed at another address', async () => {
  const before = seen.length;
  const out = await call('POST', '/api/backends/custom/test', { cookie: adminCookie, body: { id: 'witness-llm', protocol: 'openai-responses', baseUrl: providerUrl } });
  assert.equal(out.status, 400);
  assert.equal(seen.length, before);
});

test('an edit names the models and their pictures, and leaves the key alone', async () => {
  const out = await call('PATCH', '/api/backends/custom/witness-llm', {
    cookie: adminCookie,
    body: {
      name: 'Witness renamed',
      models: [{ slug: 'witness-1', label: 'Witness One', icon: '🦉' }, 'witness-2'],
      defaultModel: 'witness-2',
      icon: '/api/uploads/backends/witness.png',
    },
  });
  assert.equal(out.status, 200, out.text);
  const backend = (out.json as { backend: { label: string; icon: string; defaultModel: string; models: { slug: string; label: string; icon?: string }[] } }).backend;
  assert.deepEqual([backend.label, backend.icon, backend.defaultModel], ['Witness renamed', '/api/uploads/backends/witness.png', 'witness-2']);
  assert.deepEqual(backend.models.map(({ slug, label, icon }) => ({ slug, label, ...(icon ? { icon } : {}) })), [{ slug: 'witness-1', label: 'Witness One', icon: '🦉' }, { slug: 'witness-2', label: 'witness-2' }]);

  // The catalogue is the surface the selectors read: an edit that did not
  // reach it would show up nowhere.
  assert.deepEqual(catalogBackend('witness-llm')?.models.map((m) => m.slug), ['witness-1', 'witness-2']);
  const resolved = await activeProfiles().find((p) => p.profile.id === 'witness-llm')!.runtimeFor({});
  assert.equal(resolved.runtime.env['BACKEND_WITNESS_LLM_API_KEY'], KEY, 'an edit that says nothing of the key keeps it');
});

test('a bare slug keeps the label and the picture it already had', async () => {
  const out = await call('PATCH', '/api/backends/custom/witness-llm', { cookie: adminCookie, body: { models: ['witness-1'] } });
  assert.equal(out.status, 200, out.text);
  const backend = (out.json as { backend: { defaultModel: string | null; models: { slug: string; label: string; icon?: string }[] } }).backend;
  assert.deepEqual(backend.models.map(({ slug, label, icon }) => ({ slug, label, ...(icon ? { icon } : {}) })), [{ slug: 'witness-1', label: 'Witness One', icon: '🦉' }]);
  assert.equal(backend.defaultModel, 'witness-1', 'a default the new list no longer serves is recalled');
});

test('an edit rotates the key in place, and never sends one back', async () => {
  const out = await call('PATCH', '/api/backends/custom/witness-llm', { cookie: adminCookie, body: { key: 'sk-witness-rotated' } });
  assert.equal(out.status, 200, out.text);
  assert.doesNotMatch(out.text, /sk-witness/);
  const named = dbApi.listSecrets().filter((row) => row.name === 'BACKEND_WITNESS_LLM_API_KEY');
  assert.equal(named.length, 1, 'rotated in place, not duplicated');
  const resolved = await activeProfiles().find((p) => p.profile.id === 'witness-llm')!.runtimeFor({});
  assert.equal(resolved.runtime.env['BACKEND_WITNESS_LLM_API_KEY'], 'sk-witness-rotated');
  assert.deepEqual(named[0]!.grants, [{ scope_kind: 'backend', scope_ref: 'witness-llm' }], 'still reserved after rotation');
});

test('rotating a key stored before 5-B (global) reserves it; one shared by hand keeps its grants', async () => {
  const row = dbApi.listSecrets().find((r) => r.name === 'BACKEND_WITNESS_LLM_API_KEY')!;
  // The shape the form wrote before TODO #531 (5-B).
  dbApi.removeSecretGrant(row.id, 'backend', 'witness-llm');
  dbApi.addSecretGrant(row.id, 'global', null);
  assert.equal((await call('PATCH', '/api/backends/custom/witness-llm', { cookie: adminCookie, body: { key: KEY } })).status, 200);
  assert.deepEqual(dbApi.getSecret(row.id)!.grants, [{ scope_kind: 'backend', scope_ref: 'witness-llm' }]);

  // Shared on purpose with a project: the rotation changes the value only.
  dbApi.removeSecretGrant(row.id, 'backend', 'witness-llm');
  dbApi.addSecretGrant(row.id, 'project', 'acme');
  assert.equal((await call('PATCH', '/api/backends/custom/witness-llm', { cookie: adminCookie, body: { key: KEY } })).status, 200);
  assert.deepEqual(dbApi.getSecret(row.id)!.grants, [{ scope_kind: 'project', scope_ref: 'acme' }]);
  // Put back for the tests that follow.
  dbApi.removeSecretGrant(row.id, 'project', 'acme');
  dbApi.addSecretGrant(row.id, 'backend', 'witness-llm');
});

test('an edit that would not load leaves the backend as it was', async () => {
  const before = readFileSync(join(HOME, 'backends', 'witness-llm.json'), 'utf8');
  const out = await call('PATCH', '/api/backends/custom/witness-llm', { cookie: adminCookie, body: { icon: 'https://evil.example/logo.svg' } });
  assert.equal(out.status, 400, out.text);
  assert.equal(readFileSync(join(HOME, 'backends', 'witness-llm.json'), 'utf8'), before, 'the file on disk is untouched');
  assert.equal((await call('PATCH', '/api/backends/custom/nobody', { cookie: adminCookie, body: { name: 'x' } })).status, 404);
});

test('a picture is stored, served to anyone signed in, and dropped when nothing points at it', async () => {
  // 1×1 PNG: the smallest thing the store accepts, and enough to prove the
  // bytes come back.
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  assert.equal((await call('POST', '/api/uploads/backends', { body: { dataUrl: PNG } })).status, 401);
  assert.equal((await call('POST', '/api/uploads/backends', { cookie: adaCookie, body: { dataUrl: PNG } })).status, 403);
  assert.equal((await call('POST', '/api/uploads/backends', { cookie: adminCookie, body: { dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } })).status, 400, 'an SVG can carry script');

  const first = await call('POST', '/api/uploads/backends', { cookie: adminCookie, body: { dataUrl: PNG } });
  assert.equal(first.status, 200, first.text);
  const firstUrl = (first.json as { url: string }).url;
  const second = (await call('POST', '/api/uploads/backends', { cookie: adminCookie, body: { dataUrl: PNG } })).json as { url: string };

  // Read by a plain user: every LLM selector in the product draws these.
  const served = await call('GET', firstUrl, { cookie: adaCookie });
  assert.equal(served.status, 200);
  assert.equal(served.res.headers.get('content-type'), 'image/png');
  assert.equal((await call('GET', '/api/uploads/backends/..%2F..%2Fdaemon-token', { cookie: adminCookie })).status, 400);

  const create = await call('POST', '/api/backends/custom', {
    cookie: adminCookie,
    body: { name: 'Picture box', baseUrl: 'http://127.0.0.1:1234', protocol: 'anthropic', icon: firstUrl, models: [{ slug: 'p-1', label: 'One', icon: second.url }] },
  });
  assert.equal(create.status, 201, create.text);

  const swap = await call('PATCH', '/api/backends/custom/picture-box', { cookie: adminCookie, body: { icon: '🖼️' } });
  assert.equal(swap.status, 200, swap.text);
  assert.equal((await call('GET', firstUrl, { cookie: adminCookie })).status, 404, 'the replaced picture is gone');
  assert.equal((await call('GET', second.url, { cookie: adminCookie })).status, 200, 'the one a model still uses stays');

  assert.equal((await call('DELETE', '/api/backends/custom/picture-box', { cookie: adminCookie })).status, 200);
  assert.equal((await call('GET', second.url, { cookie: adminCookie })).status, 404, 'removing the backend takes its pictures along');
});

test('removing a backend takes it out of dispatch, and its key out of the vault', async () => {
  assert.equal((await call('DELETE', '/api/backends/custom/..%2Fdaemon-token', { cookie: adminCookie })).status, 400);
  const out = await call('DELETE', '/api/backends/custom/witness-llm', { cookie: adminCookie });
  assert.equal(out.status, 200);
  assert.deepEqual(out.json, { ok: true, removedSecrets: ['BACKEND_WITNESS_LLM_API_KEY'] });
  assert.equal(isBackendName('witness-llm'), false);
  assert.equal(dbApi.listSecrets().length, 0);
  assert.equal((await call('DELETE', '/api/backends/custom/witness-llm', { cookie: adminCookie })).status, 404);
});

test('removing a backend answers what left the vault: neither a shared secret nor one of the same name', async () => {
  const keyless = await call('POST', '/api/backends/custom', { cookie: adminCookie, body: { name: 'No key box', baseUrl: 'http://127.0.0.1:1234', protocol: 'anthropic' } });
  assert.equal(keyless.status, 201, keyless.text);
  assert.deepEqual((await call('DELETE', '/api/backends/custom/no-key-box', { cookie: adminCookie })).json, { ok: true, removedSecrets: [] });

  // Same name as the form would pick, but the vault's own note says nobody tied it to this backend.
  const profile = (secret: string) => JSON.stringify({
    id: 'hand-shared', dialect: 'claude', label: 'Hand shared',
    env: { ANTHROPIC_BASE_URL: 'https://hand.example.com', ANTHROPIC_AUTH_TOKEN: { secret } }, defaultModel: null, models: [],
  });
  for (const name of ['TEAM_SHARED_KEY', 'BACKEND_HAND_SHARED_API_KEY']) {
    const shared = createSecret({ name, value: KEY, grants: [{ scope_kind: 'global', scope_ref: null }] });
    writeFileSync(join(HOME, 'backends', 'hand-shared.json'), profile(name));
    const out = await call('DELETE', '/api/backends/custom/hand-shared', { cookie: adminCookie });
    assert.equal(out.status, 200, out.text);
    assert.deepEqual(out.json, { ok: true, removedSecrets: [] }, name);
    assert.equal(dbApi.listSecrets().filter((row) => row.id === shared.id).length, 1, `${name} stays`);
    deleteSecret(shared.id);
  }
});

test('an id with doubled or trailing dashes still yields a nameable variable', async () => {
  // `LOCAL_BACKEND_ID_RE` allows `acme--eu` and `acme-`; `env-shape.ts` refuses
  // `BACKEND_ACME__EU_API_KEY`. Without the collapse, the form would 400 on a
  // variable name the user never typed and cannot see.
  const out = await call('POST', '/api/backends/custom', { cookie: adminCookie, body: { ...form, id: 'acme--eu-', name: 'Acme EU' } });
  assert.equal(out.status, 201, out.text);
  const file = readFileSync(join(HOME, 'backends', 'acme--eu-.json'), 'utf8');
  assert.match(file, /"secret": "BACKEND_ACME_EU_API_KEY"/);
  assert.equal(isBackendName('acme--eu-'), true);
  assert.equal((await call('DELETE', '/api/backends/custom/acme--eu-', { cookie: adminCookie })).status, 200);
});

test('an endpoint without a key gets a placeholder, never an empty credential', async () => {
  const out = await call('POST', '/api/backends/custom', { cookie: adminCookie, body: { name: 'Local box', baseUrl: 'http://127.0.0.1:1234', protocol: 'anthropic' } });
  assert.equal(out.status, 201, out.text);
  const resolved = await activeProfiles().find((p) => p.profile.id === 'local-box')!.runtimeFor({});
  assert.equal(resolved.runtime.env['ANTHROPIC_AUTH_TOKEN'], 'not-needed');
  assert.equal(dbApi.listSecrets().length, 0);
});

test('management lists every origin, warns about references, and refuses execution fields', async () => {
  const { registerProfile } = await import('../../backends/registry.js');
  const dispose = registerProfile('witness-plugin', { id: 'plugin-witness', dialect: 'claude', label: 'Plugin witness', models: [], defaultModel: null });
  const directory = join(HOME, 'agents', 'managed-witness');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ backend: 'claude' }));
  dbApi.createTask('managed-task', 'Pending witness', 'managed-witness', { backendOverride: 'claude' });
  dbApi.createRoutine({ id: 'managed-routine', name: 'Routine witness', agent_name: 'managed-witness', prompt: 'test', task_type: 'code', cron_expr: '0 0 * * *', enabled: 1, project: null, next_run_at: null });
  try {
    const out = await call('GET', '/api/backends/manage', { cookie: adminCookie });
    assert.equal(out.status, 200, out.text);
    const rows = (out.json as { backends: { id: string; origin: string; usages: { agents: { id: string }[]; tasks: { id: string }[]; routines: { id: string }[] } }[] }).backends;
    const builtin = rows.find((row) => row.id === 'claude')!;
    assert.equal(builtin.origin, 'plugin');
    assert.ok(builtin.usages.agents.some((row) => row.id === 'managed-witness'));
    assert.ok(builtin.usages.tasks.some((row) => row.id === 'managed-task'));
    assert.ok(builtin.usages.routines.some((row) => row.id === 'managed-routine'));
    assert.equal(rows.find((row) => row.id === 'plugin-witness')?.origin, 'plugin');
    assert.equal(rows.find((row) => row.id === 'local-box')?.origin, 'file');
    for (const id of ['claude', 'plugin-witness']) {
      for (const field of ['baseUrl', 'env', 'cmd', 'key']) {
        const refused = await call('PATCH', `/api/backends/manage/${id}`, { cookie: adminCookie, body: { [field]: KEY } });
        assert.equal(refused.status, 400);
        assert.ok(!refused.text.includes(KEY));
      }
    }
    assert.ok(!out.text.includes(KEY));
    const patched = await call('PATCH', '/api/backends/manage/claude', { cookie: adminCookie, body: {
      disabled: true, label: 'Renamed builtin', rank: 1,
      models: [{ slug: 'claude-fable-5-1', label: 'Exact Fable' }], defaultModel: 'claude-fable-5-1',
    } });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(isBackendName('claude'), false);
    assert.equal((await call('PATCH', '/api/backends/manage/claude', { cookie: adminCookie, body: { disabled: false } })).status, 200);
    assert.equal(catalogBackend('claude')?.defaultModel, 'claude-fable-5-1');
  } finally { dispose(); }
});

test('management writes file availability and rank to the original file and preserves model timestamps', async () => {
  const first = await call('PATCH', '/api/backends/manage/local-box', { cookie: adminCookie, body: {
    disabled: true, rank: 0, models: [{ slug: 'local-new', label: 'Local new' }],
  } });
  assert.equal(first.status, 200, first.text);
  const file = JSON.parse(readFileSync(join(HOME, 'backends', 'local-box.json'), 'utf8')) as { disabled: boolean; rank: number; models: { addedAt: number }[] };
  assert.equal(file.disabled, true);
  assert.equal(file.rank, 0);
  assert.ok(file.models[0]?.addedAt);
  assert.equal(isBackendName('local-box'), false);
  const second = await call('PATCH', '/api/backends/manage/local-box', { cookie: adminCookie, body: {
    disabled: false, models: [{ slug: 'local-new', label: 'Renamed', addedAt: 0 }],
  } });
  assert.equal(second.status, 200, second.text);
  assert.equal(catalogBackend('local-box')?.models[0]?.addedAt, file.models[0]?.addedAt);
  assert.ok(!dbApi.listBackendOverlays().some((row) => row.id === 'local-box'));
});

test('management itself rejects anonymous access even without the global auth middleware', async () => {
  const bare = express();
  bare.use(express.json());
  registerCustomBackendRoutes(bare);
  const witness = bare.listen(0, '127.0.0.1');
  await once(witness, 'listening');
  try {
    const address = `http://127.0.0.1:${(witness.address() as AddressInfo).port}`;
    assert.equal((await fetch(`${address}/api/backends/manage`)).status, 401);
    assert.equal((await fetch(`${address}/api/backends/manage/claude`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"disabled":true}',
    })).status, 401);
  } finally { witness.close(); }
});

test('cleared built-in pictures reopen as null and can be saved again', async () => {
  const first = await call('PATCH', '/api/backends/manage/claude', { cookie: adminCookie, body: { icon: null, brand: null } });
  assert.equal(first.status, 200, first.text);
  const view = (first.json as { backend: { icon: string | null; brand: string | null } }).backend;
  assert.equal(view.icon, null);
  assert.equal(view.brand, null);
  assert.equal((await call('PATCH', '/api/backends/manage/claude', { cookie: adminCookie,
    body: { icon: view.icon, brand: view.brand } })).status, 200);
});

test('a valid hand-written file can be managed without rewriting its connection or discovery settings', async () => {
  const { writeLocalBackend } = await import('../../backends/local-profiles.js');
  writeLocalBackend({ id: 'hand-written', dialect: 'claude', label: 'Hand written',
    env: { ANTHROPIC_AUTH_TOKEN: 'not-needed' },
    modelsEndpoint: { url: 'http://127.0.0.1:1/models', format: 'openai' },
    models: [{ slug: 'hand-model', label: 'Hand model', contextWindow: 12345 }], defaultModel: 'hand-model' });
  const response = await call('PATCH', '/api/backends/manage/hand-written', { cookie: adminCookie, body: {
    disabled: true, rank: 2, name: 'Hand renamed', models: [{ slug: 'hand-model', label: 'Renamed model' }],
  } });
  assert.equal(response.status, 200, response.text);
  const saved = JSON.parse(readFileSync(join(HOME, 'backends', 'hand-written.json'), 'utf8')) as { disabled: boolean; rank: number; env: Record<string, string>; modelsEndpoint: { url: string }; models: { contextWindow: number; label: string }[] };
  assert.equal(saved.disabled, true);
  assert.equal(saved.rank, 2);
  assert.deepEqual(saved.env, { ANTHROPIC_AUTH_TOKEN: 'not-needed' });
  assert.equal(saved.modelsEndpoint.url, 'http://127.0.0.1:1/models');
  assert.equal(saved.models[0].contextWindow, 12345);
  assert.equal(saved.models[0].label, 'Renamed model');
});

test('declared thinking levels survive an edit, can be set and cleared, and the catalogue fills the rest read-only', async () => {
  const { writeLocalBackend } = await import('../../backends/local-profiles.js');
  writeLocalBackend({ id: 'bai-like', dialect: 'claude', label: 'B.AI like',
    env: { ANTHROPIC_BASE_URL: 'https://api.b.ai', ANTHROPIC_AUTH_TOKEN: 'not-needed' },
    models: [
      { slug: 'claude-sonnet-4.6', label: 'Sonnet', supportedReasoningLevels: ['low', 'high'] },
      { slug: 'qwen3.8-max', label: 'Qwen' },
    ], defaultModel: 'claude-sonnet-4.6' });
  type View = { slug: string; supportedReasoningLevels?: string[]; reasoning?: { source: string; catalogEntry?: string } };
  const file = () => JSON.parse(readFileSync(join(HOME, 'backends', 'bai-like.json'), 'utf8')) as { models: { slug: string; supportedReasoningLevels?: string[]; reasoning?: unknown }[] };

  // What the form sends: names, never levels.
  const renamed = await call('PATCH', '/api/backends/custom/bai-like', { cookie: adminCookie, body: {
    name: 'B.AI renamed', models: [{ slug: 'claude-sonnet-4.6', label: 'Sonnet 4.6' }, 'qwen3.8-max'],
  } });
  assert.equal(renamed.status, 200, renamed.text);
  assert.deepEqual(file().models[0]!.supportedReasoningLevels, ['low', 'high'], 'an edit that says nothing of the levels keeps them');
  const views = (renamed.json as { backend: { models: View[] } }).backend.models;
  assert.deepEqual(views[0]!.supportedReasoningLevels, ['low', 'high']);
  assert.equal(views[0]!.reasoning?.source, 'declared');
  assert.equal(views[1]!.reasoning?.source, 'catalog');
  assert.equal(views[1]!.reasoning?.catalogEntry, 'alibaba/qwen3.8-max');
  assert.equal(views[1]!.supportedReasoningLevels, undefined);
  assert.ok(file().models.every((model) => model.reasoning === undefined), 'the resolution never reaches the file');

  const set = await call('PATCH', '/api/backends/custom/bai-like', { cookie: adminCookie, body: {
    models: [{ slug: 'claude-sonnet-4.6', supportedReasoningLevels: null }, { slug: 'qwen3.8-max', supportedReasoningLevels: ['on'] }],
  } });
  assert.equal(set.status, 200, set.text);
  assert.equal(file().models[0]!.supportedReasoningLevels, undefined, 'null clears');
  assert.deepEqual(file().models[1]!.supportedReasoningLevels, ['on']);
  assert.equal(catalogBackend('bai-like')?.models.find((m) => m.slug === 'claude-sonnet-4.6')?.reasoning?.source, 'catalog');
});

test('the effort levels an Anthropic endpoint reports are kept as the agent source, below declared levels', async () => {
  const anthropic = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [
      { id: 'claude-opus-5-5', capabilities: { effort: { supported: true, high: { supported: true }, low: { supported: true }, max: { supported: true } } } },
      { id: 'claude-sonnet-4.6', capabilities: { effort: { supported: true, max: { supported: true } } } },
      { id: 'qwen3.8-max' },
    ] }));
  });
  anthropic.listen(0, '127.0.0.1');
  await once(anthropic, 'listening');
  try {
    const anthropicUrl = `http://127.0.0.1:${(anthropic.address() as AddressInfo).port}`;
    const { writeLocalBackend, reloadLocalBackends } = await import('../../backends/local-profiles.js');
    writeLocalBackend({ id: 'reporting', dialect: 'claude', label: 'Reporting',
      env: { ANTHROPIC_BASE_URL: anthropicUrl, ANTHROPIC_AUTH_TOKEN: 'not-needed' },
      models: [
        { slug: 'claude-opus-5-5', label: 'Opus' },
        { slug: 'claude-sonnet-4.6', label: 'Sonnet', supportedReasoningLevels: ['low', 'high'] },
        { slug: 'qwen3.8-max', label: 'Qwen' },
      ], defaultModel: 'claude-opus-5-5' });
    reloadLocalBackends();
    type FileModel = { slug: string; reportedReasoningLevels?: string[] };
    const file = () => (JSON.parse(readFileSync(join(HOME, 'backends', 'reporting.json'), 'utf8')) as { models: FileModel[] }).models;

    const tested = await call('POST', '/api/backends/custom/test', { cookie: adminCookie, body: { id: 'reporting' } });
    assert.equal(tested.status, 200, tested.text);
    assert.deepEqual((tested.json as { reasoningLevels?: unknown }).reasoningLevels, {
      'claude-opus-5-5': ['low', 'high', 'max'], 'claude-sonnet-4.6': ['max'],
    });
    assert.deepEqual(file().map((m) => m.reportedReasoningLevels), [['low', 'high', 'max'], ['max'], undefined]);

    const models = catalogBackend('reporting')!.models;
    const source = (slug: string) => models.find((m) => m.slug === slug)?.reasoning?.source;
    assert.equal(source('claude-sonnet-4.6'), 'declared', 'declared wins over the endpoint');
    assert.equal(source('claude-opus-5-5'), 'agent', 'the endpoint wins over the catalogue');
    assert.equal(source('qwen3.8-max'), 'catalog', 'nothing reported: the catalogue answers');
    assert.equal(models.find((m) => m.slug === 'claude-opus-5-5')?.supportedReasoningLevels, undefined, 'no slider from a report alone');

    const renamed = await call('PATCH', '/api/backends/custom/reporting', { cookie: adminCookie, body: { models: [{ slug: 'claude-opus-5-5', label: 'Opus 5.5' }, 'claude-sonnet-4.6', 'qwen3.8-max'] } });
    assert.equal(renamed.status, 200, renamed.text);
    assert.deepEqual(file()[0]!.reportedReasoningLevels, ['low', 'high', 'max'], 'an edit that says nothing of them keeps them');
    const views = (renamed.json as { backend: { models: { slug: string; reasoning?: { source: string } }[] } }).backend.models;
    assert.equal(views[0]!.reasoning?.source, 'agent');

    const unsaved = await call('POST', '/api/backends/custom/test', { cookie: adminCookie, body: { protocol: 'anthropic', baseUrl: anthropicUrl } });
    assert.deepEqual((unsaved.json as { reasoningLevels?: Record<string, string[]> }).reasoningLevels?.['claude-opus-5-5'], ['low', 'high', 'max']);
    const created = await call('POST', '/api/backends/custom', { cookie: adminCookie, body: {
      name: 'Reported on create', protocol: 'anthropic', baseUrl: anthropicUrl,
      models: [{ slug: 'claude-opus-5-5', reportedReasoningLevels: ['low', 'high', 'max'] }],
    } });
    assert.equal(created.status, 201, created.text);
    assert.equal(catalogBackend('reported-on-create')?.models[0]?.reasoning?.source, 'agent');
  } finally {
    anthropic.close();
  }
});

test('a thinking control picked by hand wins over the detection and survives edits and the Test button', async () => {
  const anthropic = createServer((_req, res) => {
    // Ids only, plus effort levels for one model: what a gateway and Anthropic send.
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [
      { id: 'qwen3.8-max' },
      { id: 'qwen3.8-27b', capabilities: { effort: { supported: true, low: { supported: true }, high: { supported: true } } } },
    ] }));
  });
  anthropic.listen(0, '127.0.0.1');
  await once(anthropic, 'listening');
  try {
    const anthropicUrl = `http://127.0.0.1:${(anthropic.address() as AddressInfo).port}`;
    const { writeLocalBackend, reloadLocalBackends } = await import('../../backends/local-profiles.js');
    writeLocalBackend({ id: 'manual', dialect: 'claude', label: 'Manual',
      env: { ANTHROPIC_BASE_URL: anthropicUrl, ANTHROPIC_AUTH_TOKEN: 'not-needed' },
      models: [{ slug: 'qwen3.8-max', label: 'Qwen max' }, { slug: 'qwen3.8-27b', label: 'Qwen 27b' }],
      defaultModel: 'qwen3.8-max' });
    reloadLocalBackends();
    type FileModel = { slug: string; supportedReasoningLevels?: string[]; reportedReasoningLevels?: string[]; reasoningControl?: unknown };
    const file = () => (JSON.parse(readFileSync(join(HOME, 'backends', 'manual.json'), 'utf8')) as { models: FileModel[] }).models;
    type Resolution = { source: string; thinks: boolean; controls: unknown[] };
    type View = { slug: string; reasoningControl?: unknown; reasoning?: Resolution; detectedReasoning?: Resolution };

    const set = await call('PATCH', '/api/backends/custom/manual', { cookie: adminCookie, body: { models: [
      { slug: 'qwen3.8-max', reasoningControl: { type: 'budget', max: 16000 } },
      { slug: 'qwen3.8-27b', reasoningControl: { type: 'toggle' } },
    ] } });
    assert.equal(set.status, 200, set.text);
    assert.deepEqual(file().map((m) => m.reasoningControl), [{ type: 'budget', max: 16000 }, { type: 'toggle' }]);
    const views = (set.json as { backend: { models: View[] } }).backend.models;
    assert.deepEqual(views[0]!.reasoning, { source: 'declared', thinks: true, controls: [{ type: 'budget', max: 16000 }] });
    assert.equal(views[0]!.detectedReasoning?.source, 'catalog', 'what was detected stays visible next to the correction');
    assert.deepEqual(views[1]!.reasoning?.controls, [{ type: 'toggle' }]);

    // The Test button: it rewrites the file with the levels the endpoint reported.
    const tested = await call('POST', '/api/backends/custom/test', { cookie: adminCookie, body: { id: 'manual' } });
    assert.equal(tested.status, 200, tested.text);
    assert.deepEqual(file()[1]!.reportedReasoningLevels, ['low', 'high']);
    assert.deepEqual(file().map((m) => m.reasoningControl), [{ type: 'budget', max: 16000 }, { type: 'toggle' }], 'Test keeps the manual choice');

    // What the form sends after a test: the ids, nothing else.
    const bare = await call('PATCH', '/api/backends/custom/manual', { cookie: adminCookie, body: { models: ['qwen3.8-max', 'qwen3.8-27b'] } });
    assert.equal(bare.status, 200, bare.text);
    assert.deepEqual(file().map((m) => m.reasoningControl), [{ type: 'budget', max: 16000 }, { type: 'toggle' }], 'bare ids keep the manual choice');

    const entry = catalogBackend('manual')!;
    assert.deepEqual(entry.thinkingControls, ['levels', 'budget', 'toggle']);
    const reasoningOf = (slug: string) => entry.models.find((m) => m.slug === slug)?.reasoning;
    assert.equal(reasoningOf('qwen3.8-27b')?.source, 'declared', 'declared wins over what the endpoint reported');
    const { claudeThinking } = await import('../../../official-providers/provider-claude/lib/thinking.js');
    assert.equal(claudeThinking('high', reasoningOf('qwen3.8-max')).env['MAX_THINKING_TOKENS'], '16000', 'the declared bound caps the budget sent');
    assert.equal(claudeThinking('off', reasoningOf('qwen3.8-27b')).env['MAX_THINKING_TOKENS'], '0');

    // Levels declared over a budget replace it; null goes back to the detection.
    const swap = await call('PATCH', '/api/backends/custom/manual', { cookie: adminCookie, body: { models: [
      { slug: 'qwen3.8-max', supportedReasoningLevels: ['low', 'high'] },
      { slug: 'qwen3.8-27b', reasoningControl: null },
    ] } });
    assert.equal(swap.status, 200, swap.text);
    assert.deepEqual(file()[0]!.supportedReasoningLevels, ['low', 'high']);
    assert.equal(file()[0]!.reasoningControl, undefined);
    assert.equal(file()[1]!.reasoningControl, undefined);
    assert.equal((swap.json as { backend: { models: View[] } }).backend.models[1]!.reasoning?.source, 'agent');

    const none = await call('PATCH', '/api/backends/custom/manual', { cookie: adminCookie, body: { models: [{ slug: 'qwen3.8-max', reasoningControl: { type: 'none' } }, 'qwen3.8-27b'] } });
    assert.equal(none.status, 200, none.text);
    assert.equal(file()[0]!.supportedReasoningLevels, undefined, 'a control declared over levels replaces them');
    assert.deepEqual(catalogBackend('manual')!.models[0]!.reasoning, { source: 'declared', thinks: false, controls: [] });

    const both = await call('PATCH', '/api/backends/custom/manual', { cookie: adminCookie, body: { models: [{ slug: 'qwen3.8-max', supportedReasoningLevels: ['high'], reasoningControl: { type: 'toggle' } }] } });
    assert.equal(both.status, 200, both.text);
    assert.deepEqual(file()[0]!.supportedReasoningLevels, ['high'], 'both in one request: levels win, nothing is lost');
    assert.equal(file()[0]!.reasoningControl, undefined);

    const inverted = await call('PATCH', '/api/backends/custom/manual', { cookie: adminCookie, body: { models: [{ slug: 'qwen3.8-max', reasoningControl: { type: 'budget', min: 9000, max: 100 } }] } });
    assert.equal(inverted.status, 400);
    const unknown = await call('PATCH', '/api/backends/custom/manual', { cookie: adminCookie, body: { models: [{ slug: 'qwen3.8-max', reasoningControl: { type: 'adaptive' } }] } });
    assert.equal(unknown.status, 400);

    const listed = await call('GET', '/api/backends/custom', { cookie: adminCookie });
    const protocols = (listed.json as { protocols: { protocol: string; thinkingControls: string[] }[] }).protocols;
    assert.deepEqual(protocols.find((p) => p.protocol === 'anthropic')?.thinkingControls, ['levels', 'budget', 'toggle']);
    assert.deepEqual(protocols.find((p) => p.protocol === 'openai-responses')?.thinkingControls, ['levels']);
  } finally {
    anthropic.close();
  }
});

test('a context window typed by hand is stored, marked declared, and cleared by null (#175)', async () => {
  const { writeLocalBackend, reloadLocalBackends } = await import('../../backends/local-profiles.js');
  writeLocalBackend({ id: 'windowed', dialect: 'claude', label: 'Windowed',
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'not-needed' },
    models: [{ slug: 'w-1', label: 'W one' }], defaultModel: 'w-1' });
  reloadLocalBackends();
  type FileModel = { slug: string; contextWindow?: number; contextWindowDeclared?: unknown };
  const file = () => (JSON.parse(readFileSync(join(HOME, 'backends', 'windowed.json'), 'utf8')) as { models: FileModel[] }).models;

  const set = await call('PATCH', '/api/backends/custom/windowed', { cookie: adminCookie, body: { models: [{ slug: 'w-1', contextWindow: 128_000 }] } });
  assert.equal(set.status, 200, set.text);
  assert.equal(file()[0]!.contextWindow, 128_000);
  assert.equal(file()[0]!.contextWindowDeclared, undefined, 'the marker is derived, never written to the file');
  const view = (set.json as { backend: { models: { contextWindow?: number; contextWindowDeclared?: boolean }[] } }).backend.models[0]!;
  assert.deepEqual([view.contextWindow, view.contextWindowDeclared], [128_000, true]);
  assert.deepEqual(
    [catalogBackend('windowed')?.models[0]?.contextWindow, catalogBackend('windowed')?.models[0]?.contextWindowDeclared],
    [128_000, true],
    'the selectors and the context gauge read the catalogue',
  );

  // A bare slug (the Test button) keeps it.
  assert.equal((await call('PATCH', '/api/backends/custom/windowed', { cookie: adminCookie, body: { models: ['w-1'] } })).status, 200);
  assert.equal(file()[0]!.contextWindow, 128_000);

  assert.equal((await call('PATCH', '/api/backends/custom/windowed', { cookie: adminCookie, body: { models: [{ slug: 'w-1', contextWindow: 12 }] } })).status, 400);
  const cleared = await call('PATCH', '/api/backends/custom/windowed', { cookie: adminCookie, body: { models: [{ slug: 'w-1', contextWindow: null }] } });
  assert.equal(cleared.status, 200, cleared.text);
  assert.equal(file()[0]!.contextWindow, undefined);
  assert.equal(catalogBackend('windowed')?.models[0]?.contextWindowDeclared, undefined);
});

test('a built-in model takes a hand-typed context window over its own, and gives it back on null (#175)', async () => {
  type Row = { id: string; models: { slug: string; contextWindow?: number; contextWindowDeclared?: boolean; detectedContextWindow?: number }[] };
  const gpt55 = (json: unknown) => (json as { backends: Row[] }).backends.find((row) => row.id === 'codex')!.models.find((m) => m.slug === 'gpt-5.5')!;
  try {
    const set = await call('PATCH', '/api/backends/manage/codex', { cookie: adminCookie, body: { models: [{ slug: 'gpt-5.5', contextWindow: 272_000 }] } });
    assert.equal(set.status, 200, set.text);
    const listed = await call('GET', '/api/backends/manage', { cookie: adminCookie });
    assert.deepEqual(
      (({ contextWindow, contextWindowDeclared, detectedContextWindow }) => ({ contextWindow, contextWindowDeclared, detectedContextWindow }))(gpt55(listed.json)),
      { contextWindow: 272_000, contextWindowDeclared: true, detectedContextWindow: 400_000 },
    );
    const model = catalogBackend('codex')?.models.find((m) => m.slug === 'gpt-5.5');
    assert.deepEqual([model?.contextWindow, model?.contextWindowDeclared], [272_000, true]);

    assert.equal((await call('PATCH', '/api/backends/manage/codex', { cookie: adminCookie, body: { models: [{ slug: 'gpt-5.5', contextWindow: null }] } })).status, 200);
    const back = catalogBackend('codex')?.models.find((m) => m.slug === 'gpt-5.5');
    assert.deepEqual([back?.contextWindow, back?.contextWindowDeclared], [400_000, undefined]);
  } finally {
    const { db } = await import('../../db.js');
    db.prepare('DELETE FROM backend_overlays WHERE id = ?').run('codex');
  }
});

// ── TODO #571: the contract the `rooks backend` CLI consumes ────────────────

const { issueMissionApiToken } = await import('../../users/api-tokens.js');
const { setLicenseState } = await import('../../license/runtime.js');
const { paidTestLicense } = await import('../../../tests/helpers/paid-license.js');
const { randomUUID } = await import('node:crypto');

const cliForm = { name: 'Cli witness', baseUrl: providerUrl, key: CLI_KEY, protocol: 'openai-responses', models: ['witness-1'] };
const CHANGES: [string, string, unknown][] = [
  ['POST', '/api/backends/custom', cliForm],
  ['POST', '/api/backends/custom/test', { protocol: 'openai-responses', baseUrl: providerUrl, key: CLI_KEY }],
  ['POST', '/api/backends/custom/test', { id: 'local-box' }],
  ['PATCH', '/api/backends/custom/local-box', { name: 'Renamed by an agent' }],
  ['PATCH', '/api/backends/manage/local-box', { disabled: true }],
  ['DELETE', '/api/backends/custom/local-box', undefined],
];

/** Everything an agent's change could have left behind. */
function untouched(before: { files: string; outbound: number }) {
  assert.equal(existsSync(join(HOME, 'backends', 'cli-witness.json')), false);
  assert.equal(readFileSync(join(HOME, 'backends', 'local-box.json'), 'utf8'), before.files);
  assert.equal(dbApi.listSecrets().some((row) => row.name === 'BACKEND_CLI_WITNESS_API_KEY'), false);
  assert.equal(seen.length, before.outbound, 'no outbound call on behalf of an agent');
}

test('an agent cannot add, test, edit or remove a backend, even with a superadmin token (#571)', async () => {
  const admin = dbApi.listUsers().find((user) => user.email === 'admin@example.com')!;
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'admin.agent', 'work', undefined, admin.id);
  const before = { files: readFileSync(join(HOME, 'backends', 'local-box.json'), 'utf8'), outbound: seen.length };
  // A developer account's missions carry its authority (`isSuperadmin`): the
  // strongest token an agent can hold, so the one that must still be refused.
  setLicenseState({ ...paidTestLicense(), planId: 'internal', expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  try {
    const agent = issueMissionApiToken(missionId);
    assert.equal((await call('GET', '/api/backends/custom', { bearer: agent })).status, 200, 'the listing stays readable');
    for (const [method, path, body] of CHANGES) {
      const out = await call(method, path, { bearer: agent, body });
      assert.equal(out.status, 403, `${method} ${path}: ${out.text}`);
      assert.equal((out.json as { code: string }).code, 'operator_only');
      assert.doesNotMatch(out.text, /sk-cli-witness/);
    }
    // The daemon-token inside a mission (before first-run setup, the only
    // credential a mission holds) announces it: the claim is honoured.
    for (const [method, path, body] of CHANGES) {
      const out = await call(method, path, { bearer: TOKEN, body, headers: { 'X-ROOKS-Mission': missionId } });
      assert.equal(out.status, 403, `${method} ${path} (daemon-token claiming a mission): ${out.text}`);
    }
  } finally {
    setLicenseState(paidTestLicense());
  }
  untouched(before);
});

test('a key is accepted in the body only: any query string on a change is refused, and not echoed (#571)', async () => {
  const before = { files: readFileSync(join(HOME, 'backends', 'local-box.json'), 'utf8'), outbound: seen.length };
  for (const [method, path, body] of CHANGES) {
    const out = await call(method, `${path}?key=${CLI_KEY}`, { cookie: adminCookie, body });
    assert.equal(out.status, 400, `${method} ${path}: ${out.text}`);
    assert.equal((out.json as { code: string }).code, 'query-refused');
    assert.doesNotMatch(out.text, /sk-cli-witness/);
  }
  untouched(before);
});

test('the operator\'s terminal (daemon-token, no mission) adds, tests and removes a backend, and the key never comes back (#571)', async () => {
  const lines: string[] = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const level of Object.keys(original) as (keyof typeof original)[]) {
    console[level] = (...args: unknown[]) => { lines.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')); };
  }
  const answers: string[] = [];
  const cli = async (method: string, path: string, body?: unknown) => {
    const out = await call(method, path, { bearer: TOKEN, body });
    answers.push(out.text);
    return out;
  };
  try {
    // Every refusal on the way in: the key sits in the body each time.
    await cli('POST', '/api/backends/custom', { ...cliForm, baseUrl: 'ftp://nowhere' });
    await cli('POST', '/api/backends/custom', { ...cliForm, unknown: CLI_KEY });
    await cli('POST', '/api/backends/custom', { ...cliForm, protocol: 'telnet' });
    await cli('POST', '/api/backends/custom/test', { id: 'cli-witness', key: CLI_KEY });
    await cli('POST', '/api/backends/custom/test', { protocol: 'openai-responses', baseUrl: 'http://127.0.0.1:1/v1', key: CLI_KEY });

    const created = await cli('POST', '/api/backends/custom', cliForm);
    assert.equal(created.status, 201, created.text);
    assert.equal((await cli('POST', '/api/backends/custom', cliForm)).status, 409);
    assert.equal(((await cli('POST', '/api/backends/custom/test', { id: 'cli-witness' })).json as { outcome: string }).outcome, 'ok');
    assert.equal((await cli('PATCH', '/api/backends/custom/cli-witness', { key: `${CLI_KEY}-rotated` })).status, 200);
    assert.equal(((await cli('POST', '/api/backends/custom/test', { id: 'cli-witness' })).json as { outcome: string }).outcome, 'key-refused');
    await cli('GET', '/api/backends/custom');
    await cli('GET', '/api/backends/manage');

    // What a launch is built from: the profile carries the vault NAME, and its
    // argv (codex `model_providers`, the dialect's flags) can only be built
    // from that — the value reaches the child's environment at spawn, nowhere else.
    const file = readFileSync(join(HOME, 'backends', 'cli-witness.json'), 'utf8');
    const profile = activeProfiles().find((p) => p.profile.id === 'cli-witness')!.profile;
    for (const text of [file, JSON.stringify(profile)]) {
      assert.doesNotMatch(text, /sk-cli-witness/);
      assert.match(text, /BACKEND_CLI_WITNESS_API_KEY/);
    }

    assert.equal((await cli('DELETE', '/api/backends/custom/cli-witness')).status, 200);
    assert.equal(isBackendName('cli-witness'), false);
    assert.equal(dbApi.listSecrets().some((row) => row.name === 'BACKEND_CLI_WITNESS_API_KEY'), false, 'its key leaves with it');
  } finally {
    Object.assign(console, original);
  }

  for (const text of answers) assert.doesNotMatch(text, /sk-cli-witness/);
  assert.doesNotMatch(lines.join('\n'), /sk-cli-witness/);
  const audit = dbApi.listAuditLog(500);
  assert.doesNotMatch(JSON.stringify(audit), /sk-cli-witness/);
  // Who added and removed it is on record — by id, never by key.
  for (const action of ['backend.custom.create', 'backend.custom.update', 'backend.custom.delete']) {
    assert.ok(audit.some((row) => row.action === action && row.target === 'cli-witness'), action);
  }
});
