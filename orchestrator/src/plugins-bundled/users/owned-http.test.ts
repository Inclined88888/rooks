/**
 * M.3 — two sessions see different owned rows through the real routes
 * (filter in dbApi, viewer taken from req.auth). Covers list AND get-by-id
 * for each table in MULTI-USER.md §5 besides missions (already M.1c/M.1f).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { postTestAccount } from '../../../tests/helpers/accounts.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-owned-http-'));
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('./routes.js');
const { registerRoutes: registerKanban } = await import('../kanban/routes.js');
const { registerRoutes: registerNotifs } = await import('../notifications/routes.js');
const { registerRoutes: registerBacklog } = await import('../kanban/project-todo-routes.js');
const { registerRoutes: registerMemory } = await import('../memory/routes.js');
const { registerRoutes: registerDreams } = await import('../dreams/routes.js');
const { registerRoutes: registerBrowser } = await import('../browser-embedded/routes.js');
const { registerRoutes: registerMissions } = await import('../missions/routes.js');
const { registerRoutes: registerHttp } = await import('../http/routes.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE } = await import('../../users/session.js');

const TOKEN = 'witness-daemon-token';

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerKanban(app);
registerNotifs(app);
registerBacklog(app);
registerMemory(app);
registerDreams(app);
registerBrowser(app);
registerMissions(app);
registerHttp(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness must not take the production port');
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

function sessionCookie(res: Response): string | undefined {
  const lines = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : []);
  for (const line of lines) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; bearer?: string } = {},
): Promise<{ status: number; json: unknown; res: Response }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, res };
}

const setup = await call('POST', '/api/auth/setup', {
  body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' },
});
assert.equal(setup.status, 201);
const adminId = (setup.json as { user: { id: string } }).user.id;
const adminCookie = sessionCookie(setup.res)!;

const created = await postTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', password: 'ada-secret' });
assert.equal(created.status, 201);
const adaId = (created.json as { user: { id: string } }).user.id;
const adaLogin = await call('POST', '/api/auth/login', {
  body: { email: 'ada@example.com', password: 'ada-secret' },
});
const adaCookie = sessionCookie(adaLogin.res)!;

const adaTask = randomUUID();
const adminTask = randomUUID();
dbApi.createTask(adaTask, 'ada only', 'ada.agent', { ownerUserId: adaId });
dbApi.createTask(adminTask, 'admin only', 'admin.agent', { ownerUserId: adminId });

const adaNotif = dbApi.createNotification({
  id: randomUUID(), type: 'report', title: 'ada ping', ownerUserId: adaId,
});
const adminNotif = dbApi.createNotification({
  id: randomUUID(), type: 'report', title: 'admin ping', ownerUserId: adminId,
});

const adaPending = dbApi.insertProjectTodo({ text: 'ada later', ownerUserId: adaId });
const adminTodo = dbApi.insertProjectTodo({ text: 'admin later', ownerUserId: adminId });

const adaMem = dbApi.insertProposal({ kind: 'pitfall', text: 'ada mem', ownerUserId: adaId });
const adminMem = dbApi.insertProposal({ kind: 'pitfall', text: 'admin mem', ownerUserId: adminId });

const adaDream = dbApi.insertDreamProposal({
  kind: 'improve', project: 'p', title: 'ada dream', body: 'b', ownerUserId: adaId,
});
const adminDream = dbApi.insertDreamProposal({
  kind: 'improve', project: 'p', title: 'admin dream', body: 'b', ownerUserId: adminId,
});

dbApi.upsertBrowserSession({
  project: 'ada-b', containerName: 'c-ada', cdpPort: 9311, novncPort: 3011,
  status: 'stopped', ownerUserId: adaId,
});
dbApi.upsertBrowserSession({
  project: 'admin-b', containerName: 'c-admin', cdpPort: 9312, novncPort: 3012,
  status: 'stopped', ownerUserId: adminId,
});

const adaMission = randomUUID();
const adminMission = randomUUID();
dbApi.createMission(adaMission, 'ada.agent', 'ada', undefined, adaId);
dbApi.createMission(adminMission, 'admin.agent', 'admin', undefined, adminId);

const adaMsg = dbApi.enqueueMessage({
  id: randomUUID(), fromMission: adaMission, fromAgent: 'a', toAgent: 'inbox',
  payload: 'ada', ownerUserId: adaId,
});
const adminMsg = dbApi.enqueueMessage({
  id: randomUUID(), fromMission: adminMission, fromAgent: 'a', toAgent: 'inbox',
  payload: 'admin', ownerUserId: adminId,
});

test('Ada does not see the superadmin\'s Kanban cards; get-by-id is 404', async () => {
  const list = await call('GET', '/api/tasks', { cookie: adaCookie });
  assert.equal(list.status, 200);
  const ids = ((list.json as { tasks: Array<{ id: string }> }).tasks).map((t) => t.id);
  assert.ok(ids.includes(adaTask));
  assert.ok(!ids.includes(adminTask));
  const hidden = await call('GET', `/api/tasks/${adminTask}`, { cookie: adaCookie });
  assert.equal(hidden.status, 404);
  const own = await call('GET', `/api/tasks/${adaTask}`, { cookie: adaCookie });
  assert.equal(own.status, 200);
});

test('Ada does not see the superadmin\'s notifications', async () => {
  const list = await call('GET', '/api/notifications', { cookie: adaCookie });
  assert.equal(list.status, 200);
  const ids = ((list.json as { notifications: Array<{ id: string }> }).notifications).map((n) => n.id);
  assert.ok(ids.includes(adaNotif.id));
  assert.ok(!ids.includes(adminNotif.id));
  const dismiss = await call('POST', `/api/notifications/${adminNotif.id}/dismiss`, { cookie: adaCookie });
  assert.equal(dismiss.status, 404);
});

test('Ada does not see the superadmin\'s project-todo items', async () => {
  const list = await call('GET', '/api/project-todo', { cookie: adaCookie });
  assert.equal(list.status, 200);
  const ids = ((list.json as { items: Array<{ id: number }> }).items).map((t) => t.id);
  assert.ok(ids.includes(adaPending.id));
  assert.ok(!ids.includes(adminTodo.id));
});

test('external links of an idea follow its visibility; an anonymous caller is refused', async () => {
  const { todoApi } = await import('../kanban/todo-api.js');
  todoApi.links.set(adaPending.id, { provider: 'gh', ref: 'ada-issue', url: 'https://example.com/ada' });
  todoApi.links.set(adminTodo.id, { provider: 'gh', ref: 'admin-issue', url: 'https://example.com/admin' });
  const system = todoApi.create({ text: 'system ticket' }, [{ provider: 'gh', ref: 'system-issue' }]).item;

  assert.equal((await call('GET', '/api/project-todo')).status, 401);

  const list = await call('GET', '/api/project-todo?status=all', { cookie: adaCookie });
  assert.equal(list.status, 200);
  const items = (list.json as { items: Array<{ id: number; links: Array<{ ref: string }> }> }).items;
  const refs = items.flatMap((t) => t.links.map((l) => l.ref));
  assert.deepEqual(items.find((t) => t.id === adaPending.id)?.links.map((l) => l.ref), ['ada-issue']);
  assert.ok(!refs.includes('admin-issue'));
  assert.ok(!items.some((t) => t.id === system.id) && !refs.includes('system-issue'));
  // Neither can she reach them through the idea.
  assert.equal((await call('PATCH', `/api/project-todo/${adminTodo.id}`, { cookie: adaCookie, body: { text: 'x' } })).status, 404);

  const admin = await call('GET', '/api/project-todo?status=all', { cookie: adminCookie });
  const adminRefs = (admin.json as { items: Array<{ links: Array<{ ref: string }> }> }).items.flatMap((t) => t.links.map((l) => l.ref));
  assert.ok(adminRefs.includes('admin-issue') && adminRefs.includes('system-issue'));
});

test('Ada does not see the superadmin\'s memory proposals', async () => {
  const list = await call('GET', '/api/memory/overview', { cookie: adaCookie });
  assert.equal(list.status, 200);
  const ids = ((list.json as { proposals: Array<{ id: number }> }).proposals).map((p) => p.id);
  assert.ok(ids.includes(adaMem));
  assert.ok(!ids.includes(adminMem));
});

test('Ada does not see the superadmin\'s dreams', async () => {
  const list = await call('GET', '/api/dreams?status=all', { cookie: adaCookie });
  assert.equal(list.status, 200);
  const ids = ((list.json as { dreams: Array<{ id: number }> }).dreams).map((d) => d.id);
  assert.ok(ids.includes(adaDream));
  assert.ok(!ids.includes(adminDream));
});

test('Ada does not see the superadmin\'s browser sessions; start is 404', async () => {
  const list = await call('GET', '/api/browser', { cookie: adaCookie });
  assert.equal(list.status, 200);
  const projects = ((list.json as { sessions: Array<{ project: string }> }).sessions).map((s) => s.project);
  assert.ok(projects.includes('ada-b'));
  assert.ok(!projects.includes('admin-b'));
  const start = await call('POST', '/api/browser/admin-b/start', { cookie: adaCookie });
  assert.equal(start.status, 404);
});

test('Ada does not see the superadmin\'s agent messages', async () => {
  const list = await call('GET', '/api/messages?to=inbox', { cookie: adaCookie });
  assert.equal(list.status, 200);
  const ids = ((list.json as { messages: Array<{ id: string }> }).messages).map((m) => m.id);
  assert.ok(ids.includes(adaMsg.id));
  assert.ok(!ids.includes(adminMsg.id));
  const hidden = await call('GET', `/api/messages/${adminMsg.id}`, { cookie: adaCookie });
  assert.equal(hidden.status, 404);
});

test('Ada\'s /api/stats taskCounts ignore the superadmin\'s cards', async () => {
  const adaStats = await call('GET', '/api/stats', { cookie: adaCookie });
  const adminStats = await call('GET', '/api/stats', { cookie: adminCookie });
  assert.equal(adaStats.status, 200);
  assert.equal(adminStats.status, 200);
  const adaPending = (adaStats.json as { taskCounts: { PENDING: number } }).taskCounts.PENDING;
  const adminPendingN = (adminStats.json as { taskCounts: { PENDING: number } }).taskCounts.PENDING;
  assert.ok(adaPending < adminPendingN);
});
