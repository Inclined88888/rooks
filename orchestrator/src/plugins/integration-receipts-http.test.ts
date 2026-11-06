import { createTestAccount } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { quietWindow, waitUntil } from '../../tests/helpers/wait-until.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { dbApi } from '../db.js';
import { createDaemonAuthMiddleware } from '../plugins-bundled/http/auth.js';
import { hashSessionToken, issueSessionToken, SESSION_COOKIE } from '../users/session.js';
import { issueMissionApiToken } from '../users/api-tokens.js';
import { daemonIntegrationHost } from './integration-runtime.js';
import { IntegrationStore, type IntegrationReceipt } from './integration-store.js';
import { registerIntegrationReceiptRoutes } from './integration-receipts-http.js';
import { setRedactionSource } from '../secrets/redact.js';
import type { PluginMessagingConnection } from './integration-types.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });

function account(name: string, superadmin = false) {
  const id = randomUUID();
  createTestAccount(dbApi, { id, email: `${name}-${id}@example.test`, name, passwordHash: 'unused', isSuperadmin: superadmin, status: 'active' });
  const token = issueSessionToken();
  dbApi.createSession({ tokenHash: hashSessionToken(token), userId: id, expiresAt: Date.now() + 600_000 });
  return { id, cookie: `${SESSION_COOKIE}=${token}` };
}

function missionToken(ownerUserId: string): string {
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'witness', 'work', undefined, ownerUserId);
  return `Bearer ${issueMissionApiToken(missionId)}`;
}

async function fixture() {
  const store = new IntegrationStore(join(mkdtempSync(join(tmpdir(), 'integration-receipts-')), 'integrations.db'));
  cleanup.push(() => store.close());
  const app = express();
  app.use(createDaemonAuthMiddleware({ token: 'daemon-test-token', required: true }));
  registerIntegrationReceiptRoutes(app, store);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, who: string | null) => {
    const headers: Record<string, string> = {};
    if (who === 'daemon') headers.authorization = 'Bearer daemon-test-token';
    else if (who?.startsWith('Bearer ')) headers.authorization = who;
    else if (who) headers.cookie = who;
    const res = await fetch(base + path, { method, headers });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
  };
  const connect = (ownerUserId: string): PluginMessagingConnection => {
    const connection: PluginMessagingConnection = {
      id: randomUUID(), pluginId: 'p', identity: { ownerUserId }, transport: 'p:chat@1', agent: 'witness',
      config: { endpoint: 'config-witness' }, secretRefs: { token: 'secret-ref-witness' }, enabled: true, revision: 1,
    };
    store.createConnection(connection);
    return connection;
  };
  const fail = (connection: PluginMessagingConnection, text = 'hello there'): string => {
    const row = store.accept(connection, { externalId: randomUUID(), text, replyContext: { room: 'reply-context-witness' } });
    store.db.prepare("UPDATE receipts SET attempts=295,failed_at=?,last_error='provider 502',checkpoint='{\"part\":\"checkpoint-witness\"}' WHERE id=?").run(Date.now(), row.id);
    return row.id;
  };
  return { store, call, connect, fail };
}

type Listed = { id: string; owner: unknown; counts: { failed: number }; receipts: { id: string; status: string; lastError: string | null; preview: string }[] };

test('anonymous is refused on every route', async () => {
  const f = await fixture();
  const a = account('a');
  const receipt = f.fail(f.connect(a.id));
  for (const [method, path] of [
    ['GET', '/api/integrations/receipts'],
    ['POST', `/api/integrations/receipts/${receipt}/replay`],
    ['DELETE', `/api/integrations/receipts/${receipt}`],
    ['POST', `/api/integrations/connections/${randomUUID()}/replay-failed`],
  ] as const) {
    assert.equal((await f.call(method, path, null)).status, 401, `${method} ${path}`);
  }
  assert.ok(f.store.getReceipt(receipt)!.failed_at > 0);
});

test('the daemon token names nobody: it can neither read nor replay', async () => {
  const f = await fixture();
  const a = account('a');
  const connection = f.connect(a.id);
  const receipt = f.fail(connection);
  assert.equal((await f.call('GET', '/api/integrations/receipts', 'daemon')).status, 403);
  assert.equal((await f.call('POST', `/api/integrations/receipts/${receipt}/replay`, 'daemon')).status, 403);
  assert.equal((await f.call('DELETE', `/api/integrations/receipts/${receipt}`, 'daemon')).status, 403);
  assert.equal((await f.call('POST', `/api/integrations/connections/${connection.id}/replay-failed`, 'daemon')).status, 403);
  assert.ok(f.store.getReceipt(receipt)!.failed_at > 0);
});

