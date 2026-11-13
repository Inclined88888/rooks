import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHmac } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { z } from 'zod';
import { dbApi } from '../db.js';
import { IntegrationStore, IntegrationQueueError, RECEIPT_MAX_ATTEMPTS } from './integration-store.js';
import { IntegrationService, startIntegrationWorker, type IntegrationHost } from './integration-service.js';
import { integrationRegistries, grantIntegrationPermissions, assertIntegrationPermission } from './integration-host.js';
import { PluginIntegrationScope } from './integration-registry.js';
import { currentPluginOwnerUserId, currentPluginViewer } from './als.js';
import { createSecret } from '../secrets/store.js';
import { readPluginSecret } from '../secrets/plugins.js';
import { completedReply } from './integration-replies.js';
import { registerIntegrationWebhook } from './integration-http.js';
import { INTEGRATION_INBOUND_PATH } from './integration-http-path.js';
import { createDaemonAuthMiddleware } from '../plugins-bundled/http/auth.js';
import type { PluginInboundMessage, PluginTransportDefinition, PluginTransportReply } from './integration-types.js';

const pluginId = 'transport-witness';
const ownerId = `plugin:${pluginId}`;
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function user() {
  const id = randomUUID();
  const user = createTestAccount(dbApi, { id, email: `${id}@example.test`, name: id, passwordHash: 'unused' });
  grantTestPermissions(dbApi, id, [`plugin:${pluginId}`, 'missions:spawn', 'missions:read', 'secrets:read', 'connections:write']);
  return { user };
}
const inbound = (externalId: string = randomUUID()): PluginInboundMessage => ({ externalId, text: 'hello', replyContext: { room: 'original' } });
const request = { body: Buffer.from('message'), headers: {} };
async function fixture(overrides: Partial<PluginTransportDefinition> = {}, hostOverrides: Partial<IntegrationHost> = {}, owner = ownerId) {
  const path = join(mkdtempSync(join(tmpdir(), 'integration-queue-')), 'integrations.db');
  let store = new IntegrationStore(path);
  const scope = new PluginIntegrationScope(pluginId);
  cleanup.push(() => store.close(), () => scope.dispose());
  const grants = new Set(['transports:register', 'missions:spawn', 'missions:read', 'secrets:read', 'connections:write']);
  const sends: PluginTransportReply[] = [];
  const missions = new Map<string, string>();
  const host: IntegrationHost = {
    assert: (_plugin, permission) => { assert.ok(grants.has(permission), `Missing ${permission}`); },
    secret: readPluginSecret,
    spawn: async (_connection, receipt) => {
      if (!missions.has(receipt.id)) missions.set(receipt.id, randomUUID());
      return missions.get(receipt.id)!;
    },
    mission: async () => ({ status: 'waiting', events: [{ type: 'result', payload: { result: 'first turn' } }] }),
    ...hostOverrides,
  };
  const definition: PluginTransportDefinition = {
    name: 'chat', version: 1, configSchema: z.object({ destination: z.string().default('original') }),
    receive: () => inbound(), send: (_context, reply) => { sends.push(reply); return { done: true, checkpoint: null }; }, ...overrides,
  };
  const registration = scope.register(integrationRegistries.transports, definition);
  let service = new IntegrationService(store, host);
  cleanup.push(() => service.stop());
  const connection = await service.create(pluginId, owner, { transport: registration.id, agent: 'witness' });
  return {
    get service() { return service; }, get store() { return store; }, path, host, connection, scope, registration, sends, missions, grants,
    reopen() { service.stop(); store.close(); store = new IntegrationStore(path); service = new IntegrationService(store, host); },
    due() { store.db.prepare('UPDATE receipts SET next_at=0').run(); },
  };
}

test('receive persists before acknowledgement and duplicates survive reopening', async () => {
  const f = await fixture({ receive: () => inbound('same') });
  const first = await f.service.receive(f.connection.id, request);
  assert.ok(first); assert.equal(first.stage, 'inbox'); assert.equal(f.missions.size, 0);
  f.reopen();
  assert.equal((await f.service.receive(f.connection.id, request))?.id, first.id);
  await f.service.processInbox();
  const row = f.store.getReceipt(first.id)!;
  assert.equal(row.stage, 'reply'); assert.ok(row.mission_id);
  f.reopen(); await f.service.processReply();
  assert.equal(f.store.getReceipt(first.id)?.stage, 'delivered');
  assert.equal(f.sends[0]?.text, 'first turn');
  assert.equal((await f.service.receive(f.connection.id, request))?.id, first.id);
  assert.equal(await f.service.processInbox(), false); assert.equal(f.missions.size, 1);
});

