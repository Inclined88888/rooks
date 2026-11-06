import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { createPluginContext, daemonHost, PluginPermissionError, PluginCallerError } from './context.js';
import { readManifest, PLUGIN_API_VERSION, type PluginPermission } from './manifest.js';
import { startIntegrationRuntime } from './integration-runtime.js';
import { integrationRegistries, integrationRequestIdentity, assertIntegrationPermission } from './integration-host.js';
import { currentPluginOwnerUserId, runPluginRequest } from './als.js';
import { dbApi } from '../db.js';
import { startPluginWorkflowTriggers } from '../workflows/plugin-triggers.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });
const all: PluginPermission[] = ['events:register', 'events:publish', 'workflows:triggers:register', 'workflows:executors:register', 'transports:register', 'connections:read', 'connections:write'];
const event = { name: 'changed', version: 1, payloadSchema: z.object({ text: z.string() }) };
const transport = { name: 'chat', version: 1, configSchema: z.object({}), receive: () => null, send: () => ({ done: true, checkpoint: null }) };
async function holder(permissions: PluginPermission[] = all, id = 'facade-witness') {
  const root = new Context();
  let ctx!: Context;
  const fiber = await root.plugin({ name: 'holder', apply(inner: Context) { ctx = inner; } });
  cleanup.push(() => root.fiber.dispose());
  const result = readManifest({ timon: { id, apiVersion: 3, permissions } }); assert.ok(result.ok);
  const plugin = createPluginContext(ctx, { manifest: result.manifest, version: '1.0.0' }, daemonHost(root));
  return { plugin, root, dispose: () => fiber.dispose(), ctx };
}
function runtime() { const runtime = startIntegrationRuntime(); cleanup.push(runtime.stop); return runtime; }
function owner(permissions: string[]) {
  const id = randomUUID();
  const user = createTestAccount(dbApi, { id, email: `${id}@example.test`, name: id, passwordHash: 'unused' });
  grantTestPermissions(dbApi, id, ['plugin:facade-witness', ...permissions]);
  return { user };
}
function asUser<T>(id: string, work: () => T) { return runPluginRequest(integrationRequestIdentity('facade-witness', id), work); }

test('the current API preserves integrations and accepts previous manifest versions', async () => {
  assert.ok(PLUGIN_API_VERSION >= 3);
  for (const apiVersion of [1, 2, 3]) assert.ok(readManifest({ timon: { id: 'old-plugin', apiVersion } }).ok);
  const future = readManifest({ timon: { id: 'future-plugin', apiVersion: PLUGIN_API_VERSION + 1 } });
  assert.ok(!future.ok); assert.equal(future.code, 'api-version');
  const { plugin } = await holder([]);
  for (const permission of all) assert.equal(plugin.can(permission), false);
  assert.equal(typeof plugin.events.on, 'function'); assert.equal('publish' in plugin.events, false);
  assert.equal(typeof plugin.businessEvents.publish, 'function');
});

test('each integration facade refuses missing manifest permissions before calling its host', async () => {
  const { plugin } = await holder([]);
  assert.throws(() => plugin.businessEvents.register(event), PluginPermissionError);
  await assert.rejects(plugin.businessEvents.publish('facade-witness:changed@1', { id: 'one', payload: {} }), PluginPermissionError);
  assert.throws(() => plugin.workflows.registerTrigger({ name: 'watch', version: 1, configSchema: z.object({}), start: () => () => {} }), PluginPermissionError);
  assert.throws(() => plugin.workflows.registerExecutor({ name: 'lookup', version: 1, configSchema: z.object({}), outputPorts: ['out'], execute: () => ({ output: null, port: 'out' }) }), PluginPermissionError);
  assert.throws(() => plugin.transports.register(transport), PluginPermissionError);
  await assert.rejects(plugin.connections.create({ transport: 'facade-witness:chat@1', agent: 'witness' }), PluginPermissionError);
  await assert.rejects(plugin.connections.get('id'), PluginPermissionError);
  await assert.rejects(plugin.connections.list(), PluginPermissionError);
  await assert.rejects(plugin.connections.update('id', { enabled: false }), PluginPermissionError);
  await assert.rejects(plugin.connections.inboundPath('id'), PluginPermissionError);
  assert.equal(integrationRegistries.events.get('facade-witness:changed@1'), undefined);
});

test('registrations and transport authority are removed by Cordis; stale facades and disposers cannot alter reloads', async () => {
  const first = await holder();
  const remove = first.plugin.businessEvents.register(event);
  first.plugin.workflows.registerTrigger({ name: 'watch', version: 1, configSchema: z.object({}), start: () => () => {} });
  first.plugin.workflows.registerExecutor({ name: 'lookup', version: 1, configSchema: z.object({}), outputPorts: ['out'], execute: () => ({ output: null, port: 'out' }) });
  first.plugin.transports.register(transport);
  assertIntegrationPermission('facade-witness', 'transports:register');
  await first.dispose();
  assert.equal(integrationRegistries.events.list().length, 0);
  assert.equal(integrationRegistries.triggers.list().length, 0);
  assert.equal(integrationRegistries.executors.list().length, 0);
  assert.equal(integrationRegistries.transports.list().length, 0);
  assert.throws(() => assertIntegrationPermission('facade-witness', 'transports:register'), /lacks/);
  const second = await holder(); second.plugin.businessEvents.register(event);
  remove(); assert.ok(integrationRegistries.events.get('facade-witness:changed@1'));
  assert.throws(() => first.plugin.businessEvents.register(event), /unloaded/);
  await assert.rejects(first.plugin.connections.list(), /unloaded/);
});

