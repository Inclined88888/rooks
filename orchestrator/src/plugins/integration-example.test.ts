import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { test, before, afterEach } from 'node:test';
import { mkdtempSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign, createHmac, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';
import { addPlugin, inventory } from './install.js';
import { hashPluginDirectory } from './signature.js';
import { PluginLoader } from './loader.js';
import { daemonHost } from './context.js';
import { createHttpPlugin } from '../kernel/http-service.js';
import { startIntegrationRuntime } from './integration-runtime.js';
import { integrationRegistries } from './integration-host.js';
import { registerIntegrationWebhook } from './integration-http.js';
import { INTEGRATION_INBOUND_PATH } from './integration-http-path.js';
import { createDaemonAuthMiddleware } from '../plugins-bundled/http/auth.js';
import { issueSessionToken, hashSessionToken, SESSION_COOKIE } from '../users/session.js';
import { dbApi } from '../db.js';
import { createSecret } from '../secrets/store.js';
import { findChannelMission } from '../channel-receipts.js';
import { TimonConfigSchema } from '../config/schema.js';
import { setConfig, resetConfig } from '../config/load.js';
import { parseWorkflowDefinition } from '../workflows/schema.js';
import { armWorkflowTriggers, disarmWorkflowTriggers } from '../workflows/triggers.js';
import { startPluginWorkflowTriggers, refreshPluginWorkflowTriggers } from '../workflows/plugin-triggers.js';
import { cancelRun } from '../workflows/engine.js';
import type { PluginMessagingConnection } from './integration-types.js';

const id = 'webhook-bridge';
const home = mkdtempSync(join(tmpdir(), 'sdk-example-installed-'));
const pluginsDir = join(home, 'plugins');
const configFile = join(home, 'timon.config.json');
const example = fileURLToPath(new URL('../../../examples/plugin-webhook-bridge', import.meta.url));
const keys = generateKeyPairSync('ed25519');
const publicKeys = [{ keyId: 'example-test-key', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
const signing = 'witness-signing-secret-at-least-24-characters';
const callback = 'witness-callback-secret-not-for-inbound';
const permissions = ['connections:read', 'connections:write', 'events:publish', 'missions:spawn', 'missions:read', 'secrets:read'];
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); resetConfig(); });

before(async () => {
  // Real npm, offline, no lifecycle scripts. Sign the exact distributable file set.
  const source = join(home, 'package');
  cpSync(example, source, { recursive: true, filter: (path) => !path.endsWith('tsconfig.json') });
  const hash = hashPluginDirectory(source);
  writeFileSync(join(source, 'SIGNATURE'), JSON.stringify({ alg: 'ed25519', keyId: publicKeys[0]!.keyId, hash, sig: sign(null, Buffer.from(hash, 'hex'), keys.privateKey).toString('base64') }));
  writeFileSync(configFile, '{}');
  const result = await addPlugin(source, pluginsDir, {
    config: configFile, publicKeys,
    npm: async (args, cwd) => {
      assert.ok(args.includes('--ignore-scripts'));
      await promisify(execFile)('npm', [...args, '--offline', '--install-links'], { cwd, env: { ...process.env, npm_config_cache: join(home, 'npm-cache') } });
    },
  });
  assert.equal(result.refused, null); assert.equal(result.signature.ok, true); assert.equal(result.id, id);
  createSecret({ name: 'BRIDGE_SIGNING', value: signing, grants: [`agent:plugin:${id}`] });
  createSecret({ name: 'BRIDGE_CALLBACK', value: callback, grants: [`agent:plugin:${id}`] });
});