test('SQLite claims are exclusive across connections and stale workers cannot commit after expiry', async () => {
  const f = await fixture();
  const row = await f.service.receive(f.connection.id, request); assert.ok(row);
  const second = new IntegrationStore(f.path); cleanup.push(() => second.close());
  const now = Date.now();
  const old = f.store.claim('inbox', now)!;
  assert.equal(second.claim('inbox', now + 1), undefined);
  const fresh = second.claim('inbox', old.lease_until)!;
  assert.notEqual(fresh.lease, old.lease);
  assert.equal(f.store.attachMission(old, 'stale', old.lease_until), false);
  assert.equal(second.attachMission(fresh, 'current', old.lease_until), true);
  assert.equal(f.store.getReceipt(row.id)?.mission_id, 'current');
});

test('failure after mission creation retries the receipt with the same durable identity', async () => {
  let first = true;
  const f = await fixture();
  const spawn = f.host.spawn;
  f.host.spawn = async (...args) => { const id = await spawn(...args); if (first) { first = false; throw new Error('lost ack'); } return id; };
  const row = await f.service.receive(f.connection.id, request); assert.ok(row);
  await f.service.processInbox();
  assert.equal(f.store.getReceipt(row.id)?.stage, 'inbox'); assert.equal(f.missions.size, 1);
  f.reopen(); f.due(); await f.service.processInbox();
  assert.equal(f.missions.size, 1); assert.equal(f.store.getReceipt(row.id)?.stage, 'reply');
});

test('reply text and fragment checkpoints survive failed sends and restart', async () => {
  const calls: PluginTransportReply[] = [];
  let fail = false;
  const f = await fixture({ send: (_context, reply) => {
    calls.push(reply);
    if (fail) throw new Error('provider down');
    return { done: reply.checkpoint === 1, checkpoint: 1 };
  } });
  const row = await f.service.receive(f.connection.id, request); assert.ok(row);
  await f.service.processInbox(); await f.service.processReply();
  assert.equal(f.store.getReceipt(row.id)?.checkpoint, '1');
  fail = true; await f.service.processReply();
  assert.equal(f.store.getReceipt(row.id)?.attempts, 1);
  f.host.mission = async () => { throw new Error('must not re-read a frozen reply'); };
  fail = false; f.reopen(); f.due(); await f.service.processReply();
  assert.equal(f.store.getReceipt(row.id)?.stage, 'delivered');
  assert.deepEqual(calls.map((call) => call.checkpoint), [null, 1, 1]);
  assert.equal(new Set(calls.map((call) => call.idempotencyKey)).size, 1);
  assert.deepEqual(calls.map((call) => call.text), ['first turn', 'first turn', 'first turn']);
});

test('pending turns wait, first turn results reply even while the mission stays open', async () => {
  const f = await fixture({}, { mission: async () => ({ status: 'waiting', events: [{ type: 'assistant', payload: { text: 'draft' } }] }) });
  const row = await f.service.receive(f.connection.id, request); assert.ok(row);
  await f.service.processInbox(); await f.service.processReply();
  assert.equal(f.sends.length, 0); assert.equal(f.store.getReceipt(row.id)?.attempts, 0);
  f.host.mission = async () => ({ status: 'waiting', events: [
    { type: 'assistant', payload: { text: 'answer one' } }, { type: 'result', payload: {} },
    { type: 'assistant', payload: { text: 'answer two' } }, { type: 'result', payload: { result: 'second result' } },
  ] });
  f.due(); await f.service.processReply();
  assert.equal(f.sends[0]?.text, 'answer one');
  assert.match(completedReply({ status: 'failed', events: [] })!, /failed/);
});