test('connections carry the job identity, expose the daemon path, and survive plugin unload', async () => {
  const rt = runtime(); const { plugin, dispose } = await holder();
  plugin.transports.register(transport);
  const connection = await plugin.connections.create({ transport: 'facade-witness:chat@1', agent: 'witness' });
  assert.equal(connection.identity.ownerUserId, 'plugin:facade-witness');
  assert.equal(await plugin.connections.inboundPath(connection.id), `/api/integrations/${connection.id}/inbound`);
  assert.equal((await plugin.connections.list()).length, 1);
  const updated = await plugin.connections.update(connection.id, { enabled: false }); assert.equal(updated.enabled, false);
  await dispose(); assert.equal(rt.service.store.getConnection(connection.id)?.enabled, false);
  await assert.rejects(plugin.connections.create({ transport: 'facade-witness:chat@1', agent: 'witness' }), /unloaded/);
});

test('connection facades enforce caller permissions and ownership, even with forged input fields', async () => {
  runtime(); const { plugin } = await holder(); plugin.transports.register(transport);
  const alice = owner(['connections:read', 'connections:write']); const bob = owner(['connections:read']);
  const connection = await asUser(alice.user.id, () => plugin.connections.create({ transport: 'facade-witness:chat@1', agent: 'witness' }));
  assert.equal(connection.identity.ownerUserId, alice.user.id);
  assert.equal(await asUser(bob.user.id, () => plugin.connections.get(connection.id)), undefined);
  await assert.rejects(asUser(bob.user.id, () => plugin.connections.update(connection.id, { enabled: false })), PluginCallerError);
  await assert.rejects(asUser(bob.user.id, () => plugin.connections.inboundPath(connection.id)), /not found/);
  await assert.rejects(asUser(alice.user.id, () => plugin.connections.create({ transport: 'facade-witness:chat@1', agent: 'witness', identity: { ownerUserId: bob.user.id } } as never)), /Unknown connection field/);
  grantTestPermissions(dbApi, alice.user.id, ['plugin:facade-witness']);
  await assert.rejects(asUser(alice.user.id, () => plugin.connections.list()), PluginCallerError);
});

test('business event facade publishes only registered types and connections of the current owner', async () => {
  runtime(); cleanup.push(startPluginWorkflowTriggers(false));
  const { plugin } = await holder(); plugin.businessEvents.register(event); plugin.transports.register(transport);
  const alice = owner(['events:publish', 'connections:write']); const bob = owner(['events:publish']);
  const connection = await asUser(alice.user.id, () => plugin.connections.create({ transport: 'facade-witness:chat@1', agent: 'witness' }));
  assert.deepEqual(await asUser(alice.user.id, () => plugin.businessEvents.publish('facade-witness:changed@1', { id: 'one', payload: { text: 'ok' } }, { connectionId: connection.id })), []);
  await assert.rejects(asUser(bob.user.id, () => plugin.businessEvents.publish('facade-witness:changed@1', { id: 'two', payload: { text: 'denied' } }, { connectionId: connection.id })), /Connection unavailable/);
  await assert.rejects(plugin.businessEvents.publish('other-plugin:changed@1', { id: 'three', payload: {} }), /another plugin/);
  await assert.rejects(plugin.businessEvents.publish('facade-witness:changed@1', { id: 'four', payload: {} }));
});

test('event publication rechecks caller rights after asynchronous validation', async () => {
  cleanup.push(startPluginWorkflowTriggers(false));
  const { plugin } = await holder();
  const alice = owner(['events:publish']);
  plugin.businessEvents.register({ name: 'revoked', version: 1, payloadSchema: { parse(value) {
    assert.equal(currentPluginOwnerUserId(plugin.id), alice.user.id);
    grantTestPermissions(dbApi, alice.user.id, ['plugin:facade-witness']);
    return z.json().parse(value);
  } } });
  await assert.rejects(asUser(alice.user.id, () => plugin.businessEvents.publish('facade-witness:revoked@1', { id: 'one', payload: {} })), /events:publish/);
});

test('an anonymous first-run request cannot mint an integration owner', async () => {
  runtime(); const { plugin } = await holder(); plugin.transports.register(transport);
  await assert.rejects(runPluginRequest({ ownerUserId: null, user: undefined, viewer: null }, () => plugin.connections.create({ transport: 'facade-witness:chat@1', agent: 'witness' })), /authenticated owner/);
});

test('legacy hosts can construct contexts and report unavailable integrations explicitly', async () => {
  const { root, ctx } = await holder([]);
  const manifest = readManifest({ timon: { id: 'legacy-host', apiVersion: 3, permissions: ['events:register'] } }); assert.ok(manifest.ok);
  const host = daemonHost(root); delete host.integrations;
  const plugin = createPluginContext(ctx, { manifest: manifest.manifest, version: '1.0.0' }, host);
  assert.throws(() => plugin.businessEvents.register(event), /host unavailable/);
});
