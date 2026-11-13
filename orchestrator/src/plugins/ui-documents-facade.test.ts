/**
 * `ctx.ui.documents` and the document events as a THIRD-PARTY plugin reaches
 * them (ADR-MCPUI D8). The origin comes from the plugin, never from the
 * arguments; a job sees the missions of its plugin only; a reference belongs
 * to one plugin; and the reply of a document reaches no plugin but the one
 * that created it — in reads, in returns and in events.
 */
import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-plugin-ui-documents-'));
await import('../../tests/helpers/paid-license.js');
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError, PLUGIN_EVENT_KINDS } = await import('./context.js');
const { PluginUiDocumentError } = await import('./ui-documents-facade.js');
const { runPluginRequest } = await import('./als.js');
const { dbApi } = await import('../db.js');
const { bus } = await import('../bus.js');
const { createUiDocument, UI_DOCUMENT_RESOLVED_EVENT } = await import('../plugins-bundled/ui-documents/model.js');
const { setActiveModules, resetActiveModules } = await import('../kernel/module-state.js');
const { registerRoutes } = await import('../plugins-bundled/ui-documents/routes.js');
import type { PluginUiDocumentEvent } from './ui-document-events.js';

const A = 'plugin-a';
const B = 'plugin-b';
const HTML = '<!doctype html><p>Pick</p>';

function member(name: string, plugins: string[]) {
  const id = randomUUID();
  const user = createTestAccount(dbApi, { id, email: `${name}-${id}@example.test`, name, passwordHash: 'unused' });
  grantTestPermissions(dbApi, id, plugins.map((p) => `plugin:${p}`));
  return user;
}
const ada = member('ada', [A, B]);
const bob = member('bob', [A, B]);
dbApi.createMission('m-ada', 'rooks.coder', 'work', undefined, ada.id);
dbApi.createMission('m-ada-2', 'rooks.coder', 'work', undefined, ada.id);
dbApi.createMission('m-bob', 'rooks.coder', 'work', undefined, bob.id);
dbApi.createMission('m-job-a', 'rooks.coder', 'work', undefined, `plugin:${A}`);

function identityOf(user: { id: string; email: string; name: string }) {
  return {
    viewer: { id: user.id, isSuperadmin: false, permissions: dbApi.listPermissionsForUser(user.id) },
    user: { id: user.id, email: user.email, name: user.name, is_superadmin: false },
    ownerUserId: user.id,
  };
}
const asAda = <T>(fn: () => Promise<T>) => runPluginRequest(identityOf(ada), fn);
const asBob = <T>(fn: () => Promise<T>) => runPluginRequest(identityOf(bob), fn);