test('queued messages use the accepted agent, destination and secret references after edits', async () => {
  const f = await fixture();
  const row = await f.service.receive(f.connection.id, request); assert.ok(row);
  const changed = await f.service.update(pluginId, ownerId, f.connection.id, { agent: 'replacement', config: { destination: 'replacement' }, secretRefs: { token: 'NEW_TOKEN' } });
  assert.equal(changed.revision, 2);
  let checked = false;
  f.host.spawn = async (connection) => {
    checked = true; assert.equal(connection.agent, 'witness'); assert.equal(connection.config.destination, 'original');
    assert.deepEqual(connection.secretRefs, {}); return 'mission';
  };
  await f.service.processInbox(); await f.service.processReply();
  assert.equal(checked, true); assert.deepEqual(f.sends[0]?.replyContext, { room: 'original' });
  assert.equal(JSON.parse(f.store.getReceipt(row.id)!.connection).revision, 1);
});

test('connection ownership and transport are immutable; reads are scoped by owner and plugin', async () => {
  const alice = user(); const bob = user();
  const f = await fixture({}, {}, alice.user.id);
  assert.equal(f.service.get(pluginId, bob.user.id, f.connection.id), undefined);
  assert.deepEqual(f.service.list(pluginId, bob.user.id), []);
  await assert.rejects(f.service.update(pluginId, bob.user.id, f.connection.id, { enabled: false }), /not found/);
  await assert.rejects(f.service.update(pluginId, alice.user.id, f.connection.id, { identity: { ownerUserId: bob.user.id } } as never), /immutable/);
  await assert.rejects(f.service.create('other-plugin', 'plugin:other-plugin', { transport: f.registration.id, agent: 'witness' }), /another plugin/);
  await assert.rejects(f.service.create(pluginId, alice.user.id, { transport: f.registration.id, agent: '../witness' }), /Invalid connection agent/);
});

test('owner context is isolated and normalized payload cannot choose mission identity', async () => {
  const alice = user(); const bob = user();
  let seen = false;
  const f = await fixture({ receive: (context) => {
    assert.equal(context.identity.ownerUserId, alice.user.id);
    assert.equal(currentPluginOwnerUserId(pluginId), alice.user.id); assert.equal(currentPluginViewer(pluginId)?.isSuperadmin, false);
    return { ...inbound(), identity: { ownerUserId: bob.user.id } };
  } }, { spawn: async (connection) => {
    seen = true; assert.equal(connection.identity.ownerUserId, alice.user.id); assert.equal(currentPluginOwnerUserId(pluginId), alice.user.id); return 'own-mission';
  } }, alice.user.id);
  const row = await f.service.receive(f.connection.id, request); assert.ok(row);
  assert.equal('identity' in JSON.parse(row.message), false);
  await f.service.processInbox(); assert.equal(seen, true);
  assert.equal(currentPluginOwnerUserId(pluginId), ownerId);
});

test('revoked owner capability pauses queued missions and replies until restored', async () => {
  const alice = user(); const f = await fixture({}, {}, alice.user.id);
  const row = await f.service.receive(f.connection.id, request); assert.ok(row);
  grantTestPermissions(dbApi, alice.user.id, [`plugin:${pluginId}`]);
  await f.service.processInbox(); assert.equal(f.missions.size, 0);
  grantTestPermissions(dbApi, alice.user.id, [`plugin:${pluginId}`, 'missions:spawn']);
  f.due(); await f.service.processInbox(); await f.service.processReply(); assert.equal(f.sends.length, 0);
  grantTestPermissions(dbApi, alice.user.id, [`plugin:${pluginId}`, 'missions:spawn', 'missions:read']);
  f.due(); await f.service.processReply(); assert.equal(f.sends.length, 1);
});

test('revocation while mission data is being read prevents the subsequent send', async () => {
  const alice = user(); const gate = deferred<void>(); const entered = deferred<void>();
  const f = await fixture({}, { mission: async () => { entered.resolve(); await gate.promise; return { status: 'completed', events: [] }; } }, alice.user.id);
  await f.service.receive(f.connection.id, request); await f.service.processInbox();
  const pending = f.service.processReply(); await entered.promise;
  grantTestPermissions(dbApi, alice.user.id, [`plugin:${pluginId}`, 'missions:spawn']); gate.resolve();
  await pending; assert.equal(f.sends.length, 0);
});