async function server(app: express.Express) {
  const s = app.listen(0, '127.0.0.1'); await once(s, 'listening');
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve, reject) => {
    s.close((error) => error ? reject(error) : resolve()); s.closeAllConnections();
  }) };
}
function account() {
  const user = createTestAccount(dbApi, { email: `${randomUUID()}@example.test`, name: 'Bridge user', passwordHash: 'unused' });
  grantTestPermissions(dbApi, user.id, [`plugin:${id}`, ...permissions]);
  const token = issueSessionToken(); dbApi.createSession({ tokenHash: hashSessionToken(token), userId: user.id, expiresAt: Date.now() + 3600_000 });
  return { user, cookie: `${SESSION_COOKIE}=${token}` };
}
async function fixture() {
  setConfig(TimonConfigSchema.parse({ pluginPolicy: { http: { allow: ['127.0.0.1'] } } }));
  const alice = account(); const bob = account();
  const accepted = new Map<string, { room: string; text: string; fragment: number; total: number }>();
  const attempts: string[] = [];
  let mode: 'ok' | 'fail' | 'lost' | 'redirect' | 'hold' = 'ok';
  let output = 'first turn reply';
  let redirects = 0;
  const providerApp = express(); providerApp.use(express.json());
  providerApp.post('/replies', (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${callback}`);
    const key = String(req.headers['idempotency-key']); attempts.push(key);
    if (mode === 'hold') return;
    if (mode === 'fail') { res.status(503).end(); return; }
    if (mode === 'redirect') { res.redirect(307, '/forbidden'); return; }
    if (!accepted.has(key)) accepted.set(key, req.body);
    if (mode === 'lost') { res.destroy(); return; }
    res.status(204).end();
  });
  providerApp.post('/forbidden', (_req, res) => { redirects++; res.status(204).end(); });
  const provider = await server(providerApp); cleanup.push(provider.close);
  let runtime!: ReturnType<typeof startIntegrationRuntime>;
  let loader!: PluginLoader;
  let closeDaemon!: () => Promise<void>;
  let base!: string;
  let enabled = true;
  let spawned = 0;
  const workflows: string[] = [];
  const start = async () => {
    const app = express();
    app.use(createDaemonAuthMiddleware({ token: 'daemon-only-token', required: true }));
    app.use((req, res, next) => {
      if (req.method === 'POST' && INTEGRATION_INBOUND_PATH.test(req.path)) next();
      else express.json({ limit: '256kb' })(req, res, next);
    });
    const root = new Context(); await root.plugin(createHttpPlugin(app));
    runtime = startIntegrationRuntime();
    // Replace only the paid backend boundary. Missions/events and recovery stay real.
    runtime.service.host.spawn = async (connection, receipt, signal) => {
      signal.throwIfAborted();
      const source = { channel: `plugin:${id}`, id: receipt.id };
      const existing = findChannelMission(source, connection.identity.ownerUserId); if (existing) return existing;
      const missionId = randomUUID(); spawned++;
      dbApi.createMission(missionId, connection.agent, JSON.parse(receipt.message).text,
        { channel: source.channel, meta: { channel_receipt_id: receipt.id } }, connection.identity.ownerUserId);
      dbApi.insertEvent(missionId, 'result', { result: output });
      return missionId;
    };
    registerIntegrationWebhook(app, runtime.service);
    const stopWorkflows = startPluginWorkflowTriggers(false);
    loader = new PluginLoader(root, { dir: pluginsDir, host: daemonHost(root), publicKeys, plugins: () => ({ [id]: { enabled, allowLocalHttp: true } }) });
    const [record] = await loader.update(); assert.equal(record?.state, enabled ? 'active' : 'disabled');
    const running = await server(app); base = running.url;
    closeDaemon = async () => { await loader.dispose(); await stopWorkflows(); await runtime.stop(); await root.fiber.dispose(); await running.close(); };
  };
  await start();
  cleanup.push(async () => {
    for (const workflow of workflows) { dbApi.updateWorkflow(workflow, { enabled: 0 }); disarmWorkflowTriggers(workflow); for (const run of dbApi.listWorkflowRuns(workflow)) cancelRun(run.id); }
    await closeDaemon();
  });
  const api = (path: string, body?: unknown, who = alice, method = body === undefined ? 'GET' : 'POST') => fetch(base + `/api/plugins/${id}` + path, {
    method, headers: { cookie: who.cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const created = await api('/connections', { agent: 'witness', config: { room: 'support', replyUrl: provider.url + '/replies' }, secretRefs: { signing: 'BRIDGE_SIGNING', callback: 'BRIDGE_CALLBACK' } });
  assert.equal(created.status, 201, await created.clone().text());
  const { connection, inboundPath } = await created.json() as { connection: PluginMessagingConnection; inboundPath: string };
  return {
    alice, bob, connection, api, accepted, attempts,
    get runtime() { return runtime; }, get spawned() { return spawned; }, get redirects() { return redirects; },
    mode(value: typeof mode) { mode = value; }, output(value: string) { output = value; },
    async restart() { await closeDaemon(); await start(); },
    async enable(value: boolean) { enabled = value; await loader.update(); },
    inbound(body: unknown, options: { stamp?: string; signature?: string; raw?: string } = {}) {
      const raw = options.raw ?? JSON.stringify(body);
      const stamp = options.stamp ?? String(Math.floor(Date.now() / 1000));
      const signature = options.signature ?? createHmac('sha256', signing).update(`${stamp}.`).update(raw).digest('hex');
      return fetch(base + inboundPath, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-timon-timestamp': stamp, 'x-timon-signature': signature } });
    },
    due() { runtime.service.store.db.prepare('UPDATE receipts SET next_at=0').run(); },
    async step() { await runtime.service.processInbox(); await runtime.service.processReply(); },
    workflow(kind: 'event' | 'signal', owner = alice.user.id) {
      const workflow = randomUUID(); const now = Date.now();
      const definition = parseWorkflowDefinition({ schemaVersion: 1, nodes: [
        { id: 'start', type: kind === 'event' ? 'trigger.business' : `trigger.${id}:signal@1`, config: kind === 'event' ? { event: `${id}:message.received@1` } : { topic: 'support' } },
        { id: 'upper', type: `plugin.${id}:uppercase@1`, config: {} }, { id: 'out', type: 'output', config: { template: '{{nodes.upper.output.text}}' } },
      ], edges: [
        { id: 'a', from: 'start', fromPort: 'out', to: 'upper', toPort: 'in' },
        { id: 'b', from: 'upper', fromPort: 'out', to: 'out', toPort: 'in' },
      ], variables: [], settings: {} });
      dbApi.insertWorkflow({ id: workflow, slug: workflow, name: 'Installed witness', description: null, project: null, owner_user_id: owner, draft: JSON.stringify(definition), published_version: null, enabled: 1, created_at: now, updated_at: now , agent_name: null});
      dbApi.insertWorkflowVersion({ workflow_id: workflow, version: 1, definition: JSON.stringify(definition), published_at: now, published_by: owner });
      workflows.push(workflow); armWorkflowTriggers(workflow); return workflow;
    },
  };
}
const message = (event = randomUUID()) => ({ id: event, room: 'support', text: 'hello' });
async function completed(workflow: string) {
  for (let count = 0; count < 200; count++) {
    const runs = dbApi.listWorkflowRuns(workflow);
    if (runs.length && runs.every((run) => ['completed', 'failed'].includes(run.status))) return runs;
    await delay(5);
  }
  assert.fail('workflow did not complete');
}

test('the SDK-only distributable is installed with real offline npm and admitted by its signature', async () => {
  const f = await fixture();
  assert.ok(inventory(pluginsDir, configFile).some((plugin) => plugin.id === id));
  assert.ok(integrationRegistries.transports.get(`${id}:signed-webhook@1`));
  const source = readFileSync(join(pluginsDir, 'node_modules', '@timon-ai/plugin-webhook-bridge/lib/index.js'), 'utf8');
  assert.ok(!source.includes('orchestrator/')); assert.ok(!source.includes('dbApi')); assert.ok(!source.includes('process.env'));
  assert.equal(f.connection.identity.ownerUserId, f.alice.user.id);
  const foreign = await f.api('/connections', undefined, f.bob); assert.deepEqual(await foreign.json(), { connections: [] });
});

test('signed HTTP ingress starts one owned mission and returns its first turn through the installed transport', async () => {
  const f = await fixture();
  const input = { ...message(), reply_url: 'https://attacker.invalid', identity: { ownerUserId: f.bob.user.id } };
  const response = await f.inbound(input); assert.equal(response.status, 202);
  const { receipt_id } = await response.json() as { receipt_id: string };
  await f.step();
  const row = f.runtime.service.store.getReceipt(receipt_id)!; assert.equal(row.stage, 'delivered');
  assert.equal(dbApi.getMission(row.mission_id!)?.owner_user_id, f.alice.user.id);
  assert.equal([...f.accepted.values()][0]?.text, 'first turn reply');
  assert.equal(f.spawned, 1);
  assert.equal((await f.inbound(input)).status, 202); await f.step(); assert.equal(f.spawned, 1); assert.equal(f.accepted.size, 1);
  assert.ok(!JSON.stringify(row).includes(signing)); assert.ok(!JSON.stringify(row).includes(callback));
});

test('invalid signatures, stale timestamps, wrong rooms and unsigned altered bytes never enter the queue', async () => {
  const f = await fixture(); const input = message();
  assert.equal((await f.inbound(input, { signature: '0'.repeat(64) })).status, 401);
  assert.equal((await f.inbound(input, { stamp: String(Math.floor(Date.now() / 1000) - 301) })).status, 401);
  assert.equal((await f.inbound({ ...input, room: 'foreign' })).status, 401);
  const stamp = String(Math.floor(Date.now() / 1000)); const signature = createHmac('sha256', signing).update(`${stamp}.`).update(JSON.stringify(input)).digest('hex');
  assert.equal((await f.inbound(input, { stamp, signature, raw: ' ' + JSON.stringify(input) })).status, 401);
  await f.step(); assert.equal(f.spawned, 0); assert.equal(f.accepted.size, 0);
});

test('a lost HTTP acknowledgement replays the same fragment after restart and preserves Unicode boundaries', async () => {
  const f = await fixture(); f.output('🛰'.repeat(2200) + 'tail'); f.mode('lost');
  const response = await f.inbound(message()); const { receipt_id } = await response.json() as { receipt_id: string };
  await f.step(); assert.equal(f.accepted.size, 1); assert.equal(f.runtime.service.store.getReceipt(receipt_id)?.checkpoint, 'null');
  f.mode('ok'); await f.restart(); f.due(); await f.step(); await f.step();
  assert.equal(f.runtime.service.store.getReceipt(receipt_id)?.stage, 'delivered');
  assert.equal(f.accepted.size, 2); assert.equal(f.spawned, 1);
  assert.equal(f.attempts[0], f.attempts[1]);
  const chunks = [...f.accepted.values()]; assert.equal(Array.from(chunks[0]!.text).length, 2000);
  assert.equal(chunks.map((chunk) => chunk.text).join(''), '🛰'.repeat(2200) + 'tail');
});

test('provider failures and redirects retain the reply for retry without following a new destination', async () => {
  const f = await fixture(); f.mode('redirect');
  const response = await f.inbound(message()); const { receipt_id } = await response.json() as { receipt_id: string };
  await f.step(); assert.equal(f.redirects, 0); assert.equal(f.accepted.size, 0);
  f.mode('fail'); f.due(); await f.step(); assert.equal(f.runtime.service.store.getReceipt(receipt_id)?.stage, 'reply');
  f.mode('ok'); f.due(); await f.step(); assert.equal(f.runtime.service.store.getReceipt(receipt_id)?.stage, 'delivered');
  assert.equal(new Set(f.attempts).size, 1);
});

test('plugin disable removes routes and registrations, retains receipts, and reload resumes delivery', async () => {
  const f = await fixture(); f.mode('fail');
  const response = await f.inbound(message()); const { receipt_id } = await response.json() as { receipt_id: string };
  await f.step(); await f.enable(false);
  assert.equal((await f.api('/connections')).status, 404);
  assert.equal(integrationRegistries.transports.get(`${id}:signed-webhook@1`), undefined);
  assert.equal((await f.inbound(message())).status, 503);
  f.due(); await f.step(); assert.equal(f.accepted.size, 0);
  f.mode('ok'); await f.enable(true); f.due(); await f.step();
  assert.equal(f.runtime.service.store.getReceipt(receipt_id)?.stage, 'delivered'); assert.equal(f.accepted.size, 1);
});

test('the installed business event reaches the installed executor and output only for its authenticated owner', async () => {
  const f = await fixture(); const own = f.workflow('event'); const foreign = f.workflow('event', f.bob.user.id);
  const input = { id: 'business-one', text: 'bonjour' };
  const response = await f.api('/events', input); assert.equal(response.status, 202);
  const runs = await completed(own); assert.equal(runs.length, 1); assert.equal(runs[0]?.status, 'completed');
  assert.equal(JSON.parse(runs[0]!.context).output, 'BONJOUR'); assert.equal(dbApi.listWorkflowRuns(foreign).length, 0);
  const duplicate = await f.api('/events', input); assert.deepEqual(await duplicate.json(), { runs: [] });
});

test('the installed trigger is rearmed after reload and deduplicates authenticated signals', async () => {
  const f = await fixture(); const own = f.workflow('signal'); const foreign = f.workflow('signal', f.bob.user.id);
  await refreshPluginWorkflowTriggers();
  assert.equal((await f.api('/signals', { id: 'signal-one', topic: 'support', text: 'hello' })).status, 202);
  const runs = await completed(own); assert.equal(runs[0]?.status, 'completed'); assert.equal(JSON.parse(runs[0]!.context).output, 'HELLO');
  assert.equal(dbApi.listWorkflowRuns(foreign).length, 0);
  await f.enable(false); await f.enable(true); await refreshPluginWorkflowTriggers();
  await f.api('/signals', { id: 'signal-one', topic: 'support', text: 'hello' }); assert.equal(dbApi.listWorkflowRuns(own).length, 1);
  await f.api('/signals', { id: 'signal-two', topic: 'support', text: 'again' });
  const next = await completed(own); assert.equal(next.length, 2); assert.ok(next.every((run) => run.status === 'completed'));
});


test('unloading an installed transport cancels an in-flight HTTP send and keeps its checkpoint retryable', async () => {
  const f = await fixture(); f.mode('hold');
  const response = await f.inbound(message()); const { receipt_id } = await response.json() as { receipt_id: string };
  await f.runtime.service.processInbox();
  const sending = f.runtime.service.processReply();
  for (let count = 0; count < 200 && !f.attempts.length; count++) await delay(5);
  assert.equal(f.attempts.length, 1);
  await f.enable(false); await sending;
  assert.equal(f.runtime.service.store.getReceipt(receipt_id)?.stage, 'reply');
  assert.equal(f.runtime.service.store.getReceipt(receipt_id)?.checkpoint, 'null');
  f.mode('ok'); await f.enable(true); f.due(); await f.step();
  assert.equal(f.runtime.service.store.getReceipt(receipt_id)?.stage, 'delivered');
  assert.equal(f.attempts[0], f.attempts[1]);
});

test('the example rejects callback credentials, query strings, nonlocal HTTP and foreign connection updates', async () => {
  const f = await fixture();
  for (const replyUrl of ['http://outside.example/replies', 'https://user:password@example.com/replies', 'https://example.com/replies?token=secret', 'https://example.com/replies#fragment']) {
    const response = await f.api('/connections', { agent: 'witness', config: { room: 'support', replyUrl }, secretRefs: { signing: 'BRIDGE_SIGNING', callback: 'BRIDGE_CALLBACK' } });
    assert.equal(response.status, 400);
  }
  const refused = await f.api(`/connections/${f.connection.id}`, { enabled: false }, f.bob, 'PATCH');
  assert.equal(refused.status, 400); assert.equal(f.runtime.service.store.getConnection(f.connection.id)?.enabled, true);
});
