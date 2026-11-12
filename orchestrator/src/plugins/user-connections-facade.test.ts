import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { createPluginContext, daemonHost, PluginCallerError, PluginPermissionError } from './context.js';
import { readManifest, type PluginPermission } from './manifest.js';
import { integrationRegistries, integrationRequestIdentity } from './integration-host.js';
import { runPluginRequest } from './als.js';
import { PluginPolicyError } from './policy.js';
import { startUserConnections } from './user-connections.js';
import { daemonUserConnectionHost } from './user-connections-host.js';
import { dbApi } from '../db.js';

const pluginId = 'conn-facade';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });

let target: Server;
let base = '';
before(async () => {
  target = createServer((req, res) => {
    if (req.url === '/to-metadata') { res.writeHead(302, { location: 'http://169.254.169.254/' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`hello ${req.headers.authorization ?? ''}`);
  });
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  base = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
});
after(() => { target.close(); });

async function holder(permissions: PluginPermission[]) {
  const root = new Context();
  let ctx!: Context;
  const fiber = await root.plugin({ name: 'holder', apply(inner: Context) { ctx = inner; } });
  cleanup.push(() => root.fiber.dispose());
  const result = readManifest({ rooks: { id: pluginId, apiVersion: 7, permissions } }); assert.ok(result.ok);
  return { plugin: createPluginContext(ctx, { manifest: result.manifest, version: '1.0.0' }, daemonHost(root)), dispose: () => fiber.dispose() };
}
function runtime() {
  const db = new Database(':memory:');
  const started = startUserConnections(db, { ...daemonUserConnectionHost(), approvalPolicy: () => 'admin' });
  cleanup.push(() => { started.stop(); db.close(); });
  return started.service;
}
function account(name: string) {
  const id = randomUUID();
  createTestAccount(dbApi, { id, email: `${name}-${id}@example.test`, name, passwordHash: 'unused', status: 'active' });
  grantTestPermissions(dbApi, id, [`plugin:${pluginId}`]);
  return id;
}
const gateway = { name: 'gateway', version: 1, label: 'Gateway', configSchema: z.object({}), secrets: [{ name: 'apiKey', label: 'Key', required: true }] };

test('a plugin without the permissions cannot declare types, read a user\'s connections or fetch', async () => {
  runtime();
  const { plugin } = await holder([]);
  assert.throws(() => plugin.connections.registerType(gateway), PluginPermissionError);
  await assert.rejects(plugin.connections.forUser(account('nobody')), PluginPermissionError);
  await assert.rejects(plugin.connections.userSecret('u', 'c', 'apiKey'), PluginPermissionError);
  assert.equal(plugin.fetch, undefined);
  assert.equal(integrationRegistries.connectionTypes.get(`${pluginId}:gateway@1`), undefined);
});

test('the plugin reads one account\'s connection and secret; a request only reads its own caller', async () => {
  const service = runtime();
  const { plugin, dispose } = await holder(['connections:register', 'connections:users:read', 'storage']);
  plugin.connections.registerType(gateway);
  const alice = account('alice'); const bob = account('bob');
  const created = await service.create({ userId: alice, isAdmin: true }, {
    type: `${pluginId}:gateway@1`, label: 'A', url: `${base}/v1`, allowPrivateNetwork: true, secrets: { apiKey: 'sk-alice' },
  });
  const [own] = await plugin.connections.forUser(alice);
  assert.equal(own?.id, created.id); assert.deepEqual(own?.secrets, ['apiKey']);
  assert.equal(JSON.stringify(own).includes('sk-alice'), false);
  assert.equal(await plugin.connections.userSecret(alice, created.id, 'apiKey'), 'sk-alice');
  assert.equal(await plugin.connections.userSecret(bob, created.id, 'apiKey'), undefined);
  assert.deepEqual(await plugin.connections.forUser(bob), []);
  // Inside Bob's request, Alice's connections are not his to read.
  await runPluginRequest(integrationRequestIdentity(pluginId, bob), async () => {
    await assert.rejects(plugin.connections.forUser(alice), PluginCallerError);
    await assert.rejects(plugin.connections.userSecret(alice, created.id, 'apiKey'), PluginCallerError);
    assert.deepEqual(await plugin.connections.forUser(bob), []);
  });
  // Free storage cannot read or forge the sealed rows.
  await assert.rejects(plugin.storage.kv.get(`@connections/${created.id}/apiKey`), /reserved/);
  assert.equal((await plugin.storage.kv.list()).some((row) => row.key.startsWith('@connections/')), false);
  await dispose();
  assert.equal(integrationRegistries.connectionTypes.get(`${pluginId}:gateway@1`), undefined);
});

test('ctx.fetch reaches an approved origin, not a pending one, and never metadata', async () => {
  const service = runtime();
  const { plugin } = await holder(['connections:register', 'http:outbound']);
  plugin.connections.registerType(gateway);
  const alice = account('carol');
  await assert.rejects(plugin.fetch!(`${base}/v1`), PluginPolicyError);
  const pending = await service.create({ userId: alice, isAdmin: false }, {
    type: `${pluginId}:gateway@1`, label: 'A', url: `${base}/v1`, allowPrivateNetwork: true, secrets: { apiKey: 'k' },
  });
  await assert.rejects(plugin.fetch!(`${base}/v1`), PluginPolicyError);
  service.decide({ userId: 'admin', isAdmin: true }, pending.id, 'approved');
  const response = await plugin.fetch!(`${base}/v1/health`, { headers: { authorization: 'Bearer k' } });
  assert.equal(await response.text(), 'hello Bearer k');
  await assert.rejects(plugin.fetch!(`${base}/to-metadata`), /never reachable|neither an approved/);
  await assert.rejects(plugin.fetch!('http://169.254.169.254/latest/meta-data/'), PluginPolicyError);
  await assert.rejects(plugin.fetch!('http://example.com/'), PluginPolicyError);
});