test('vault aliases cannot resolve undeclared or foreign secrets and credentials never reach receipts', async () => {
  createSecret({ name: 'OWN_INTEGRATION_TOKEN', value: 'credential-value-witness', grants: [`agent:plugin:${pluginId}`] });
  createSecret({ name: 'FOREIGN_INTEGRATION_TOKEN', value: 'foreign-credential-witness', grants: ['agent:plugin:other-plugin'] });
  const f = await fixture({ receive: async (context) => {
    assert.equal(await context.secret('undeclared'), undefined);
    assert.equal(await context.secret('foreign'), undefined);
    assert.equal(await context.secret('token'), 'credential-value-witness');
    return inbound();
  } });
  await f.service.update(pluginId, ownerId, f.connection.id, { secretRefs: { token: 'OWN_INTEGRATION_TOKEN', foreign: 'FOREIGN_INTEGRATION_TOKEN' } });
  const row = await f.service.receive(f.connection.id, request); assert.ok(row);
  assert.ok(!JSON.stringify(row).includes('credential-value-witness'));
  assert.ok(!readFileSync(f.path).includes(Buffer.from('credential-value-witness')));
  f.grants.delete('secrets:read');
  await assert.rejects(f.service.receive(f.connection.id, request), /authentication failed/);
});

test('resolved secrets embedded in message or checkpoint values and keys are refused', async () => {
  const f = await fixture({ receive: async (context) => ({ ...inbound(), replyContext: { [await context.secret('token') ?? 'missing']: 'value' } }) }, { secret: () => 'resolved-credential' });
  await f.service.update(pluginId, ownerId, f.connection.id, { secretRefs: { token: 'TOKEN' } });
  await assert.rejects(f.service.receive(f.connection.id, request), /credential/);
  assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM receipts').get() as { n: number }).n, 0);
  f.registration.dispose();
  f.scope.register(integrationRegistries.transports, { name: 'chat', version: 1, configSchema: z.object({}), receive: () => inbound(),
    send: async (context) => ({ done: true, checkpoint: await context.secret('token') ?? null }),
  });
  const row = await f.service.receive(f.connection.id, request); assert.ok(row);
  await f.service.processInbox(); await f.service.processReply();
  assert.equal(f.store.getReceipt(row.id)?.checkpoint, 'null'); assert.equal(f.store.getReceipt(row.id)?.stage, 'reply');
});

test('unload cancels in-flight authentication and reload can receive again', async () => {
  const gate = deferred<PluginInboundMessage>(); const entered = deferred<void>();
  let signal!: AbortSignal;
  const f = await fixture({ receive: (context) => { signal = context.signal; entered.resolve(); return gate.promise; } });
  const pending = f.service.receive(f.connection.id, request);
  await entered.promise; f.registration.dispose();
  await assert.rejects(pending, /unloaded/); assert.equal(signal.aborted, true);
  gate.resolve(inbound('late')); await Promise.resolve();
  f.scope.register(integrationRegistries.transports, { name: 'chat', version: 1, configSchema: z.object({}), receive: () => inbound('fresh'), send: () => ({ done: true, checkpoint: null }) });
  assert.ok(await f.service.receive(f.connection.id, request));
  assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM receipts').get() as { n: number }).n, 1);
});

test('disable cancels active callbacks and holds queued receipts until reenabled', async () => {
  const entered = deferred<void>(); const gate = deferred<{ done: boolean; checkpoint: null }>();
  let signal!: AbortSignal;
  const f = await fixture({ send: (context) => { signal = context.signal; entered.resolve(); return gate.promise; } });
  const row = await f.service.receive(f.connection.id, request); assert.ok(row); await f.service.processInbox();
  const pending = f.service.processReply(); await entered.promise;
  await f.service.update(pluginId, ownerId, f.connection.id, { enabled: false }); await pending;
  assert.equal(signal.aborted, true); gate.resolve({ done: true, checkpoint: null });
  assert.equal(f.store.getReceipt(row.id)?.stage, 'reply');
  assert.equal(await f.service.processReply(), false);
  await assert.rejects(f.service.receive(f.connection.id, request), /not found/);
  await f.service.update(pluginId, ownerId, f.connection.id, { enabled: true }); f.due();
  await f.service.processReply(); assert.equal(f.store.getReceipt(row.id)?.stage, 'delivered');
});

