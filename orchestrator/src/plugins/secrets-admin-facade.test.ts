/**
 * `ctx.secrets` list / set / grant / revoke / httpCall — refusals first: the
 * manifest, the anonymous caller, the account, the job; then the guarantees
 * that keep a plugin from reading a value nobody gave it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-plugin-secrets-admin-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError, PluginCallerError, PluginAdminError } = await import('./context.js');
const { runPluginRequest } = await import('./als.js');
const { dbApi } = await import('../db.js');
const { createSecret } = await import('../secrets/store.js');
const { readPluginSecret } = await import('../secrets/plugins.js');
const { revokeSecret } = await import('../secrets/store.js');
const { TimonConfigSchema } = await import('../config/schema.js');
const { setConfig, resetConfig } = await import('../config/load.js');

const withHttpPolicy = (allow: string[]) => setConfig(TimonConfigSchema.parse({ pluginPolicy: { http: { allow } } }));

type Identity = Parameters<typeof runPluginRequest>[0];
const caller = (id: string, permissions: string[], isSuperadmin = false): Identity => ({
  viewer: { id, isSuperadmin, permissions },
  user: { id, email: `${id}@example.com`, name: id, is_superadmin: isSuperadmin },
  ownerUserId: id,
});
const manager = caller('ada', ['secrets:manage']);
const broker = caller('bea', ['secrets:broker']);
const nobody = caller('bob', []);
const admin = caller('root', [], true);
const anonymous: Identity = { viewer: null, user: undefined, ownerUserId: null };
const as = <T>(who: Identity, fn: () => Promise<T>) => runPluginRequest(who, fn);

async function pluginWith(permissions: string[], id = 'acme-secrets') {
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const res = readManifest({ timon: { id, apiVersion: PLUGIN_API_VERSION, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  const plugin = createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, daemonHost(root));
  return { plugin, dispose: () => root.fiber.dispose() };
}

const code = (c: string) => (err: unknown) => err instanceof PluginAdminError && err.code === c;
const BROKER_SPEC = { type: 'http', hosts: ['api.example.com'], inject: { kind: 'header', name: 'Authorization', template: 'Bearer {{value}}' } };

createSecret({ name: 'HUMAN_TOKEN', value: 'value-held-by-a-human' });
createSecret({ name: 'SHARED_TOKEN', value: 'value-shared-with-all', grants: ['global'] });

test('without the permission in the manifest every call refuses', async () => {
  const { plugin, dispose } = await pluginWith(['storage']);
  await assert.rejects(as(admin, () => plugin.secrets.list()), PluginPermissionError);
  await assert.rejects(as(admin, () => plugin.secrets.set({ name: 'A_B', value: 'x' })), PluginPermissionError);
  await assert.rejects(as(admin, () => plugin.secrets.grant('HUMAN_TOKEN', 'agent:x')), PluginPermissionError);
  await assert.rejects(as(admin, () => plugin.secrets.revoke('HUMAN_TOKEN', 'agent:x')), PluginPermissionError);
  await assert.rejects(as(admin, () => plugin.secrets.httpCall({ identity: 'X', path: '/' })), PluginPermissionError);
  await dispose();
});

test('an anonymous request is refused everywhere', async () => {
  const { plugin, dispose } = await pluginWith(['secrets:list', 'secrets:manage', 'secrets:broker']);
  await assert.rejects(as(anonymous, () => plugin.secrets.list()), PluginCallerError);
  await assert.rejects(as(anonymous, () => plugin.secrets.set({ name: 'ANON_SECRET', value: 'x' })), PluginCallerError);
  await assert.rejects(as(anonymous, () => plugin.secrets.grant('HUMAN_TOKEN', 'agent:x')), PluginCallerError);
  await assert.rejects(as(anonymous, () => plugin.secrets.httpCall({ identity: 'X', path: '/' })), PluginCallerError);
  assert.equal(dbApi.getSecretsByName('ANON_SECRET').length, 0);
  await dispose();
});

test('an account without secrets:manage cannot list or set; a broker-only account cannot list', async () => {
  const { plugin, dispose } = await pluginWith(['secrets:list', 'secrets:manage', 'secrets:broker']);
  await assert.rejects(as(nobody, () => plugin.secrets.list()), PluginCallerError);
  await assert.rejects(as(broker, () => plugin.secrets.list()), PluginCallerError);
  await assert.rejects(as(nobody, () => plugin.secrets.set({ name: 'NOBODY_SECRET', value: 'x' })), PluginCallerError);
  await assert.rejects(as(nobody, () => plugin.secrets.httpCall({ identity: 'X', path: '/' })), PluginCallerError);
  await dispose();
});

test('list names the vault and never carries a value', async () => {
  const { plugin, dispose } = await pluginWith(['secrets:list']);
  const all = await as(manager, () => plugin.secrets.list());
  assert.ok(all.some((s) => s.name === 'HUMAN_TOKEN'));
  const text = JSON.stringify(all);
  assert.ok(!text.includes('value-held-by-a-human'));
  assert.ok(!text.includes('value_enc'));
  await dispose();
});

test('a job lists only what it deposited and what it was granted', async () => {
  const { plugin, dispose } = await pluginWith(['secrets:list', 'secrets:manage'], 'jobby');
  createSecret({ name: 'JOBBY_GRANTED', value: 'v1', grants: ['agent:plugin:jobby'] });
  createSecret({ name: 'OTHER_GRANTED', value: 'v2', grants: ['agent:plugin:another'] });
  const made = await plugin.secrets.set({ name: 'JOBBY_MADE', value: 'v3' });
  const names = (await plugin.secrets.list()).map((s) => s.name);
  assert.ok(names.includes('JOBBY_GRANTED') && names.includes('JOBBY_MADE'));
  assert.ok(!names.includes('HUMAN_TOKEN') && !names.includes('OTHER_GRANTED'));
  assert.equal(made.mine, true);
  await dispose();
});

test('set creates a daemon-only secret, journals it, and never reads it back to the plugin', async () => {
  const { plugin, dispose } = await pluginWith(['secrets:manage', 'secrets:read']);
  const made = await as(manager, () => plugin.secrets.set({ name: 'FRESH_TOKEN', value: 'fresh-value-123456' }));
  assert.deepEqual(made.grants, []);
  assert.equal(made.mine, true);
  assert.equal(await plugin.secrets.get('FRESH_TOKEN'), undefined, 'no grant: the plugin cannot read its own deposit');
  assert.equal(readPluginSecret('acme-secrets', 'FRESH_TOKEN'), undefined);
  const audit = dbApi.listAuditLog(50).find((a) => a.action === 'secret.create' && a.target === `secret:${made.id}`);
  assert.equal(audit?.actor, 'plugin:acme-secrets');
  assert.equal(audit?.user_id, 'ada');
  await dispose();
});

test('set refuses a bad name and a name that exists at several scopes', async () => {
  const { plugin, dispose } = await pluginWith(['secrets:manage']);
  await assert.rejects(as(manager, () => plugin.secrets.set({ name: 'lower', value: 'x' })), code('invalid'));
  createSecret({ name: 'TWICE_TOKEN', value: 'a', grants: ['project:one'] });
  createSecret({ name: 'TWICE_TOKEN', value: 'b', grants: ['project:two'] });
  await assert.rejects(as(admin, () => plugin.secrets.set({ name: 'TWICE_TOKEN', value: 'c' })), code('conflict'));
  await dispose();
});

test('a non-superadmin cannot overwrite a secret the plugin did not create; a superadmin can', async () => {
  const { plugin, dispose } = await pluginWith(['secrets:manage']);
  await assert.rejects(
    as(manager, () => plugin.secrets.set({ name: 'HUMAN_TOKEN', value: 'attacker-value' })),
    code('forbidden'),
  );
  // The plugin's own deposit is rotatable by it.
  await as(manager, () => plugin.secrets.set({ name: 'ROTATING_TOKEN', value: 'first-value' }));
  const row = dbApi.getSecretsByName('ROTATING_TOKEN')[0]!;
  const before = row.value_enc;
  await as(manager, () => plugin.secrets.set({ name: 'ROTATING_TOKEN', value: 'second-value' }));
  assert.notEqual(dbApi.getSecretsByName('ROTATING_TOKEN')[0]!.value_enc, before);
  // A superadmin's request may replace any.
  const replaced = await as(admin, () => plugin.secrets.set({ name: 'HUMAN_TOKEN', value: 'rotated-by-an-admin' }));
  assert.equal(replaced.name, 'HUMAN_TOKEN');
  await dispose();
});

test('a job cannot touch a secret it did not deposit: out of reach it answers as taken, in reach it is refused', async () => {
  const { plugin, dispose } = await pluginWith(['secrets:manage'], 'jobby-two');
  await assert.rejects(plugin.secrets.set({ name: 'HUMAN_TOKEN', value: 'overwrite' }), code('conflict'));
  // `global` does not reach a plugin: a secret shared with every agent is out of reach too.
  await assert.rejects(plugin.secrets.set({ name: 'SHARED_TOKEN', value: 'overwrite' }), code('conflict'));
  createSecret({ name: 'GIVEN_TO_JOB_TOKEN', value: 'given', grants: ['agent:plugin:jobby-two'] });
  await assert.rejects(plugin.secrets.set({ name: 'GIVEN_TO_JOB_TOKEN', value: 'overwrite' }), code('forbidden'));
  await dispose();
});

test('grant and revoke are a superadmin request: a manager, a job and a plain account are refused', async () => {
  const { plugin, dispose } = await pluginWith(['secrets:manage']);
  await assert.rejects(as(manager, () => plugin.secrets.grant('HUMAN_TOKEN', 'agent:helper')), PluginCallerError);
  await assert.rejects(as(manager, () => plugin.secrets.revoke('HUMAN_TOKEN', 'agent:helper')), PluginCallerError);
  await assert.rejects(plugin.secrets.grant('HUMAN_TOKEN', 'agent:helper'), PluginCallerError);
  await assert.rejects(plugin.secrets.revoke('HUMAN_TOKEN', 'agent:helper'), PluginCallerError);
  assert.deepEqual(dbApi.getSecretsByName('HUMAN_TOKEN')[0]!.grants, []);
  await dispose();
});

test('a plugin cannot grant itself, another plugin, or everyone a secret: no road to reading a value it was not given', async () => {
  const { plugin, dispose } = await pluginWith(['secrets:manage', 'secrets:read'], 'greedy');
  await assert.rejects(as(admin, () => plugin.secrets.grant('HUMAN_TOKEN', 'agent:plugin:greedy')), code('forbidden'));
  await assert.rejects(as(admin, () => plugin.secrets.grant('HUMAN_TOKEN', 'agent:plugin:someone-else')), code('forbidden'));
  await assert.rejects(as(admin, () => plugin.secrets.grant('HUMAN_TOKEN', 'global')), code('forbidden'));
  // A backend reservation (TODO #531, 5-B) is the operator's, never a plugin's.
  await assert.rejects(as(admin, () => plugin.secrets.grant('HUMAN_TOKEN', 'backend:acme')), code('forbidden'));
  await assert.rejects(as(admin, () => plugin.secrets.revoke('HUMAN_TOKEN', 'backend:acme')), code('forbidden'));
  await assert.rejects(as(admin, () => plugin.secrets.grant('HUMAN_TOKEN', 'agent:  Plugin:greedy')), code('forbidden'));
  await assert.rejects(as(admin, () => plugin.secrets.grant('HUMAN_TOKEN', 'agent:PLUGIN:greedy')), code('forbidden'));
  assert.equal(await plugin.secrets.get('HUMAN_TOKEN'), undefined);
  assert.deepEqual(dbApi.getSecretsByName('HUMAN_TOKEN')[0]!.grants, []);
  await dispose();
});

test('a superadmin request grants an agent and revokes it; the audit row names the plugin', async () => {
  const { plugin, dispose } = await pluginWith(['secrets:manage'], 'granter');
  createSecret({ name: 'GRANT_ME_TOKEN', value: 'v' });
  const granted = await as(admin, () => plugin.secrets.grant('GRANT_ME_TOKEN', 'agent:helper'));
  assert.deepEqual(granted.grants, ['agent:helper']);
  const revoked = await as(admin, () => plugin.secrets.revoke('GRANT_ME_TOKEN', 'agent:helper'));
  assert.deepEqual(revoked.grants, []);
  const row = dbApi.getSecretsByName('GRANT_ME_TOKEN')[0]!;
  assert.ok(dbApi.listAuditLog(100).some((a) => a.action === 'secret.grant' && a.target === `secret:${row.id}` && a.actor === 'plugin:granter'));
  await assert.rejects(as(admin, () => plugin.secrets.grant('NO_SUCH_TOKEN', 'agent:helper')), code('not_found'));
  await assert.rejects(as(admin, () => plugin.secrets.grant('GRANT_ME_TOKEN', 'not a scope')), code('invalid'));
  await dispose();
});

/** Every call `fetch` receives, with the header the broker injected. */
function recordFetch(respond: () => Response = () => new Response('echo tok-aaaaaaaaaaaaaaaa', { status: 200 })) {
  const realFetch = globalThis.fetch;
  const seen: { url: string; auth: string | null; redirect: RequestRedirect | undefined }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization'), redirect: init?.redirect });
    return respond();
  }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = realFetch; } };
}

