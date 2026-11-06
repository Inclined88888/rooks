/**
 * `ctx.connections.receipts()` (TODO #679): a plugin reads the follow-up of its
 * own messaging connections, never anyone else's, and never what the receipt
 * routes keep out of sight either.
 */
import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { createPluginContext, daemonHost, PluginPermissionError, PluginCallerError } from './context.js';
import { readManifest, type PluginPermission } from './manifest.js';
import { startIntegrationRuntime } from './integration-runtime.js';
import { integrationRequestIdentity } from './integration-host.js';
import { runPluginRequest } from './als.js';
import { setRedactionSource } from '../secrets/redact.js';
import { dbApi } from '../db.js';
import type { IntegrationStore } from './integration-store.js';
import type { PluginMessagingConnection } from './integration-types.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });

const PLUGIN = 'receipts-witness';
const all: PluginPermission[] = ['transports:register', 'connections:read', 'connections:write'];
const transport = {
  name: 'chat', version: 1, configSchema: z.object({ endpoint: z.string() }),
  receive: () => null, send: () => ({ done: true, checkpoint: null }),
};
/** Every value a receipt row or its connection holds and the facade must not return. */
const HIDDEN = ['config-witness', 'secret-ref-witness', 'reply-context-witness', 'reply-text-witness', 'checkpoint-witness', 'lease-witness', 'tail-of-the-message'];
const RECEIPT_KEYS = ['attempts', 'createdAt', 'externalId', 'failedAt', 'id', 'lastError', 'missionId', 'nextAt', 'preview', 'stage', 'status'];

async function holder(permissions: PluginPermission[] = all, id = PLUGIN) {
  const root = new Context();
  let ctx!: Context;
  const fiber = await root.plugin({ name: 'holder', apply(inner: Context) { ctx = inner; } });
  cleanup.push(() => root.fiber.dispose());
  const result = readManifest({ timon: { id, apiVersion: 14, permissions } }); assert.ok(result.ok);
  const plugin = createPluginContext(ctx, { manifest: result.manifest, version: '1.0.0' }, daemonHost(root));
  return { plugin, dispose: () => fiber.dispose() };
}
function runtime() { const rt = startIntegrationRuntime(); cleanup.push(rt.stop); return rt; }
function owner(permissions: string[], superadmin = false) {
  const id = randomUUID();
  const user = createTestAccount(dbApi, { id, email: `${id}@example.test`, name: id, passwordHash: 'unused', isSuperadmin: superadmin, status: 'active' });
  grantTestPermissions(dbApi, id, [`plugin:${PLUGIN}`, ...permissions]);
  return { user };
}
function asUser<T>(id: string, work: () => T) { return runPluginRequest(integrationRequestIdentity(PLUGIN, id), work); }
/** A superadmin signed in on the web: the widest caller identity a request can carry. */
function asSuperadmin<T>(id: string, work: () => T) {
  return runPluginRequest({
    ownerUserId: id, user: { id, email: `${id}@example.test`, name: id, is_superadmin: true },
    viewer: { id, isSuperadmin: true, permissions: [] },
  }, work);
}