test('another account sees nothing and gets a 404 on each gesture', async () => {
  const f = await fixture();
  const a = account('a');
  const b = account('b');
  const connection = f.connect(a.id);
  const receipt = f.fail(connection, 'private message of a');
  const listed = await f.call('GET', '/api/integrations/receipts', b.cookie);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.connections, []);
  assert.ok(!listed.text.includes('private message of a'));
  const filtered = await f.call('GET', `/api/integrations/receipts?connection=${connection.id}`, b.cookie);
  assert.deepEqual(filtered.body.connections, []);
  assert.equal((await f.call('POST', `/api/integrations/receipts/${receipt}/replay`, b.cookie)).status, 404);
  assert.equal((await f.call('DELETE', `/api/integrations/receipts/${receipt}`, b.cookie)).status, 404);
  assert.equal((await f.call('POST', `/api/integrations/connections/${connection.id}/replay-failed`, b.cookie)).status, 404);
  assert.ok(f.store.getReceipt(receipt)!.failed_at > 0);
});

test('the owner reads a diagnostic that carries no configuration, secret reference, reply context nor checkpoint', async () => {
  const f = await fixture();
  const a = account('a');
  const connection = f.connect(a.id);
  const receipt = f.fail(connection, `start ${'x'.repeat(500)}`);
  const listed = await f.call('GET', '/api/integrations/receipts', a.cookie);
  assert.equal(listed.status, 200);
  const [row] = listed.body.connections as Listed[];
  assert.equal(row!.id, connection.id);
  assert.equal(row!.owner, null);
  assert.equal(row!.counts.failed, 1);
  assert.equal(row!.receipts[0]!.id, receipt);
  assert.equal(row!.receipts[0]!.status, 'failed');
  assert.equal(row!.receipts[0]!.lastError, 'provider 502');
  assert.equal(row!.receipts[0]!.preview.length, 200);
  for (const witness of ['config-witness', 'secret-ref-witness', 'reply-context-witness', 'checkpoint-witness']) {
    assert.ok(!listed.text.includes(witness), witness);
  }
});

test('a failure reason is masked against a value added to the vault after the failure', async () => {
  const f = await fixture();
  const a = account('a');
  const connection = f.connect(a.id);
  const previous = setRedactionSource(() => []);
  cleanup.push(() => { setRedactionSource(previous); });
  const failed = f.fail(connection);
  f.store.db.prepare('UPDATE receipts SET last_error=? WHERE id=?').run('refused for vault-value-0123456789 at once', failed);
  const retrying = f.store.accept(connection, { externalId: 'retrying', text: 'hi', replyContext: null });
  f.store.db.prepare('UPDATE receipts SET attempts=3 WHERE id=?').run(retrying.id);
  const read = () => f.call('GET', '/api/integrations/receipts', a.cookie);
  assert.equal(((await read()).body.connections as Listed[])[0]!.receipts[0]!.lastError, 'refused for vault-value-0123456789 at once');

  setRedactionSource(() => ['vault-value-0123456789']);
  const listed = await read();
  const rows = (listed.body.connections as Listed[])[0]!.receipts;
  assert.equal(rows[0]!.lastError, 'refused for *** at once');
  assert.equal(rows[1]!.lastError, null, 'no failure stays no failure');
  assert.ok(!listed.text.includes('vault-value-0123456789'));
  assert.match(f.store.getReceipt(failed)!.last_error ?? '', /vault-value-0123456789/, 'the mask is applied on read, not by rewriting the row');
});

test('a filter narrows the list and an invalid query is refused', async () => {
  const f = await fixture();
  const a = account('a');
  const connection = f.connect(a.id);
  const failed = f.fail(connection);
  const retrying = f.store.accept(connection, { externalId: 'retrying', text: 'hi', replyContext: null });
  f.store.db.prepare('UPDATE receipts SET attempts=3 WHERE id=?').run(retrying.id);
  const list = async (query: string) => ((await f.call('GET', `/api/integrations/receipts${query}`, a.cookie)).body.connections as Listed[])[0]!.receipts.map((r) => r.id);
  assert.deepEqual(await list(''), [failed, retrying.id]);
  assert.deepEqual(await list('?status=failed'), [failed]);
  assert.deepEqual(await list('?status=retrying'), [retrying.id]);
  assert.equal((await f.call('GET', '/api/integrations/receipts?status=bogus', a.cookie)).status, 400);
  assert.equal((await f.call('GET', '/api/integrations/receipts?limit=100000', a.cookie)).status, 400);
  assert.equal((await f.call('GET', '/api/integrations/receipts?other=1', a.cookie)).status, 400);
});