async function pluginWith(id: string, permissions: string[]) {
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const res = readManifest({ rooks: { id, apiVersion: PLUGIN_API_VERSION, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  const plugin = createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, daemonHost(root));
  return { plugin, dispose: () => root.fiber.dispose() };
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try { await fn(); } catch (err) {
    return err instanceof PluginUiDocumentError ? err.code : `other: ${String(err)}`;
  }
  return undefined;
}

const ALL = ['ui-documents:read', 'ui-documents:write', 'events:subscribe'];

test('the origin is the plugin, whatever the arguments say', async () => {
  const { plugin, dispose } = await pluginWith(A, ALL);
  const doc = await asAda(() => plugin.ui.documents.create({ missionId: 'm-ada', title: 'Pick one', html: HTML }));
  assert.deepEqual(doc.origin, { kind: 'plugin', id: A });
  assert.equal(doc.status, 'shown');
  assert.ok('reply' in doc, 'its own document comes back with its (empty) reply');
  assert.ok(!('html' in doc));
  const forged = { missionId: 'm-ada', title: 't', html: HTML, origin: { kind: 'agent', id: 'rooks.main' } };
  assert.equal(await codeOf(() => asAda(() => plugin.ui.documents.create(forged as never))), 'invalid');
  const asking = await asAda(() => plugin.ui.documents.create({ missionId: 'm-ada', title: 't', html: HTML, expectsReply: true }));
  assert.equal(asking.status, 'pending');
  assert.equal(asking.reply, null, 'no answer yet');
  assert.equal(await codeOf(() => asAda(() => plugin.ui.documents.create({ missionId: 'm-ada', title: 't', html: 'x'.repeat(512 * 1024 + 1) }))), 'document_too_large');
  await dispose();
});

test('a missing permission is refused before anything is read or written', async () => {
  const reader = await pluginWith(A, ['ui-documents:read', 'events:subscribe']);
  await assert.rejects(asAda(() => reader.plugin.ui.documents.create({ missionId: 'm-ada', title: 't', html: HTML })), PluginPermissionError);
  await assert.rejects(asAda(() => reader.plugin.ui.documents.dismiss(randomUUID())), PluginPermissionError);
  const writer = await pluginWith(A, ['ui-documents:write', 'events:subscribe']);
  await assert.rejects(asAda(() => writer.plugin.ui.documents.get(randomUUID())), PluginPermissionError);
  await assert.rejects(asAda(() => writer.plugin.ui.documents.list()), PluginPermissionError);
  assert.throws(() => writer.plugin.events.on('ui_document_resolved', () => undefined), PluginPermissionError);
  await reader.dispose();
  await writer.dispose();
});

test('a job sees the missions of its plugin only; a request sees its account only', async () => {
  const { plugin, dispose } = await pluginWith(A, ALL);
  assert.equal(await codeOf(() => plugin.ui.documents.create({ missionId: 'm-ada', title: 't', html: HTML })), 'not_found', 'a job on a user\'s mission');
  const jobDoc = await plugin.ui.documents.create({ missionId: 'm-job-a', title: 'Job', html: HTML });
  assert.equal((await plugin.ui.documents.get(jobDoc.id))?.id, jobDoc.id);
  const adaDoc = await asAda(() => plugin.ui.documents.create({ missionId: 'm-ada-2', title: 'Ada', html: HTML }));
  assert.equal(await plugin.ui.documents.get(adaDoc.id), undefined, 'the job does not see Ada\'s document');
  assert.equal(await asBob(() => plugin.ui.documents.get(adaDoc.id)), undefined, 'nor does Bob');
  assert.deepEqual(await asBob(() => plugin.ui.documents.list({ missionId: 'm-ada-2' })), []);
  assert.ok(!(await asBob(() => plugin.ui.documents.list())).some((d) => d.id === adaDoc.id));
  assert.equal(await asBob(() => plugin.ui.documents.dismiss(adaDoc.id)), undefined);
  assert.equal(await codeOf(() => asBob(() => plugin.ui.documents.create({ missionId: 'm-ada-2', title: 't', html: HTML }))), 'not_found');
  assert.ok((await asAda(() => plugin.ui.documents.list())).some((d) => d.id === adaDoc.id));
  assert.equal(dbApi.getUiDocument(adaDoc.id)?.status, 'shown', 'nothing was dismissed');
  await dispose();
});

test('a reference is found by its own plugin only', async () => {
  const a = await pluginWith(A, ALL);
  const b = await pluginWith(B, ALL);
  const ref = { provider: 'github', ref: `acme/app#${randomUUID().slice(0, 6)}` };
  const doc = await asAda(() => a.plugin.ui.documents.create({ missionId: 'm-ada', title: 'Ticket', html: HTML, ref }));
  assert.equal((await asAda(() => a.plugin.ui.documents.findByRef(ref.provider, ref.ref)))?.id, doc.id);
  assert.equal(await asAda(() => b.plugin.ui.documents.findByRef(ref.provider, ref.ref)), undefined);
  assert.equal(await codeOf(() => asAda(() => a.plugin.ui.documents.create({ missionId: 'm-ada', title: 'Again', html: HTML, ref }))), 'ref_taken');
  const other = await asAda(() => b.plugin.ui.documents.create({ missionId: 'm-ada', title: 'Same ticket, B', html: HTML, ref }));
  assert.ok(other.id);
  assert.ok(!('ref' in (await asAda(() => b.plugin.ui.documents.get(doc.id)))!), 'B does not read A\'s reference');
  await a.dispose();
  await b.dispose();
});

test('dismiss removes a document of this plugin only, and says who removed it', async () => {
  const a = await pluginWith(A, ALL);
  const b = await pluginWith(B, ALL);
  const doc = await asAda(() => a.plugin.ui.documents.create({ missionId: 'm-ada', title: 'Remove me', html: HTML }));
  assert.equal(await asAda(() => b.plugin.ui.documents.dismiss(doc.id)), undefined);
  assert.equal(dbApi.getUiDocument(doc.id)?.status, 'shown');
  const gone = await asAda(() => a.plugin.ui.documents.dismiss(doc.id));
  assert.equal(gone?.status, 'dismissed');
  assert.deepEqual(gone?.resolvedBy, { kind: 'plugin', id: A });
  const event = dbApi.listEvents('m-ada').filter((e) => e.type === UI_DOCUMENT_RESOLVED_EVENT).map((e) => JSON.parse(e.payload)).find((p) => p.id === doc.id);
  assert.deepEqual(event?.resolvedBy, { kind: 'plugin', id: A });
  await a.dispose();
  await b.dispose();
});

test('no raw relay of document events: the mission kinds are not plugin kinds', async () => {
  assert.ok(!PLUGIN_EVENT_KINDS.some((k: string) => k.startsWith('ui_document')));
  const { plugin, dispose } = await pluginWith(A, ALL);
  assert.throws(() => plugin.events.on('ui_document' as never, () => undefined));
  await dispose();
});

test('the reply reaches the plugin that created the document, and no other (D8)', async () => {
  const SENTINEL = `REPLY-SENTINEL-${randomUUID()}`;
  const a = await pluginWith(A, ALL);
  const b = await pluginWith(B, [...ALL, 'missions:read']);
  const seenA: PluginUiDocumentEvent[] = [];
  const seenB: PluginUiDocumentEvent[] = [];
  for (const kind of ['ui_document_created', 'ui_document_resolved'] as const) {
    a.plugin.events.on(kind, (ev) => { seenA.push(ev); });
    b.plugin.events.on(kind, (ev) => { seenB.push(ev); });
  }
  const mission = dbApi.getMission('m-ada')!;
  const seed = (origin: { kind: 'agent' | 'plugin'; id: string }): string => {
    const out = createUiDocument({ id: randomUUID(), mission, origin, title: `q ${origin.id}`, html: HTML, expectsReply: true, ref: origin.kind === 'plugin' ? { provider: 'p', ref: randomUUID() } : null });
    assert.ok(out.ok);
    assert.ok(dbApi.settleUiDocument(out.row.id, { status: 'answered', reply: JSON.stringify({ answer: SENTINEL }), resolvedByKind: 'user', resolvedById: ada.id }));
    // The answer path arrives with volet 4: its event is published here the way it will be.
    const payload = { id: out.row.id, status: 'answered', resolvedBy: { kind: 'user', id: ada.id } };
    const row = dbApi.insertEvent(mission.id, UI_DOCUMENT_RESOLVED_EVENT, payload);
    bus.publish({ kind: 'event', missionId: mission.id, type: UI_DOCUMENT_RESOLVED_EVENT, timestamp: row.timestamp, payload });
    return out.row.id;
  };
  const agentDoc = seed({ kind: 'agent', id: 'rooks.coder' });
  const docA = seed({ kind: 'plugin', id: A });
  const docB = seed({ kind: 'plugin', id: B });
  await new Promise((r) => setTimeout(r, 50));

  const has = (value: unknown): boolean => JSON.stringify(value).includes(SENTINEL);
  // Plugin B: nothing of the agent's nor of A's answer, in any output.
  for (const id of [agentDoc, docA]) {
    assert.equal(has(await asAda(() => b.plugin.ui.documents.get(id))), false, `B get ${id}`);
    assert.equal(await asAda(() => b.plugin.ui.documents.dismiss(id)), undefined);
  }
  const listB = await asAda(() => b.plugin.ui.documents.list({ missionId: 'm-ada' }));
  assert.equal(has(listB.filter((d) => d.id !== docB)), false, 'B list');
  assert.equal(has(listB.find((d) => d.id === docB)), true, 'B reads its own answer');
  const rowB = dbApi.getUiDocument(docB)!;
  assert.equal(has(await asAda(() => b.plugin.ui.documents.findByRef(rowB.ref_provider!, rowB.ref!))), true);
  assert.equal(has(await asAda(() => b.plugin.ui.documents.dismiss(docB))), true, 'the return of dismiss on its own document');
  const resolvedB = seenB.filter((e) => e.kind === 'ui_document_resolved');
  assert.deepEqual(resolvedB.map((e) => e.documentId).sort(), [agentDoc, docA, docB].sort(), 'B hears every resolution of the account');
  assert.equal(has(resolvedB.filter((e) => e.documentId !== docB)), false, 'B events: no foreign answer');
  assert.equal(has(resolvedB.find((e) => e.documentId === docB)), true);
  assert.equal(has(seenB.filter((e) => e.kind === 'ui_document_created')), false);
  // Plugin A: its own answer only.
  assert.equal(has(await asAda(() => a.plugin.ui.documents.get(docA))), true);
  assert.equal(has(await asAda(() => a.plugin.ui.documents.get(agentDoc))), false);
  const resolvedA = seenA.filter((e) => e.kind === 'ui_document_resolved');
  assert.equal(has(resolvedA.find((e) => e.documentId === docA)), true);
  assert.equal(has(resolvedA.filter((e) => e.documentId !== docA)), false);
  const ev = resolvedA.find((e) => e.documentId === docA)!;
  assert.deepEqual(ev.creator, { kind: 'plugin', id: A });
  assert.deepEqual(ev.origin, { kind: 'user', id: ada.id });
  // Never in what a plugin can read of the mission itself.
  assert.equal(has(await asAda(() => b.plugin.missions.get('m-ada'))), false);
  assert.equal(has(dbApi.listEvents('m-ada')), false);
  await a.dispose();
  await b.dispose();
});

test('an account the plugin may not serve gets no event', async () => {
  const carol = createTestAccount(dbApi, { id: randomUUID(), email: `carol-${randomUUID()}@example.test`, name: 'carol', passwordHash: 'unused' });
  dbApi.createMission('m-carol', 'rooks.coder', 'work', undefined, carol.id);
  const { plugin, dispose } = await pluginWith(A, ALL);
  const seen: PluginUiDocumentEvent[] = [];
  plugin.events.on('ui_document_created', (ev) => { seen.push(ev); });
  const out = createUiDocument({ id: randomUUID(), mission: dbApi.getMission('m-carol')!, origin: { kind: 'agent', id: 'rooks.coder' }, title: 't', html: HTML });
  assert.ok(out.ok);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(seen.length, 0);
  await dispose();
});

test('the facade answers module_disabled when the module is off', async () => {
  const { plugin, dispose } = await pluginWith(A, ALL);
  setActiveModules(['@rooks/missions']);
  try {
    assert.equal(await codeOf(() => asAda(() => plugin.ui.documents.list())), 'module_disabled');
  } finally {
    resetActiveModules();
  }
  await dispose();
});

test('end to end: an answer sent by the owner reaches its creator only (D8)', async () => {
  const SENTINEL = `REPLY-SENTINEL-${randomUUID()}`;
  dbApi.createMission('m-e2e', 'rooks.coder', 'work', undefined, ada.id);
  const delivered: Array<{ missionId: string; text: string }> = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const raw = req.header('x-test-auth');
    if (raw) {
      const fake = JSON.parse(raw) as { kind: 'session' | 'api-token'; missionId?: string };
      req.auth = { kind: fake.kind, user: dbApi.getUserById(ada.id) ?? null, isSuperadmin: false, missionId: fake.missionId ?? null };
    }
    next();
  });
  registerRoutes(app, { waitMs: () => 0, deliverLate: (missionId, text) => { delivered.push({ missionId, text }); } });
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ui-documents`;
  const call = (method: string, path: string, auth: object, body?: unknown) => fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-test-auth': JSON.stringify(auth) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const session = { kind: 'session' };
  const agent = { kind: 'api-token', missionId: 'm-e2e' };

  const a = await pluginWith(A, ALL);
  const b = await pluginWith(B, [...ALL, 'missions:read']);
  const seenA: PluginUiDocumentEvent[] = [];
  const seenB: PluginUiDocumentEvent[] = [];
  a.plugin.events.on('ui_document_resolved', (ev) => { seenA.push(ev); });
  b.plugin.events.on('ui_document_resolved', (ev) => { seenB.push(ev); });

  const agentDoc = ((await (await call('POST', '', agent, { title: 'Agent asks', html: HTML, reply: true })).json()) as { id: string }).id;
  const docA = (await asAda(() => a.plugin.ui.documents.create({ missionId: 'm-e2e', title: 'A asks', html: HTML, expectsReply: true }))).id;
  for (const id of [agentDoc, docA]) {
    const res = await call('POST', `/${id}/reply`, session, { reply: { answer: SENTINEL } });
    assert.equal(res.status, 200);
    assert.equal(JSON.stringify(await res.json()).includes(SENTINEL), true, 'the reading session sees what it sent');
  }
  await new Promise((r) => setTimeout(r, 50));
  const has = (value: unknown): boolean => JSON.stringify(value ?? null).includes(SENTINEL);

  // Delivered to the agent for ITS document only.
  assert.deepEqual(delivered.map((d) => d.missionId), ['m-e2e']);
  assert.equal(has(delivered[0]!.text), true);
  assert.ok(delivered[0]!.text.includes(agentDoc));
  // ui_document_get of the agent on the plugin's document: no answer.
  assert.equal(has(await (await call('GET', `/${docA}`, agent)).json()), false);
  assert.equal(has(await (await call('GET', `/${agentDoc}`, agent)).json()), true, 'its own document, yes');
  // Plugin B: neither answer, in reads or events.
  for (const id of [agentDoc, docA]) assert.equal(has(await asAda(() => b.plugin.ui.documents.get(id))), false);
  assert.equal(has(await asAda(() => b.plugin.ui.documents.list({ missionId: 'm-e2e' }))), false);
  assert.equal(has(seenB), false);
  assert.equal(has(await asAda(() => b.plugin.missions.get('m-e2e'))), false);
  // Plugin A: its own answer, by event and by get.
  assert.equal(has(seenA.find((e) => e.documentId === docA)), true);
  assert.equal(has(seenA.find((e) => e.documentId === agentDoc)), false);
  assert.equal(has(await asAda(() => a.plugin.ui.documents.get(docA))), true);
  // Nowhere else.
  assert.equal(has(dbApi.listEvents('m-e2e')), false, 'the conversation\'s events');
  assert.equal(has(dbApi.listNotifications({ limit: 500 })), false, 'notifications');
  assert.equal(has(dbApi.listAuditLog(500)), false, 'audit');

  server.closeAllConnections();
  server.close();
  await a.dispose();
  await b.dispose();
});