test('httpCall acts as plugin:<id> under its grant, masks the value, and refuses without a grant', async () => {
  const { plugin, dispose } = await pluginWith(['secrets:broker', 'http:outbound'], 'caller');
  createSecret({ name: 'MINE_API', value: 'tok-aaaaaaaaaaaaaaaa', mode: 'broker', broker_spec: BROKER_SPEC, grants: ['agent:plugin:caller'] });
  createSecret({ name: 'THEIR_API', value: 'tok-bbbbbbbbbbbbbbbb', mode: 'broker', broker_spec: BROKER_SPEC, grants: ['agent:plugin:other'] });
  createSecret({ name: 'EVERYONE_API', value: 'tok-cccccccccccccccc', mode: 'broker', broker_spec: BROKER_SPEC, grants: ['global'] });
  withHttpPolicy(['api.example.com']);
  const net = recordFetch();
  try {
    const ok = await as(broker, () => plugin.secrets.httpCall({ identity: 'MINE_API', path: '/v1/ping' }));
    assert.equal(ok.status, 200);
    assert.ok(!ok.body.includes('tok-aaaaaaaaaaaaaaaa'), 'the value is masked in the answer');
    assert.equal(net.seen[0]?.auth, 'Bearer tok-aaaaaaaaaaaaaaaa');
    await assert.rejects(as(broker, () => plugin.secrets.httpCall({ identity: 'THEIR_API', path: '/' })), (e) =>
      e instanceof PluginAdminError && e.code === 'forbidden' && e.reason === 'no-grant');
    // A global grant is for agents (1-B): the broker does not answer it for a plugin either.
    await assert.rejects(as(broker, () => plugin.secrets.httpCall({ identity: 'EVERYONE_API', path: '/' })), (e) =>
      e instanceof PluginAdminError && e.code === 'forbidden' && e.reason === 'no-grant');
    await assert.rejects(as(broker, () => plugin.secrets.httpCall({ identity: 'MINE_API', path: '/', host: 'evil.example' })), (e) =>
      e instanceof PluginAdminError && e.code === 'forbidden' && e.reason === 'host-denied');
    await assert.rejects(as(broker, () => plugin.secrets.httpCall({ identity: 'NOPE_API', path: '/' })), code('not_found'));
    assert.equal(net.seen.length, 1, 'refused calls never reach the network');
    // A job is the same plugin.
    assert.equal((await plugin.secrets.httpCall({ identity: 'MINE_API', path: '/again' })).status, 200);
  } finally {
    net.restore();
    resetConfig();
  }
  await dispose();
});