test('the owner replays one receipt, a whole connection, and discards', async () => {
  const f = await fixture();
  const a = account('a');
  const connection = f.connect(a.id);
  const one = f.fail(connection);
  assert.equal((await f.call('POST', `/api/integrations/receipts/${one}/replay`, a.cookie)).status, 200);
  assert.equal(f.store.getReceipt(one)!.failed_at, 0);
  assert.equal(f.store.getReceipt(one)!.attempts, 0);
  assert.equal((await f.call('POST', `/api/integrations/receipts/${one}/replay`, a.cookie)).status, 409);

  const two = f.fail(connection);
  const three = f.fail(connection);
  const all = await f.call('POST', `/api/integrations/connections/${connection.id}/replay-failed`, a.cookie);
  assert.equal(all.body.replayed, 2);
  assert.equal(f.store.getReceipt(two)!.failed_at, 0);
  assert.equal(f.store.getReceipt(three)!.failed_at, 0);

  const four = f.fail(connection);
  assert.equal((await f.call('DELETE', `/api/integrations/receipts/${four}`, a.cookie)).status, 200);
  assert.equal(f.store.getReceipt(four), undefined);
  assert.equal((await f.call('DELETE', `/api/integrations/receipts/${two}`, a.cookie)).status, 409, 'still owed to its sender');
  assert.ok(f.store.getReceipt(two));
});

test('an agent acting for the owner may read but never replay', async () => {
  const f = await fixture();
  const a = account('a');
  const connection = f.connect(a.id);
  const receipt = f.fail(connection);
  const token = missionToken(a.id);
  const listed = await f.call('GET', '/api/integrations/receipts', token);
  assert.equal(listed.status, 200);
  assert.equal((listed.body.connections as Listed[]).length, 1);
  assert.equal((await f.call('POST', `/api/integrations/receipts/${receipt}/replay`, token)).status, 403);
  assert.equal((await f.call('DELETE', `/api/integrations/receipts/${receipt}`, token)).status, 403);
  assert.equal((await f.call('POST', `/api/integrations/connections/${connection.id}/replay-failed`, token)).status, 403);
  assert.ok(f.store.getReceipt(receipt)!.failed_at > 0);
});

test('an administrator sees every account in a session, on the record, but not from a mission', async () => {
  const f = await fixture();
  const a = account('a');
  const admin = account('admin', true);
  const foreign = f.connect(a.id);
  const pluginOwned = f.connect('plugin:p');
  const receipt = f.fail(foreign, 'private message of a');
  const listed = await f.call('GET', '/api/integrations/receipts', admin.cookie);
  const rows = listed.body.connections as Listed[];
  assert.deepEqual(new Set(rows.map((row) => row.id)), new Set([foreign.id, pluginOwned.id]));
  assert.equal((rows.find((row) => row.id === foreign.id)!.owner as { id: string }).id, a.id);

  const token = missionToken(admin.id);
  const fromMission = await f.call('GET', '/api/integrations/receipts', token);
  assert.deepEqual(fromMission.body.connections, [], 'a mission of the administrator reads only its own');
  assert.ok(!fromMission.text.includes('private message of a'));

  assert.equal((await f.call('POST', `/api/integrations/receipts/${receipt}/replay`, admin.cookie)).status, 200);
  assert.ok(dbApi.listAuditLog(50).some((entry) => entry.action === 'integration_receipt.admin_replay' && entry.target?.includes(a.id)));
});

test('a malformed id answers 404, never a lookup', async () => {
  const f = await fixture();
  const a = account('a');
  assert.equal((await f.call('POST', "/api/integrations/receipts/x'%20OR%201=1/replay", a.cookie)).status, 404);
  assert.equal((await f.call('DELETE', '/api/integrations/receipts/not-an-id', a.cookie)).status, 404);
  assert.equal((await f.call('POST', '/api/integrations/connections/not-an-id/replay-failed', a.cookie)).status, 404);
});

test('running out of retries warns the owner, once per connection and per hour', async () => {
  const a = account('a');
  const connection = {
    id: randomUUID(), pluginId: 'p', identity: { ownerUserId: a.id }, transport: 'p:chat@1', agent: 'witness',
    config: {}, secretRefs: {}, enabled: true, revision: 1,
  } satisfies PluginMessagingConnection;
  const host = daemonIntegrationHost();
  const mine = () => dbApi.listNotifications({ limit: 50, viewer: { id: a.id, isSuperadmin: false, permissions: [] } });
  for (let i = 0; i < 5; i++) host.gaveUp!(connection, {} as IntegrationReceipt);
  const stopped = () => mine().filter((card) => card.title.includes('stopped retrying'));
  await waitUntil(() => stopped().length > 0, 'the card of the connection');
  await quietWindow();
  const cards = stopped();
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.owner_user_id, a.id);
});
