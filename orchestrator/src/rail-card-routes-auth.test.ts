/**
 * TODO #645 — hiding a chat card is not enough: the routes behind the Docker,
 * Grepai, Daemon and Video cards answered any signed-in account, so an
 * Employee could restart the daemon with one POST. The Git reads joined them
 * with TODO #689. Isolated TIMON_HOME, witness on 127.0.0.1:0, an unknown
 * project and spies in place of the real restart.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../tests/helpers/accounts.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-rail-card-routes-'));
await import('../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('./plugins-bundled/users/routes.js');
const { registerRoutes: registerDocker } = await import('./plugins-bundled/docker-supervision/routes.js');
const { registerRoutes: registerGrepai } = await import('./plugins-bundled/grepai/routes.js');
const { registerRoutes: registerSelf } = await import('./plugins-bundled/orchestrator-self/routes.js');
const { registerRoutes: registerVideo } = await import('./plugins-bundled/video-factory/routes.js');
const { registerRoutes: registerGit } = await import('./plugins-bundled/git/routes.js');
const { dbApi } = await import('./db.js');
const { SESSION_COOKIE } = await import('./users/session.js');
const { SETUP_ROLE_PRESETS } = await import('../tests/helpers/presets.js');

const TOKEN = 'witness-daemon-token';
const controlled = { restart: 0, rebuild: 0 };

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerDocker(app);
registerGrepai(app);
registerSelf(app, { restart: () => { controlled.restart += 1; }, rebuild: () => { controlled.rebuild += 1; } });
registerVideo(app);
registerGit(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness must not take the production port');
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

async function call(method: string, path: string, opts: { cookie?: string; bearer?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  return fetch(`${base}${path}`, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
}

function sessionCookie(res: Response): string {
  for (const line of res.headers.getSetCookie()) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  throw new Error('no session cookie');
}

const setup = await call('POST', '/api/auth/setup', { body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' } });
assert.equal(setup.status, 201);
const adminCookie = sessionCookie(setup);

async function signIn(name: string, permissions: readonly string[]): Promise<string> {
  const email = `${name}@example.com`;
  const created = await postTestAccount(dbApi, { email, name, password: `${name}-secret` });
  assert.equal(created.status, 201);
  const user = created.json.user!;
  grantTestPermissions(dbApi, user.id, [...permissions]);
  return sessionCookie(await call('POST', '/api/auth/login', { body: { email, password: `${name}-secret` } }));
}

const employePermissions = SETUP_ROLE_PRESETS.find((preset) => preset.key === 'employee')!.permissions;
const employe = await signIn('employe', employePermissions);
const cardsOnly = await signIn('cards', [
  'widget:docker-supervision', 'widget:grepai', 'widget:orchestrator-self', 'widget:video-factory',
]);
const projectsPage = await signIn('projects-page', ['page:/agents']);
const projectManager = await signIn('manager', ['projects:manage']);
const settingsWriter = await signIn('settings', ['settings:write']);
// What the chat-card migration hands an existing role that opens /chat (TODO #645).
const gitCard = await signIn('git-card', ['page:/chat', 'widget:git']);

const SLUG = 'no-such-project';
const READS = ['/api/docker', `/api/docker/${SLUG}`, '/api/grepai', `/api/grepai/${SLUG}`, '/api/orchestrator/self', '/api/video-factory/progress'];
const PROJECT_WRITES = [
  `/api/docker/${SLUG}/start`, `/api/docker/${SLUG}/stop`, `/api/docker/${SLUG}/restart`, `/api/docker/${SLUG}/rebuild`,
  `/api/grepai/${SLUG}/start`, `/api/grepai/${SLUG}/init`, `/api/grepai/${SLUG}/rebuild`, `/api/grepai/${SLUG}/stop`,
];
const SELF_WRITES = ['/api/orchestrator/self/restart', '/api/orchestrator/self/rebuild'];
// The repository reads behind the Git card (TODO #689); `/api/git-remote/:slug`
// is also what the project cards of /agents show.
const GIT_READS = [
  `/api/git-remote/${SLUG}`, `/api/git-remote/${SLUG}/remotes`, `/api/agents/nobody/git?slug=${SLUG}`,
  `/api/git/status?slug=${SLUG}`, `/api/git/worktrees?slug=${SLUG}`, `/api/git/log?slug=${SLUG}`,
  `/api/git/repos?slug=${SLUG}`,
];

test('an anonymous caller is refused everywhere', async () => {
  for (const path of READS) assert.equal((await call('GET', path)).status, 401, path);
  for (const path of [...PROJECT_WRITES, ...SELF_WRITES]) assert.equal((await call('POST', path)).status, 401, path);
});

test('the Employee preset reads nothing and drives nothing', async () => {
  for (const path of READS) assert.equal((await call('GET', path, { cookie: employe })).status, 403, path);
  for (const path of [...PROJECT_WRITES, ...SELF_WRITES]) assert.equal((await call('POST', path, { cookie: employe })).status, 403, path);
  assert.deepEqual(controlled, { restart: 0, rebuild: 0 }, 'the daemon was not touched');
});

test('the Employee preset and a role that only opens /agents do not read the repository', async () => {
  for (const path of GIT_READS) assert.equal((await call('GET', path, { cookie: employe })).status, 403, path);
  const [remote, ...rest] = GIT_READS;
  assert.notEqual((await call('GET', remote!, { cookie: projectsPage })).status, 403, remote);
  for (const path of rest) assert.equal((await call('GET', path, { cookie: projectsPage })).status, 403, path);
});

test('the Git card reads the repository; the superadmin too', async () => {
  // An unknown project: past the guard, the route answers its own error.
  for (const cookie of [gitCard, projectManager, adminCookie]) {
    for (const path of GIT_READS) assert.notEqual((await call('GET', path, { cookie })).status, 403, path);
  }
  assert.equal((await call('POST', '/api/git/checkout', { cookie: gitCard, body: { slug: SLUG, branch: 'main' } })).status, 403);
});

test('a card grant opens the reading, not the controls', async () => {
  for (const path of READS) assert.notEqual((await call('GET', path, { cookie: cardsOnly })).status, 403, path);
  for (const path of [...PROJECT_WRITES, ...SELF_WRITES]) assert.equal((await call('POST', path, { cookie: cardsOnly })).status, 403, path);
  assert.deepEqual(controlled, { restart: 0, rebuild: 0 });
});

test('the project cards of /agents keep reading the status they show', async () => {
  for (const path of ['/api/docker', `/api/docker/${SLUG}`, '/api/grepai', `/api/grepai/${SLUG}`]) {
    assert.notEqual((await call('GET', path, { cookie: projectsPage })).status, 403, path);
  }
  for (const path of ['/api/orchestrator/self', '/api/video-factory/progress']) {
    assert.equal((await call('GET', path, { cookie: projectsPage })).status, 403, path);
  }
  for (const path of PROJECT_WRITES) assert.equal((await call('POST', path, { cookie: projectsPage })).status, 403, path);
});

test('projects:manage drives the containers and the watchers, not the daemon', async () => {
  // An unknown project: past the guard, the route answers its own error.
  for (const path of PROJECT_WRITES) assert.notEqual((await call('POST', path, { cookie: projectManager })).status, 403, path);
  for (const path of SELF_WRITES) assert.equal((await call('POST', path, { cookie: projectManager })).status, 403, path);
  assert.deepEqual(controlled, { restart: 0, rebuild: 0 });
});

test('settings:write and the superadmin restart and rebuild the daemon', async () => {
  for (const cookie of [settingsWriter, adminCookie]) {
    const before = { ...controlled };
    assert.equal((await call('POST', '/api/orchestrator/self/restart', { cookie })).status, 200);
    assert.equal((await call('POST', '/api/orchestrator/self/rebuild', { cookie })).status, 200);
    assert.deepEqual(controlled, { restart: before.restart + 1, rebuild: before.rebuild + 1 });
  }
});