test('httpCall without http:outbound in the manifest is refused before anything is resolved (4-B)', async () => {
  const { plugin, dispose } = await pluginWith(['secrets:broker'], 'no-outbound');
  createSecret({ name: 'NO_OUTBOUND_API', value: 'tok-dddddddddddddddd', mode: 'broker', broker_spec: BROKER_SPEC, grants: ['agent:plugin:no-outbound'] });
  withHttpPolicy(['api.example.com']);
  const net = recordFetch();
  try {
    await assert.rejects(as(broker, () => plugin.secrets.httpCall({ identity: 'NO_OUTBOUND_API', path: '/' })), (e) =>
      e instanceof PluginPermissionError && /http:outbound/.test(e.message));
    await assert.rejects(plugin.secrets.httpCall({ identity: 'NO_OUTBOUND_API', path: '/' }), PluginPermissionError);
    assert.equal(net.seen.length, 0);
    const row = dbApi.getSecretsByName('NO_OUTBOUND_API')[0]!;
    assert.equal(dbApi.listSecretAccess(row.id).filter((a) => a.kind === 'broker').length, 0, 'not even a journalled attempt');
  } finally {
    net.restore();
    resetConfig();
  }
  await dispose();
});

test('a host the identity allows but pluginPolicy.http does not: refused, journalled, zero fetch (4-B)', async () => {
  const { plugin, dispose } = await pluginWith(['secrets:broker', 'http:outbound'], 'fenced');
  const spec = { ...BROKER_SPEC, hosts: ['api.example.com', 'uploads.example.com'] };
  createSecret({ name: 'FENCED_API', value: 'tok-eeeeeeeeeeeeeeee', mode: 'broker', broker_spec: spec, grants: ['agent:plugin:fenced'] });
  const row = dbApi.getSecretsByName('FENCED_API')[0]!;
  const net = recordFetch();
  try {
    // An empty allowlist reaches nothing, brokered or not.
    withHttpPolicy([]);
    await assert.rejects(as(broker, () => plugin.secrets.httpCall({ identity: 'FENCED_API', path: '/' })), (e) =>
      e instanceof PluginAdminError && e.code === 'forbidden' && e.reason === 'policy-denied' && /pluginPolicy\.http\.allow/.test(e.message));
    withHttpPolicy(['api.example.com']);
    await assert.rejects(as(broker, () => plugin.secrets.httpCall({ identity: 'FENCED_API', path: '/', host: 'uploads.example.com' })), (e) =>
      e instanceof PluginAdminError && e.reason === 'policy-denied' && !e.message.includes('tok-eeeeeeeeeeeeeeee'));
    // A job hits the same ceiling.
    await assert.rejects(plugin.secrets.httpCall({ identity: 'FENCED_API', path: '/', host: 'uploads.example.com' }), (e) =>
      e instanceof PluginAdminError && e.reason === 'policy-denied');
    assert.equal(net.seen.length, 0, 'zero fetch');
    const journal = dbApi.listSecretAccess(row.id);
    assert.equal(journal.length, 3);
    assert.ok(journal.every((a) => a.outcome === 'denied' && a.detail?.startsWith('policy:')), 'refused before decryption, said why');
    // Inside the intersection it goes through.
    assert.equal((await as(broker, () => plugin.secrets.httpCall({ identity: 'FENCED_API', path: '/ok' }))).status, 200);
    assert.equal(net.seen.length, 1);
  } finally {
    net.restore();
    resetConfig();
  }
  await dispose();
});