test('timeout and runtime shutdown discard late provider results', async () => {
  const late = deferred<PluginInboundMessage>();
  const f = await fixture({ timeoutMs: 5, receive: () => late.promise });
  await assert.rejects(f.service.receive(f.connection.id, request), /timed out/);
  late.resolve(inbound()); await Promise.resolve();
  assert.equal(await f.service.processInbox(), false);
  const stop = startIntegrationWorker(f.service, 5);
  await stop();
  await assert.rejects(f.service.receive(f.connection.id, request), /stopped/);
});

test('receive refuses oversized and malformed payloads and connections changed during authentication', async () => {
  const gate = deferred<PluginInboundMessage>(); const entered = deferred<void>();
  const f = await fixture({ receive: () => { entered.resolve(); return gate.promise; } });
  await assert.rejects(f.service.receive(f.connection.id, { ...request, body: Buffer.alloc(256 * 1024 + 1) }), /too large/);
  const pending = f.service.receive(f.connection.id, request); await entered.promise;
  await f.service.update(pluginId, ownerId, f.connection.id, { config: { destination: 'new' } }); gate.resolve(inbound());
  await assert.rejects(pending, /changed during authentication/);
});

test('durable connection rate budget survives restart without rejecting duplicate receipts', async () => {
  const f = await fixture({ receive: () => inbound('duplicate') });
  const first = await f.service.receive(f.connection.id, request); assert.ok(first);
  for (let i = 1; i < 30; i++) f.store.accept(f.connection, inbound(`budget-${i}`));
  f.reopen();
  assert.equal((await f.service.receive(f.connection.id, request))?.id, first.id);
  assert.throws(() => f.store.accept(f.connection, inbound('31st')), (error: unknown) => error instanceof IntegrationQueueError && error.status === 429);
  const future = Date.now() + 60_001;
  assert.ok(f.store.accept(f.connection, inbound('new-window'), future));
});

test('plugin permission authority belongs to one load generation', () => {
  const revoke = grantIntegrationPermissions(pluginId, ['transports:register']);
  assertIntegrationPermission(pluginId, 'transports:register');
  assert.throws(() => assertIntegrationPermission(pluginId, 'missions:spawn'), /lacks/);
  assert.throws(() => grantIntegrationPermissions(pluginId, []), /already exists/);
  revoke(); const next = grantIntegrationPermissions(pluginId, ['missions:spawn']); cleanup.push(next);
  revoke(); assertIntegrationPermission(pluginId, 'missions:spawn');
});

test('real HTTP ingress authenticates exact bytes before accepting, with bounded bodies and exact auth exemption', async () => {
  const key = 'test-signature-secret';
  const bytes = ' { "externalId" : "signed-1", "text":"hello", "replyContext":null }\n';
  let received = 0;
  const f = await fixture({ receive: (_context, input) => {
    received++;
    const hmac = createHmac('sha256', key).update(input.body).digest('hex');
    if (hmac !== input.headers['x-signature']) throw new Error('invalid signature');
    assert.equal(Buffer.from(input.body).toString(), bytes);
    return JSON.parse(Buffer.from(input.body).toString()) as PluginInboundMessage;
  } });
  const app = express(); app.use(createDaemonAuthMiddleware({ token: 'daemon-test-token', required: true }));
  app.use((req, res, next) => {
    if (req.method === 'POST' && INTEGRATION_INBOUND_PATH.test(req.path)) next();
    else express.json({ limit: '25mb' })(req, res, next);
  });
  registerIntegrationWebhook(app, f.service);
  app.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: 'refused' }); });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const path = `/api/integrations/${f.connection.id}/inbound`;
  const post = (body: string, headers: Record<string, string> = {}) => fetch(base + path, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
  assert.equal((await post(bytes)).status, 401);
  const signed = { 'x-signature': createHmac('sha256', key).update(bytes).digest('hex') };
  const accepted = await post(bytes, signed); assert.equal(accepted.status, 202);
  const receipt = await accepted.json() as { receipt_id: string };
  assert.ok(f.store.getReceipt(receipt.receipt_id)); assert.equal(f.missions.size, 0);
  assert.equal((await post(bytes, signed)).status, 202);
  assert.equal((await post('x'.repeat(256 * 1024 + 1))).status, 413);
  assert.equal((await post(bytes, { ...signed, 'content-encoding': 'gzip' })).status, 415);
  assert.equal(received, 3);
  for (const url of [path, `${path}/extra`, '/api/integrations/not-an-id/inbound']) {
    assert.equal((await fetch(base + url)).status, 401);
  }
  assert.equal((await fetch(base + '/api/integrations/not-an-id/inbound', { method: 'POST' })).status, 401);
});

