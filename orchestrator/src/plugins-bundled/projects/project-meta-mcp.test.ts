/**
 * #214 — the daemon side of the MCP tools `project_create` / `project_update` /
 * `workspace_list`: workspace validation, the cwd bound shared by create and
 * edit, and who may call. Real auth middleware, so "anonymous" is a true
 * anonymous (the stand-in of `workspaces.test.ts` lets a missing identity
 * through, which is the first-run hole).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../../../tests/helpers/accounts.js';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-project-meta-mcp-'));
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
const TOKEN = 'witness-daemon-token';
writeFileSync(join(process.env.ROOKS_HOME, 'daemon-token'), TOKEN, { encoding: 'utf8', mode: 0o600 });

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerProjects } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { getAgent } = await import('../../agent.js');
const { hashApiToken, issueMissionApiToken } = await import('../../users/api-tokens.js');
const { SETUP_ROLE_PRESETS } = await import('../../../tests/helpers/presets.js');
const { SESSION_COOKIE } = await import('../../users/session.js');

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerProjects(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness must not take the production port');
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; bearer?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
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
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { json = { raw: text }; }
  return { status: res.status, json };
}

const setup = await call('POST', '/api/auth/setup', {
  body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' },
});
assert.equal(setup.status, 201);
const adminId = (setup.json as { user: { id: string } }).user.id;
const created = await postTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', password: 'ada-secret' });
assert.equal(created.status, 201);
const adaId = (created.json as { user: { id: string } }).user.id;
const employeePreset = SETUP_ROLE_PRESETS.find((p) => p.key === 'employee');
assert.ok(employeePreset);
grantTestPermissions(dbApi, adaId, [...employeePreset.permissions]);

function missionToken(agent: string, userId: string): string {
  const id = randomUUID();
  dbApi.createMission(id, agent, 'work', undefined, userId);
  return issueMissionApiToken(id);
}
// Holds projects:manage through the cap, but is not a privileged caller.
const adminToken = missionToken('admin.agent', adminId);
// An employee: no projects:manage.
const adaToken = missionToken('ada.agent', adaId);
assert.ok(dbApi.getLiveApiToken(hashApiToken(adminToken)));

const dir = mkdtempSync(join(tmpdir(), 'rooks-project-meta-cwd-'));
const otherDir = mkdtempSync(join(tmpdir(), 'rooks-project-meta-cwd2-'));

test('an anonymous caller and a caller without projects:manage are refused', async () => {
  dbApi.insertWorkspace({ slug: 'locked', name: 'Locked', color: null, lead_agent: null });
  const anon = await call('PUT', '/api/projects/whatever/meta', { body: { workspace: 'Locked' } });
  assert.equal(anon.status, 401);
  assert.equal((await call('POST', '/api/projects', { body: { slug: 'anon-p' } })).status, 401);
  assert.equal((await call('GET', '/api/workspaces')).status, 401);

  const body = { slug: 'ada-p', workspace: 'Locked', workspace_policy: 'existing' };
  assert.equal((await call('POST', '/api/projects', { bearer: adaToken, body })).status, 403);
  assert.equal((await call('PUT', '/api/projects/ada-p/meta', { bearer: adaToken, body })).status, 403);
  assert.equal(dbApi.getProjectRow('ada-p'), undefined);
  assert.equal(dbApi.getProjectRow('anon-p'), undefined);
});

test('workspace_policy "existing" stores the canonical pole name and refuses a typo', async () => {
  dbApi.insertWorkspace({ slug: 'design-studio', name: 'Design Studio', color: null, lead_agent: null });
  const ok = await call('POST', '/api/projects', {
    bearer: adminToken,
    body: { slug: 'p-canon', workspace: 'design studio', speech: 'hello', workspace_policy: 'existing' },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(dbApi.getProjectRow('p-canon')?.workspace, 'Design Studio');
  assert.equal(dbApi.getProjectRow('p-canon')?.speech, 'hello');

  const typo = await call('POST', '/api/projects', {
    bearer: adminToken,
    body: { slug: 'p-typo', workspace: 'Desgn Studio', workspace_policy: 'existing' },
  });
  assert.equal(typo.status, 400);
  assert.match(String(typo.json.error), /unknown workspace "Desgn Studio".*Design Studio/);
  assert.equal(dbApi.getProjectRow('p-typo'), undefined, 'a refused request writes nothing');
  assert.equal(dbApi.getWorkspaceRow('agnce-ia'), undefined, 'and mints no pole');

  const edit = await call('PUT', '/api/projects/p-canon/meta', {
    bearer: adminToken,
    body: { workspace: 'DESIGN STUDIO', workspace_policy: 'existing' },
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.json));
  assert.equal(dbApi.getProjectRow('p-canon')?.workspace, 'Design Studio');
  const typoEdit = await call('PUT', '/api/projects/p-canon/meta', {
    bearer: adminToken,
    body: { workspace: 'Desgn Studio', workspace_policy: 'existing' },
  });
  assert.equal(typoEdit.status, 400);
  assert.equal(dbApi.getProjectRow('p-canon')?.workspace, 'Design Studio');
});

test('workspace_policy "create" makes the pole, once the project is written', async () => {
  const slugTaken = await call('POST', '/api/projects', {
    bearer: adminToken,
    body: { slug: 'p-canon', workspace: 'Brand New', workspace_policy: 'create' },
  });
  assert.equal(slugTaken.status, 400);
  assert.equal(dbApi.getWorkspaceRow('brand-new'), undefined, 'no orphan pole when the project is refused');

  const ok = await call('POST', '/api/projects', {
    bearer: adminToken,
    body: { slug: 'p-new-pole', workspace: 'Brand New', workspace_policy: 'create' },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const list = await call('GET', '/api/workspaces', { bearer: adminToken });
  const poles = list.json.workspaces as Array<{ slug: string; projects: string[] }>;
  assert.deepEqual(poles.find((w) => w.slug === 'brand-new')?.projects, ['p-new-pole']);
});

test('without a policy the legacy free-text behaviour is kept (UI dialog)', async () => {
  const r = await call('POST', '/api/projects', { bearer: adminToken, body: { slug: 'p-free', workspace: 'Whatever' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(dbApi.getProjectRow('p-free')?.workspace, 'Whatever');
});

test('fields are typed: a non-string or an oversize value is a 400', async () => {
  for (const body of [{ speech: 42 }, { workspace: 'x'.repeat(201) }, { cwd: ['/tmp'] }, { workspace_policy: 'yolo' }]) {
    const r = await call('PUT', '/api/projects/p-canon/meta', { bearer: adminToken, body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test('an unknown slug is a 404 on a strict edit and mints no ghost row', async () => {
  const r = await call('PUT', '/api/projects/no-such-project/meta', {
    bearer: adminToken,
    body: { speech: 'x', workspace_policy: 'existing' },
  });
  assert.equal(r.status, 404);
  assert.equal(dbApi.getProjectRow('no-such-project'), undefined);
});

test('a stored project can be saved again as the edit dialog does, whatever it already holds', async () => {
  const gone = mkdtempSync(join(tmpdir(), 'rooks-project-meta-gone-'));
  rmSync(gone, { recursive: true });
  dbApi.upsertProject('p-legacy', { name: 'N'.repeat(300), speech: 's'.repeat(5000), cwd: gone });
  dbApi.insertWorkspace({ slug: 'a-very-long-pole', name: 'P'.repeat(100), color: null, lead_agent: null });
  const dialogBody = {
    slug: 'p-legacy', name: 'N'.repeat(300), color: '#112233', speech: 's'.repeat(5000),
    workspace: 'P'.repeat(100), cwd: gone,
  };
  // The cookie of a human manager who is NOT superadmin: no privileged shortcut.
  const made = await postTestAccount(dbApi, { email: 'bob@example.com', name: 'Bob', password: 'bob-secret' });
  grantTestPermissions(dbApi, (made.json as { user: { id: string } }).user.id, ['projects:manage']);
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'bob@example.com', password: 'bob-secret' }),
  });
  assert.equal(login.status, 200);
  const cookie = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(login.headers.get('set-cookie') ?? '')?.[1];
  assert.ok(cookie);
  const session = decodeURIComponent(cookie);

  const saved = await call('PUT', '/api/projects/p-legacy/meta', { cookie: session, body: dialogBody });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const savedByAdmin = await call('PUT', '/api/projects/p-legacy/meta', { bearer: adminToken, body: dialogBody });
  assert.equal(savedByAdmin.status, 200, JSON.stringify(savedByAdmin.json));
  assert.equal(dbApi.getProjectRow('p-legacy')?.cwd, gone);
});

// #676: the window CSP (`img-src 'self' data: blob:`) never draws another
// origin, so a project logo is a picture the daemon serves or text, nothing else.
const SERVED_LOGO = '/api/uploads/projects/0b6f1c2e-1d3a-4c55-9e1f-2a3b4c5d6e7f.webp';
const REFUSED_ICONS = [
  'https://evil.example/logo.png',
  'http://evil.example/logo.png',
  ' https://evil.example/logo.png',
  'HTTPS://evil.example/logo.png',
  '//evil.example/logo.png',
  'data:image/png;base64,iVBORw0KGgo=',
  'javascript:alert(1)',
  'file:///etc/passwd',
  '/api/uploads/projects/../../daemon-token',
  '/api/uploads/projects/logo.svg',
  '\\\\evil\\share\\logo.png',
  'x'.repeat(33),
  'P\nK',
];

test('#676: a project icon given as a web address is refused on create and on edit, and nothing is stored', async () => {
  // Anonymous first: the shape check is no way around the auth.
  assert.equal((await call('POST', '/api/projects', { body: { slug: 'icon-anon', icon: '🚀' } })).status, 401);
  assert.equal(dbApi.getProjectRow('icon-anon'), undefined);

  for (const icon of REFUSED_ICONS) {
    const create = await call('POST', '/api/projects', { bearer: adminToken, body: { slug: 'icon-refused', icon } });
    assert.equal(create.status, 400, `create ${JSON.stringify(icon)}: ${JSON.stringify(create.json)}`);
    assert.match(String(create.json.error), /^icon: .*web address is refused/);
    assert.equal(dbApi.getProjectRow('icon-refused'), undefined, `no row for ${JSON.stringify(icon)}`);
  }

  const made = await call('POST', '/api/projects', { bearer: adminToken, body: { slug: 'icon-kept', icon: '🚀' } });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  for (const icon of REFUSED_ICONS) {
    const edit = await call('PUT', '/api/projects/icon-kept/meta', { bearer: adminToken, body: { icon } });
    assert.equal(edit.status, 400, `edit ${JSON.stringify(icon)}`);
    assert.equal(dbApi.getProjectRow('icon-kept')?.icon, '🚀', 'a refused edit leaves the logo alone');
  }
});

test('#676: an emoji, a short code, a picture Rooks serves and the empty "no logo" are accepted', async () => {
  for (const icon of ['👩🏽‍🚀', 'PK', '🇫🇷', SERVED_LOGO, '']) {
    const r = await call('PUT', '/api/projects/icon-kept/meta', { bearer: adminToken, body: { icon } });
    assert.equal(r.status, 200, `${JSON.stringify(icon)}: ${JSON.stringify(r.json)}`);
    assert.equal(dbApi.getProjectRow('icon-kept')?.icon, icon);
  }
});

test('#676: a web logo stored before the rule reads as no icon, and the dialog can save the project again', async () => {
  dbApi.upsertProject('icon-legacy', { name: 'Legacy', icon: 'https://evil.example/old.png' });
  const meta = await call('GET', '/api/projects/icon-legacy/meta', { bearer: adminToken });
  assert.equal(meta.status, 200);
  assert.equal((meta.json.meta as { icon: unknown }).icon, null);
  const list = await call('GET', '/api/projects', { bearer: adminToken });
  const row = (list.json.projects as Array<{ slug: string; icon?: unknown }>).find((p) => p.slug === 'icon-legacy');
  assert.equal(row?.icon, null);

  // The edit dialog sends back what it read: an empty logo, which clears the dead address.
  const saved = await call('PUT', '/api/projects/icon-legacy/meta', {
    bearer: adminToken, body: { slug: 'icon-legacy', name: 'Legacy', icon: '' },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(dbApi.getProjectRow('icon-legacy')?.icon, '');
});

test('cwd: absolute, existing, and not moved once registered', async () => {
  const rel = await call('POST', '/api/projects', { bearer: adminToken, body: { slug: 'p-rel', cwd: 'relative/dir' } });
  assert.equal(rel.status, 400);

  const first = await call('PUT', '/api/projects/p-canon/meta', { bearer: adminToken, body: { cwd: dir } });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(dbApi.getProjectRow('p-canon')?.cwd, dir);

  const same = await call('PUT', '/api/projects/p-canon/meta', { bearer: adminToken, body: { cwd: dir, speech: 'again' } });
  assert.equal(same.status, 200);

  const moved = await call('PUT', '/api/projects/p-canon/meta', { bearer: adminToken, body: { cwd: otherDir } });
  assert.equal(moved.status, 403, JSON.stringify(moved.json));
  assert.equal(dbApi.getProjectRow('p-canon')?.cwd, dir);

  const ghost = await call('PUT', '/api/projects/p-free/meta', { bearer: adminToken, body: { cwd: join(dir, 'nope') } });
  assert.equal(ghost.status, 403);
  assert.equal(dbApi.getProjectRow('p-free')?.cwd ?? null, null);
});

test('TIM-0083: a privileged caller may register a missing path and is warned, every time', async () => {
  const gone = join(dir, 'not-mounted');
  const create = await call('POST', '/api/projects', { bearer: TOKEN, body: { slug: 'p-warned', cwd: gone } });
  assert.equal(create.status, 200, JSON.stringify(create.json));
  assert.equal(dbApi.getProjectRow('p-warned')?.cwd, gone);
  const warnings = create.json.warnings as Array<{ field: string; error: string; code: string; path: string }>;
  assert.equal(warnings?.length, 1);
  assert.equal(warnings[0]?.field, 'cwd');
  assert.equal(warnings[0]?.error, 'missing');
  assert.equal(warnings[0]?.code, 'ENOENT');
  assert.equal(warnings[0]?.path, gone);

  // The edit dialog sends the stored cwd back: it is revalidated, not skipped.
  const again = await call('PUT', '/api/projects/p-warned/meta', { bearer: TOKEN, body: { cwd: gone, speech: 'again' } });
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.equal((again.json.warnings as unknown[] | undefined)?.length, 1);

  const fixed = await call('PUT', '/api/projects/p-warned/meta', { bearer: TOKEN, body: { cwd: dir } });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.json));
  assert.equal('warnings' in fixed.json, false);
});

test('TIM-0083: a file is not a directory; a relative path stays a 400 for a privileged caller', async () => {
  const file = join(dir, 'a-file.txt');
  writeFileSync(file, 'x');
  const onFile = await call('POST', '/api/projects', { bearer: TOKEN, body: { slug: 'p-on-file', cwd: file } });
  assert.equal(onFile.status, 200, JSON.stringify(onFile.json));
  assert.equal((onFile.json.warnings as Array<{ error: string }>)[0]?.error, 'not-a-directory');

  const rel = await call('POST', '/api/projects', { bearer: TOKEN, body: { slug: 'p-rel-priv', cwd: 'relative/dir' } });
  assert.equal(rel.status, 400);
});

test('TIM-0083: a non-privileged caller is still refused a missing path, but may re-save a stored one', async () => {
  const gone = join(dir, 'also-gone');
  const refused = await call('POST', '/api/projects', { bearer: adminToken, body: { slug: 'p-refused', cwd: gone } });
  assert.equal(refused.status, 403);
  assert.equal(dbApi.getProjectRow('p-refused'), undefined);

  dbApi.upsertProject('p-stored-gone', { cwd: gone });
  const resave = await call('PUT', '/api/projects/p-stored-gone/meta', { bearer: adminToken, body: { cwd: gone, speech: 'x' } });
  assert.equal(resave.status, 200, JSON.stringify(resave.json));
  assert.equal((resave.json.warnings as Array<{ error: string }>)[0]?.error, 'missing');
});

test('with_orchestrator seeds the project\'s orchestrator once, and only on request', async () => {
  const plainDir = mkdtempSync(join(tmpdir(), 'rooks-project-plain-'));
  const plain = await call('POST', '/api/projects', { bearer: adminToken, body: { slug: 'p-plain', cwd: plainDir } });
  assert.equal(plain.status, 200, JSON.stringify(plain.json));
  assert.equal('orchestrator' in plain.json, false);
  assert.equal(getAgent('p-plain.main'), null);

  const teamDir = mkdtempSync(join(tmpdir(), 'rooks-project-team-'));
  const team = await call('POST', '/api/projects', { bearer: adminToken, body: { slug: 'p-team', cwd: teamDir, with_orchestrator: true } });
  assert.equal(team.status, 200, JSON.stringify(team.json));
  assert.equal(team.json.orchestrator, 'p-team.main');
  assert.equal(getAgent('p-team.main')?.role, 'orchestrator');
  assert.equal(getAgent('p-team.main')?.cwd, teamDir);

  assert.equal((await call('POST', '/api/projects', { bearer: adminToken, body: { slug: 'p-bad', with_orchestrator: 'yes' } })).status, 400);
});