/** TODO #599: the broker obeys the same per-plugin ceiling as `ctx.fetch` — a host opened to A is A's alone. */
test('a host opened to one plugin in pluginPolicy.http.byPlugin is brokered for it, never for another', async () => {
  const a = await pluginWith(['secrets:broker', 'http:outbound'], 'byplugin-a');
  const b = await pluginWith(['secrets:broker', 'http:outbound'], 'byplugin-b');
  createSecret({
    name: 'BYPLUGIN_API', value: 'tok-gggggggggggggggg', mode: 'broker', broker_spec: BROKER_SPEC,
    grants: ['agent:plugin:byplugin-a', 'agent:plugin:byplugin-b'],
  });
  const net = recordFetch();
  try {
    setConfig(TimonConfigSchema.parse({ pluginPolicy: { http: { byPlugin: { 'byplugin-a': ['api.example.com'] } } } }));
    await assert.rejects(as(broker, () => b.plugin.secrets.httpCall({ identity: 'BYPLUGIN_API', path: '/' })), (e) =>
      e instanceof PluginAdminError && e.reason === 'policy-denied');
    await assert.rejects(b.plugin.secrets.httpCall({ identity: 'BYPLUGIN_API', path: '/' }), (e) =>
      e instanceof PluginAdminError && e.reason === 'policy-denied', 'a job of B hits the same ceiling');
    assert.equal(net.seen.length, 0, 'zero fetch for B');
    assert.equal((await as(broker, () => a.plugin.secrets.httpCall({ identity: 'BYPLUGIN_API', path: '/ok' }))).status, 200);
    assert.equal(net.seen.length, 1);
  } finally {
    net.restore();
    resetConfig();
  }
  await a.dispose();
  await b.dispose();
});