test('daemon adapter recovers existing missions durably and refuses another owner on read', async () => {
  const { daemonIntegrationHost } = await import('./integration-runtime.js');
  const f = await fixture();
  const receipt = await f.service.receive(f.connection.id, request); assert.ok(receipt);
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'witness', 'hello', { channel: `plugin:${pluginId}`, meta: { channel_receipt_id: receipt.id } }, ownerId);
  const host = daemonIntegrationHost();
  const [one, two] = await Promise.all([
    host.spawn(f.connection, receipt, new AbortController().signal),
    host.spawn(f.connection, receipt, new AbortController().signal),
  ]);
  assert.equal(one, missionId); assert.equal(two, missionId);
  const recovered = await daemonIntegrationHost().spawn(f.connection, receipt, new AbortController().signal);
  assert.equal(recovered, missionId);
  assert.ok(await host.mission(missionId, ownerId));
  assert.equal(await host.mission(missionId, 'plugin:other-plugin'), undefined);
});

test('normalized validation and authenticated ignored messages create no receipt', async () => {
  let mode = 'ignore';
  const f = await fixture({ receive: () => mode === 'ignore' ? null : { externalId: '', text: 'hello', replyContext: null } });
  assert.equal(await f.service.receive(f.connection.id, request), null);
  mode = 'invalid'; await assert.rejects(f.service.receive(f.connection.id, request), /Invalid normalized/);
  assert.equal(await f.service.processInbox(), false);
});

test('simultaneous receive callbacks have bounded capacity and release it after cancellation', async () => {
  const f = await fixture({ receive: () => new Promise(() => {}) });
  const controller = new AbortController();
  const pending = Array.from({ length: 8 }, () => f.service.receive(f.connection.id, request, controller.signal));
  const settled = Promise.allSettled(pending);
  await assert.rejects(f.service.receive(f.connection.id, request), (error: unknown) => error instanceof IntegrationQueueError && error.status === 503);
  controller.abort();
  assert.ok((await settled).every((result) => result.status === 'rejected'));
  f.registration.dispose();
  f.scope.register(integrationRegistries.transports, { name: 'chat', version: 1, configSchema: z.object({}), receive: () => inbound(), send: () => ({ done: true, checkpoint: null }) });
  assert.ok(await f.service.receive(f.connection.id, request));
});

test('the durable global queue cap rejects new receipts but allows duplicate acknowledgement', async () => {
  const f = await fixture();
  const message = inbound('existing');
  const receipt = f.store.accept(f.connection, message);
  const insert = f.store.db.prepare('INSERT INTO receipts(id,connection_id,external_id,connection,message,created_at) VALUES (?,?,?,?,?,?)');
  f.store.db.transaction(() => {
    for (let i = 1; i < 10_000; i++) insert.run(randomUUID(), f.connection.id, `fill-${i}`, JSON.stringify(f.connection), JSON.stringify(inbound()), 0);
  })();
  assert.throws(() => f.store.accept(f.connection, inbound('overflow')), (error: unknown) => error instanceof IntegrationQueueError && error.status === 503);
  assert.equal(f.store.accept(f.connection, message).id, receipt.id);
});

test('runtime stops its worker and store and can start a fresh generation', async () => {
  const { startIntegrationRuntime, integrationService } = await import('./integration-runtime.js');
  assert.throws(integrationService, /unavailable/);
  const first = startIntegrationRuntime();
  assert.equal(integrationService(), first.service);
  assert.throws(startIntegrationRuntime, /already started/);
  await first.stop();
  assert.throws(integrationService, /unavailable/);
  assert.equal(first.service.store.db.open, false);
  const second = startIntegrationRuntime();
  try {
    await first.stop();
    assert.equal(integrationService(), second.service);
  } finally { await second.stop(); }
  assert.equal(second.service.store.db.open, false);
});