type Kind = 'queued' | 'retrying' | 'failed' | 'delivered';
/** Writes the row directly, parked in the future so the live worker leaves it alone. */
function receipt(store: IntegrationStore, connection: PluginMessagingConnection, kind: Kind, text = 'hello there', at = Date.now()): string {
  const id = randomUUID();
  store.db.prepare(`INSERT INTO receipts(id,connection_id,external_id,connection,message,stage,mission_id,reply_text,checkpoint,
      attempts,next_at,lease,lease_until,created_at,failed_at,last_error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, connection.id, `ext-${id}`, JSON.stringify(connection),
      JSON.stringify({ externalId: `ext-${id}`, text, replyContext: { room: 'reply-context-witness' } }),
      kind === 'delivered' ? 'delivered' : 'reply', 'mission-1', 'reply-text-witness', '{"part":"checkpoint-witness"}',
      kind === 'retrying' || kind === 'failed' ? 3 : 0, Date.now() + 3_600_000, 'lease-witness', 0, at,
      kind === 'failed' ? at : 0, kind === 'queued' || kind === 'delivered' ? null : 'provider 502');
  return id;
}
async function connected() {
  const rt = runtime(); const { plugin, dispose } = await holder(); plugin.transports.register(transport);
  const alice = owner(['connections:read', 'connections:write']);
  const connection = await asUser(alice.user.id, () => plugin.connections.create({
    transport: `${PLUGIN}:chat@1`, agent: 'witness', config: { endpoint: 'config-witness' }, secretRefs: { token: 'secret-ref-witness' },
  }));
  return { store: rt.service.store, plugin, dispose, alice, connection };
}

test('the owner reads counts and the receipts in trouble, failed first, without any internal field', async () => {
  const { store, plugin, alice, connection } = await connected();
  receipt(store, connection, 'queued');
  const retrying = receipt(store, connection, 'retrying', 'retry me', Date.now() + 10);
  const failed = receipt(store, connection, 'failed', 'x'.repeat(200) + 'tail-of-the-message');
  receipt(store, connection, 'delivered');
  const result = await asUser(alice.user.id, () => plugin.connections.receipts(connection.id));
  assert.deepEqual(Object.keys(result).sort(), ['counts', 'receipts']);
  assert.deepEqual(result.counts, { queued: 1, retrying: 1, failed: 1 });
  assert.deepEqual(result.receipts.map((r) => [r.id, r.status, r.stage]), [[failed, 'failed', 'reply'], [retrying, 'retrying', 'reply']]);
  for (const row of result.receipts) assert.deepEqual(Object.keys(row).sort(), RECEIPT_KEYS);
  assert.equal(result.receipts[0]!.preview, 'x'.repeat(200));
  assert.equal(result.receipts[0]!.nextAt, null);
  assert.equal(result.receipts[1]!.failedAt, null);
  assert.equal(result.receipts[1]!.lastError, 'provider 502');
  const text = JSON.stringify(result);
  for (const hidden of HIDDEN) assert.ok(!text.includes(hidden), hidden);
  assert.deepEqual((await asUser(alice.user.id, () => plugin.connections.receipts(connection.id, { status: 'retrying' }))).receipts.map((r) => r.id), [retrying]);
  assert.deepEqual((await asUser(alice.user.id, () => plugin.connections.receipts(connection.id, { status: 'failed' }))).receipts.map((r) => r.id), [failed]);
});

test('preview and provider id are masked against the vault values', async () => {
  const { store, plugin, alice, connection } = await connected();
  const previous = setRedactionSource(() => ['vault-value-0123456789']);
  cleanup.push(() => { setRedactionSource(previous); });
  const id = receipt(store, connection, 'failed', 'my key is vault-value-0123456789, keep it');
  store.db.prepare('UPDATE receipts SET external_id=? WHERE id=?').run('ext-vault-value-0123456789', id);
  const [row] = (await asUser(alice.user.id, () => plugin.connections.receipts(connection.id))).receipts;
  assert.equal(row!.preview, 'my key is ***, keep it');
  assert.equal(row!.externalId, 'ext-***');
});

test('a failure reason is masked against a value added to the vault after the failure', async () => {
  const { store, plugin, alice, connection } = await connected();
  const previous = setRedactionSource(() => []);
  cleanup.push(() => { setRedactionSource(previous); });
  const failed = receipt(store, connection, 'failed');
  store.db.prepare('UPDATE receipts SET last_error=? WHERE id=?').run('refused for vault-value-0123456789 at once', failed);
  const retrying = receipt(store, connection, 'retrying');
  store.db.prepare('UPDATE receipts SET last_error=NULL WHERE id=?').run(retrying);
  const read = async () => (await asUser(alice.user.id, () => plugin.connections.receipts(connection.id))).receipts;
  assert.equal((await read())[0]!.lastError, 'refused for vault-value-0123456789 at once');

  setRedactionSource(() => ['vault-value-0123456789']);
  const rows = await read();
  assert.equal(rows[0]!.lastError, 'refused for *** at once');
  assert.equal(rows[1]!.lastError, null, 'no failure stays no failure');
  assert.ok(!JSON.stringify(rows).includes('vault-value-0123456789'));
  assert.match(store.getReceipt(failed)!.last_error ?? '', /vault-value-0123456789/, 'the mask is applied on read, not by rewriting the row');
});

test('the list is bounded: 50 by default, 200 at most, counts stay exact', async () => {
  const { store, plugin, alice, connection } = await connected();
  const insert = store.db.transaction(() => { for (let i = 0; i < 205; i += 1) receipt(store, connection, 'failed', `n${i}`, Date.now() - i); });
  insert();
  const read = (options?: { limit?: number }) => asUser(alice.user.id, () => plugin.connections.receipts(connection.id, options));
  assert.equal((await read()).receipts.length, 50);
  assert.equal((await read({ limit: 200 })).receipts.length, 200);
  assert.equal((await read({ limit: 1 })).receipts.length, 1);
  assert.equal((await read()).counts.failed, 205);
});

test('corrupt messages expose no raw payload and leave the receipt readable', async () => {
  const { store, plugin, alice, connection } = await connected();
  for (const message of ['invalid-json-reply-context-witness', 'null', '{"text":{"token":"secret-ref-witness"}}']) {
    const id = receipt(store, connection, 'failed');
    store.db.prepare('UPDATE receipts SET message=? WHERE id=?').run(message, id);
  }
  const result = await asUser(alice.user.id, () => plugin.connections.receipts(connection.id));
  assert.equal(result.receipts.length, 3);
  for (const row of result.receipts) {
    assert.equal(row.preview, '');
    assert.deepEqual(Object.keys(row).sort(), RECEIPT_KEYS);
  }
  for (const hidden of HIDDEN) assert.ok(!JSON.stringify(result).includes(hidden), hidden);
});

test('invalid options are refused before anything is read', async () => {
  const { plugin, alice, connection } = await connected();
  for (const options of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { limit: '5' }, { status: 'delivered' }, { status: 'queued' }, { owner: alice.user.id }, null, 'failed']) {
    await assert.rejects(asUser(alice.user.id, () => plugin.connections.receipts(connection.id, options as never)), /Invalid receipt options/, JSON.stringify(options));
  }
  await assert.rejects(asUser(alice.user.id, () => plugin.connections.receipts(42 as never)), /Connection not found/);
});

test('without connections:read in the manifest, the facade refuses before its host', async () => {
  runtime();
  const { plugin } = await holder(['transports:register']);
  await assert.rejects(plugin.connections.receipts(randomUUID()), PluginPermissionError);
});

test('a caller without connections:read, or whose right was revoked, is refused', async () => {
  const { plugin, alice, connection } = await connected();
  const bob = owner([]);
  await assert.rejects(asUser(bob.user.id, () => plugin.connections.receipts(connection.id)), PluginCallerError);
  const identity = integrationRequestIdentity(PLUGIN, alice.user.id);
  grantTestPermissions(dbApi, alice.user.id, [`plugin:${PLUGIN}`]);
  await assert.rejects(asUser(alice.user.id, () => plugin.connections.receipts(connection.id)), PluginCallerError);
  await assert.rejects(runPluginRequest(identity, () => plugin.connections.receipts(connection.id)), /Owner lacks connections:read/);
});

test('another account, even a signed-in superadmin, reads it as not found', async () => {
  const { store, plugin, connection } = await connected();
  receipt(store, connection, 'failed');
  const bob = owner(['connections:read']);
  await assert.rejects(asUser(bob.user.id, () => plugin.connections.receipts(connection.id)), /Connection not found/);
  const admin = owner(['connections:read'], true);
  await assert.rejects(asSuperadmin(admin.user.id, () => plugin.connections.receipts(connection.id)), /Connection not found/);
  await assert.rejects(asUser(bob.user.id, () => plugin.connections.receipts(randomUUID())), /Connection not found/);
});

test('an anonymous or daemon-token request names no owner', async () => {
  const { plugin, connection } = await connected();
  await assert.rejects(runPluginRequest({ ownerUserId: null, user: undefined, viewer: null }, () => plugin.connections.receipts(connection.id)), /authenticated owner/);
});

test('a job reads only the plugin\'s own connections, never an account\'s', async () => {
  const { store, plugin, connection } = await connected();
  receipt(store, connection, 'failed');
  await assert.rejects(plugin.connections.receipts(connection.id), /Connection not found/);
  const own = await plugin.connections.create({ transport: `${PLUGIN}:chat@1`, agent: 'witness', config: { endpoint: 'job' } });
  receipt(store, own, 'retrying');
  assert.deepEqual((await plugin.connections.receipts(own.id)).counts, { queued: 0, retrying: 1, failed: 0 });
});

test('another plugin cannot read the connection, as a job or for the same account', async () => {
  const { store, alice, connection } = await connected();
  receipt(store, connection, 'failed');
  const { plugin: other } = await holder(all, 'receipts-intruder');
  grantTestPermissions(dbApi, alice.user.id, [`plugin:${PLUGIN}`, 'plugin:receipts-intruder', 'connections:read']);
  await assert.rejects(other.connections.receipts(connection.id), /Connection not found/);
  await assert.rejects(runPluginRequest(integrationRequestIdentity('receipts-intruder', alice.user.id), () => other.connections.receipts(connection.id)), /Connection not found/);
});

test('a disabled owner or an unloaded plugin reads nothing', async () => {
  const { plugin, dispose, alice, connection } = await connected();
  // The identity was resolved while the account was active, as for a request in flight.
  const identity = integrationRequestIdentity(PLUGIN, alice.user.id);
  dbApi.setUserStatus(alice.user.id, 'disabled');
  await assert.rejects(runPluginRequest(identity, () => plugin.connections.receipts(connection.id)), /active owner/);
  dbApi.setUserStatus(alice.user.id, 'active');
  assert.equal((await asUser(alice.user.id, () => plugin.connections.receipts(connection.id))).receipts.length, 0);
  await dispose();
  await assert.rejects(asUser(alice.user.id, () => plugin.connections.receipts(connection.id)), /unloaded/);
});