test('a revoked broker grant is refused, and a redirect is handed back, never followed (4-B)', async () => {
  const { plugin, dispose } = await pluginWith(['secrets:broker', 'http:outbound'], 'revoked');
  createSecret({ name: 'REVOKED_API', value: 'tok-ffffffffffffffff', mode: 'broker', broker_spec: BROKER_SPEC, grants: ['agent:plugin:revoked'] });
  const row = dbApi.getSecretsByName('REVOKED_API')[0]!;
  withHttpPolicy(['api.example.com', 'evil.example']);
  const net = recordFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }));
  try {
    const moved = await as(broker, () => plugin.secrets.httpCall({ identity: 'REVOKED_API', path: '/moved' }));
    assert.equal(moved.status, 302);
    assert.equal(net.seen.length, 1, 'one request, to the allowed host only');
    assert.equal(net.seen[0]?.url, 'https://api.example.com/moved');
    assert.equal(net.seen[0]?.redirect, 'manual');

    revokeSecret(row.id, 'agent:plugin:revoked');
    await assert.rejects(as(broker, () => plugin.secrets.httpCall({ identity: 'REVOKED_API', path: '/' })), (e) =>
      e instanceof PluginAdminError && e.reason === 'no-grant');
    assert.equal(net.seen.length, 1);
  } finally {
    net.restore();
    resetConfig();
  }
  await dispose();
});