function exhaust(f: { store: IntegrationStore }): void {
  f.store.db.prepare('UPDATE receipts SET next_at=0,attempts=?').run(RECEIPT_MAX_ATTEMPTS - 1);
}

test('TODO #631: an inbox failure records why, gives up once and replays without a second mission', async () => {
  const gaveUp: string[] = [];
  let broken = true;
  const f = await fixture({}, {
    spawn: async (_connection, receipt) => {
      if (broken) throw new Error('agent not found');
      return `mission-${receipt.id}`;
    },
    gaveUp: (_connection, receipt) => { gaveUp.push(receipt.id); },
  });
  const row = await f.service.receive(f.connection.id, request); assert.ok(row);
  await f.service.processInbox();
  assert.equal(f.store.getReceipt(row.id)!.last_error, 'agent not found');
  assert.equal(f.store.getReceipt(row.id)!.failed_at, 0);
  assert.deepEqual(gaveUp, []);

  exhaust(f);
  await f.service.processInbox();
  assert.ok(f.store.getReceipt(row.id)!.failed_at > 0);
  assert.deepEqual(gaveUp, [row.id]);
  assert.equal(await f.service.processInbox(), false, 'a failed receipt is not claimed again');

  broken = false;
  assert.equal(f.store.replay(row.id), true);
  await f.service.processInbox();
  const after = f.store.getReceipt(row.id)!;
  assert.equal(after.stage, 'reply');
  assert.equal(after.mission_id, `mission-${row.id}`);
  assert.equal(after.last_error, null);
});

test('TODO #631: a reply failure resumes on the same mission after a replay', async () => {
  let down = true;
  let spawned = 0;
  const f = await fixture({
    send: (_context, reply) => {
      if (down) throw new Error('provider 502');
      f.sends.push(reply);
      return { done: true, checkpoint: null };
    },
  }, { spawn: async () => { spawned++; return 'the-mission'; } });
  const row = await f.service.receive(f.connection.id, request); assert.ok(row);
  await f.service.processInbox();
  exhaust(f);
  await f.service.processReply();
  assert.ok(f.store.getReceipt(row.id)!.failed_at > 0);
  assert.equal(f.store.getReceipt(row.id)!.last_error, 'provider 502');

  down = false;
  assert.equal(f.store.replay(row.id), true);
  await f.service.processReply();
  assert.equal(f.store.getReceipt(row.id)!.stage, 'delivered');
  assert.equal(spawned, 1);
  assert.equal(f.sends[0]!.idempotencyKey, `integration:${row.id}`);
});

test('TODO #631: a failure message echoing a credential read in the call is withheld', async () => {
  const value = 'super-secret-token-value';
  const f = await fixture({
    send: async (context) => { throw new Error(`refused for ${await context.secret('token')}`); },
  }, { secret: () => value });
  await f.service.update(pluginId, ownerId, f.connection.id, { secretRefs: { token: 'WITNESS' } });
  const row = await f.service.receive(f.connection.id, request); assert.ok(row);
  await f.service.processInbox();
  await f.service.processReply();
  const stored = f.store.getReceipt(row.id)!.last_error;
  assert.ok(stored);
  assert.ok(!stored.includes(value), 'the credential never reaches the store');
  assert.match(stored, /withheld/);
});

test('TODO #631: a replay does not bypass a capability lost in the meantime', async () => {
  const f = await fixture();
  const row = await f.service.receive(f.connection.id, request); assert.ok(row);
  f.store.db.prepare('UPDATE receipts SET attempts=?,failed_at=5').run(RECEIPT_MAX_ATTEMPTS);
  f.grants.delete('missions:spawn');
  assert.equal(f.store.replay(row.id), true);
  await f.service.processInbox();
  assert.equal(f.missions.size, 0, 'the worker checks the permission again');
  assert.match(f.store.getReceipt(row.id)!.last_error ?? '', /Missing missions:spawn/);
});
