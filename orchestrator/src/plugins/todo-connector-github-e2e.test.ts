/**
 * `examples/plugin-todo-connector` end to end, with no relay: GitHub's own
 * `X-Hub-Signature-256` call goes through the real public route and the
 * template's handler creates the idea with its issue reference, once; a ping
 * is answered without an idea; a forged call never reaches the template.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createHmac, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';
import type { RequestAuth } from '../users/identity.js';
import type { PluginLoader, PluginStatus } from './loader.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../examples/plugin-todo-connector');

const { resolveMasterKey } = await import('../secrets/key.js');
const { dbApi } = await import('../db.js');
const { createDaemonAuthMiddleware } = await import('../plugins-bundled/http/auth.js');
const { createBodyParser } = await import('../kernel/body-parser.js');
const { attachPluginLoader } = await import('./runtime.js');
const { readManifest } = await import('./manifest.js');
const { createPluginContext, daemonHost } = await import('./context.js');
const { registerPluginWebhookRoute, webhookPublisherOf } = await import('./webhooks.js');
const { registerRoutes } = await import('../plugins-bundled/plugins/routes.js');
const { apply } = await import(join(DIR, 'lib/index.js')) as { apply(ctx: unknown): void };
resolveMasterKey({ keyring: null });
dbApi.upsertProject('timon', {});

const parsed = readManifest(JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8')));
if (!parsed.ok) throw new Error(parsed.message);
const manifest = parsed.manifest;
const PLUGIN_ID = manifest.id;
dbApi.pluginKvSet(PLUGIN_ID, '@settings/repository', JSON.stringify('acme/widgets'));

const adminId = randomUUID();
const admin = createTestAccount(dbApi, { id: adminId, email: `admin-${adminId}@example.test`, name: 'admin', passwordHash: 'x', isSuperadmin: true });
const IDENTITIES: Record<string, RequestAuth> = { admin: { kind: 'session', user: admin, isSuperadmin: true } };

const status: PluginStatus = {
  id: PLUGIN_ID, pkg: '@timon-ai/plugin-todo-connector', dir: DIR, version: '0.1.0', state: 'active',
  reason: null, error: null, manifest, client: false, signed: false,
};
const fakeLoader = { list: () => [status], bundles: { get: () => null }, covers: { get: () => null } } as unknown as PluginLoader;

const app = express();
attachPluginLoader(app, fakeLoader);
app.use((req, res, next) => {
  const as = req.header('x-test-as');
  if (as && IDENTITIES[as]) { req.auth = IDENTITIES[as]; next(); return; }
  createDaemonAuthMiddleware({ token: 'daemon-e2e-token', required: true })(req, res, next);
});
app.use(createBodyParser());
registerPluginWebhookRoute(app);
registerRoutes(app);
const server: Server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const root = new Context();
let inner!: Context;
await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
apply(createPluginContext(inner, { manifest, version: '0.1.0', publisher: webhookPublisherOf(status) }, daemonHost(root)));
test.after(async () => { server.closeAllConnections(); server.close(); await root.fiber.dispose(); });

let secret = '';
/** What GitHub sends: JSON body, `X-Hub-Signature-256`, event and delivery headers. */
async function github(event: string, payload: unknown, key = secret) {
  const raw = JSON.stringify(payload);
  const res = await fetch(`${base}/api/plugins/hooks/${PLUGIN_ID}/issues`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'GitHub-Hookshot/abc',
      'x-github-event': event,
      'x-github-delivery': randomUUID(),
      'x-hub-signature-256': `sha256=${createHmac('sha256', key).update(raw).digest('hex')}`,
    },
    body: raw,
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
/** Ideas bearing this issue's text, and the one its reference points at. */
const ideasOf = (text: string) => dbApi.listProjectTodo({ limit: 1000 }).filter((t) => t.text === text);

test('the template declares GitHub\'s format and contract 8', () => {
  assert.deepEqual(manifest.webhooks, [{ name: 'issues', auth: 'github' }]);
  assert.equal(manifest.apiVersion, 8);
});

test('GitHub calls the template directly: the issue becomes an idea, once, with its reference', async () => {
  const created = await fetch(`${base}/api/plugins/${PLUGIN_ID}/-/webhooks/issues/secret`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-test-as': 'admin' }, body: '{}',
  });
  assert.equal(created.status, 201);
  secret = (await created.json() as { secret: string }).secret;

  assert.deepEqual(await github('ping', { zen: 'Keep it logically awesome.', hook_id: 1 }), { status: 200, body: { status: 'received' } });
  const issue = { number: 42, title: 'Crash on save', body: 'Steps…', html_url: 'https://github.com/acme/widgets/issues/42' };
  assert.equal((await github('issues', { action: 'opened', issue })).status, 200);
  const ideas = ideasOf('#42 · Crash on save');
  assert.equal(ideas.length, 1);
  assert.equal(dbApi.getTodoExternalRef('github', 'acme/widgets#42')?.todo_id, ideas[0]?.id);
  // GitHub redelivers from its UI with a new delivery id: still one idea.
  assert.equal((await github('issues', { action: 'opened', issue })).status, 200);
  assert.equal(ideasOf('#42 · Crash on save').length, 1);
});

test('a call not signed with the webhook secret never reaches the template', async () => {
  const issue = { number: 43, title: 'Forged', html_url: 'https://github.com/acme/widgets/issues/43' };
  const forged = await github('issues', { action: 'opened', issue }, 'not-the-secret-0123456789abcdef0123');
  assert.equal(forged.status, 401);
  assert.equal(ideasOf('#43 · Forged').length, 0);
  assert.equal(dbApi.getTodoExternalRef('github', 'acme/widgets#43'), undefined);
});
