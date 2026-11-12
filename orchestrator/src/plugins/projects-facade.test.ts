/**
 * `ctx.projects` — a plugin lists, registers and edits projects within the
 * rights of the account that acts, and hears about every project write.
 * Refusals come first: manifest, anonymous, account without the right, a
 * project the plugin did not register, a path the daemon cannot use.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-plugin-projects-'));
await import('../../tests/helpers/paid-license.js');
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError, PluginCallerError, PluginProjectError } = await import('./context.js');
const { runPluginRequest } = await import('./als.js');
const { dbApi } = await import('../db.js');
const { createProjectFromBody, updateProjectFromBody } = await import('../project-service.js');
const { createWorkspace } = await import('../workspaces.js');
const { readMeta } = await import('../projects.js');
const { createDemoProject } = await import('../project-demo.js');

const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();

type Identity = Parameters<typeof runPluginRequest>[0];
const caller = (id: string, permissions: string[], isSuperadmin = false): Identity => ({
  viewer: { id, isSuperadmin, permissions },
  user: { id, email: `${id}@example.com`, name: id, is_superadmin: isSuperadmin },
  ownerUserId: id,
});
const manager = caller('ada', ['projects:manage']);
const reader = caller('rita', []);
const admin = caller('root', [], true);
const anonymous: Identity = { viewer: null, user: undefined, ownerUserId: null };
const as = <T>(who: Identity, fn: () => Promise<T>) => runPluginRequest(who, fn);

async function pluginWith(permissions: string[], id = 'acme-projects') {
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const res = readManifest({ rooks: { id, apiVersion: PLUGIN_API_VERSION, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  const plugin = createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, daemonHost(root));
  return { plugin, dispose: () => root.fiber.dispose() };
}

const code = (c: string) => (err: unknown) => err instanceof PluginProjectError && err.code === c;
const dir = () => mkdtempSync(join(tmpdir(), 'rooks-plugin-projects-cwd-'));
const userOrigin = { kind: 'user', id: 'ada' } as const;

// A project nobody registered through a plugin: a human's.
createProjectFromBody({ slug: 'human', name: 'Human project', cwd: dir() }, { privileged: true, origin: userOrigin });

test('without `projects:*` in the manifest the facade refuses', async () => {
  const { plugin, dispose } = await pluginWith(['storage']);
  await assert.rejects(as(manager, () => plugin.projects.list()), PluginPermissionError);
  await assert.rejects(as(manager, () => plugin.projects.get('human')), PluginPermissionError);
  await assert.rejects(as(manager, () => plugin.projects.create({ slug: 'no-perm' })), PluginPermissionError);
  await assert.rejects(as(manager, () => plugin.projects.update('human', { name: 'x' })), PluginPermissionError);
  await assert.rejects(as(manager, () => plugin.projects.workspaces()), PluginPermissionError);
  await assert.rejects(as(manager, () => plugin.projects.roles('human')), PluginPermissionError);
  await assert.rejects(as(manager, () => plugin.projects.setRole('human', 'code', null)), PluginPermissionError);
  await dispose();
});

test('`projects:read` reads but does not write, and hides the working directory', async () => {
  const { plugin, dispose } = await pluginWith(['projects:read']);
  const list = await as(reader, () => plugin.projects.list());
  const human = list.find((p) => p.slug === 'human');
  assert.ok(human);
  assert.equal(human.cwd, null, 'a reader never sees a host path');
  assert.equal(human.mine, false);
  assert.equal((await as(reader, () => plugin.projects.get('human')))?.name, 'Human project');
  assert.equal(await as(reader, () => plugin.projects.get('nope')), undefined);
  assert.ok(Array.isArray(await as(reader, () => plugin.projects.workspaces())));
  await assert.rejects(as(manager, () => plugin.projects.create({ slug: 'read-only' })), PluginPermissionError);
  await assert.rejects(as(manager, () => plugin.projects.update('human', { name: 'x' })), PluginPermissionError);
  assert.equal(dbApi.getProjectRow('read-only'), undefined);
  await dispose();
});

test('an anonymous request is refused', async () => {
  const { plugin, dispose } = await pluginWith(['projects:manage']);
  await assert.rejects(as(anonymous, () => plugin.projects.list()), PluginCallerError);
  await assert.rejects(as(anonymous, () => plugin.projects.create({ slug: 'anon' })), PluginCallerError);
  assert.equal(dbApi.getProjectRow('anon'), undefined);
  await dispose();
});

test('an account without `projects:manage` cannot write, even when the plugin holds the permission', async () => {
  const { plugin, dispose } = await pluginWith(['projects:manage']);
  await assert.rejects(as(reader, () => plugin.projects.create({ slug: 'sneaky' })), PluginCallerError);
  await assert.rejects(as(reader, () => plugin.projects.update('human', { name: 'hijack' })), PluginCallerError);
  await assert.rejects(as(reader, () => plugin.projects.setRole('human', 'code', null)), PluginCallerError);
  assert.equal(dbApi.getProjectRow('sneaky'), undefined);
  assert.equal(readMeta('human').name, 'Human project');
  await dispose();
});

test('create marks the origin, returns the cwd to a manager, and refuses a duplicate', async () => {
  const { plugin, dispose } = await pluginWith(['projects:manage']);
  const cwd = dir();
  const made = await as(manager, () => plugin.projects.create({ slug: 'acme-app', name: 'Acme', cwd, speech: 'pitch' }));
  assert.equal(made.project.createdBy, 'plugin:acme-projects');
  assert.equal(made.project.mine, true);
  assert.equal(made.project.cwd, cwd);
  assert.deepEqual(made.warnings, []);
  assert.equal(dbApi.getProjectRow('acme-app')?.created_by, 'plugin:acme-projects');
  await assert.rejects(as(manager, () => plugin.projects.create({ slug: 'acme-app' })), code('invalid'));
  await assert.rejects(as(manager, () => plugin.projects.create({ slug: 'bad slug!' })), code('invalid'));
  // `created_by` is not an input: nothing a caller sends reaches the mark.
  await assert.rejects(
    as(manager, () => plugin.projects.create({ slug: 'forged', createdBy: 'plugin:other' } as never)),
    code('invalid'),
  );
  assert.equal(dbApi.getProjectRow('forged'), undefined);
  await dispose();
});

test('a path the daemon cannot use is refused, for a manager and for a job; a superadmin gets a warning', async () => {
  const { plugin, dispose } = await pluginWith(['projects:manage']);
  const ghost = join(tmpdir(), 'rooks-no-such-dir-xyz');
  await assert.rejects(as(manager, () => plugin.projects.create({ slug: 'ghost-a', cwd: ghost })), code('forbidden'));
  await assert.rejects(plugin.projects.create({ slug: 'ghost-b', cwd: ghost }), code('forbidden'));
  await assert.rejects(as(manager, () => plugin.projects.create({ slug: 'ghost-c', cwd: 'relative/path' })), code('invalid'));
  assert.equal(dbApi.getProjectRow('ghost-a'), undefined);
  assert.equal(dbApi.getProjectRow('ghost-b'), undefined);
  const lenient = await as(admin, () => plugin.projects.create({ slug: 'ghost-admin', cwd: ghost }));
  assert.equal(lenient.warnings.length, 1);
  assert.equal(lenient.warnings[0]!.field, 'cwd');
  await dispose();
});

test('a job sets no working directory, so it cannot widen the roots agents may use', async () => {
  const { plugin, dispose } = await pluginWith(['projects:manage']);
  await assert.rejects(plugin.projects.create({ slug: 'job-root', cwd: dir() }), code('forbidden'));
  await assert.rejects(plugin.projects.create({ slug: 'job-root', cwd: tmpdir() }), code('forbidden'));
  assert.equal(dbApi.getProjectRow('job-root'), undefined);
  const made = await plugin.projects.create({ slug: 'job-nocwd' });
  assert.equal(made.project.mine, true);
  await assert.rejects(plugin.projects.update('job-nocwd', { cwd: dir() }), code('forbidden'));
  assert.equal(readMeta('job-nocwd').cwd, null);
  // A person behind the request keeps the route's behaviour.
  assert.equal((await as(manager, () => plugin.projects.update('job-nocwd', { cwd: dir() }))).project.slug, 'job-nocwd');
  await dispose();
});

test('a plugin edits only the projects it registered; another plugin, a human project and a job-vs-request split all answer forbidden', async () => {
  const { plugin, dispose } = await pluginWith(['projects:manage'], 'acme-projects');
  const other = await pluginWith(['projects:manage'], 'other-projects');
  await as(manager, () => plugin.projects.create({ slug: 'mine-1', name: 'Mine' }));

  const renamed = await as(manager, () => plugin.projects.update('mine-1', { name: 'Renamed', speech: 'new pitch' }));
  assert.equal(renamed.project.name, 'Renamed');
  assert.equal(readMeta('mine-1').speech, 'new pitch');

  await assert.rejects(as(manager, () => plugin.projects.update('human', { name: 'hijack' })), code('forbidden'));
  await assert.rejects(as(manager, () => other.plugin.projects.update('mine-1', { name: 'stolen' })), code('forbidden'));
  await assert.rejects(as(manager, () => plugin.projects.update('missing', { name: 'x' })), code('not_found'));
  await assert.rejects(as(manager, () => plugin.projects.setRole('human', 'code', { agent: 'x' })), code('forbidden'));
  assert.equal(readMeta('human').name, 'Human project');

  // A job acts as `plugin:<id>`: its own project yes, a human's no.
  assert.equal((await plugin.projects.update('mine-1', { name: 'By job' })).project.name, 'By job');
  await assert.rejects(plugin.projects.update('human', { name: 'job hijack' }), code('forbidden'));

  // A superadmin lifts the ownership rule.
  assert.equal((await as(admin, () => plugin.projects.update('human', { speech: 'by admin' }))).project.slug, 'human');
  await other.dispose();
  await dispose();
});

test('the cwd of a registered project is not moved from here, and an empty one can be set', async () => {
  const { plugin, dispose } = await pluginWith(['projects:manage']);
  const first = dir();
  await as(manager, () => plugin.projects.create({ slug: 'cwd-pin', cwd: first }));
  await assert.rejects(as(manager, () => plugin.projects.update('cwd-pin', { cwd: dir() })), code('forbidden'));
  assert.equal(readMeta('cwd-pin').cwd, first);
  await as(manager, () => plugin.projects.create({ slug: 'cwd-late' }));
  const later = dir();
  assert.equal((await as(manager, () => plugin.projects.update('cwd-late', { cwd: later }))).project.cwd, later);
  await dispose();
});

test('#676: an icon is an emoji, a short code or a picture Rooks serves; a web address is refused and a stored one reads as none', async () => {
  const { plugin, dispose } = await pluginWith(['projects:manage']);
  await assert.rejects(
    as(manager, () => plugin.projects.create({ slug: 'icon-web', icon: 'https://evil.example/logo.png' })),
    code('invalid'),
  );
  assert.equal(dbApi.getProjectRow('icon-web'), undefined);
  const made = await as(manager, () => plugin.projects.create({ slug: 'icon-ok', icon: '🚀' }));
  assert.equal(made.project.icon, '🚀');
  await assert.rejects(as(manager, () => plugin.projects.update('icon-ok', { icon: 'data:image/png;base64,AAAA' })), code('invalid'));
  assert.equal(dbApi.getProjectRow('icon-ok')?.icon, '🚀');
  const served = '/api/uploads/projects/0b6f1c2e-1d3a-4c55-9e1f-2a3b4c5d6e7f.png';
  assert.equal((await as(manager, () => plugin.projects.update('icon-ok', { icon: served }))).project.icon, served);
  dbApi.upsertProject('icon-ok', { icon: 'https://evil.example/old.png' });
  assert.equal((await as(manager, () => plugin.projects.get('icon-ok')))?.icon, null);
  await dispose();
});

test('a workspace must exist unless `createWorkspace` is passed; unknown fields are refused', async () => {
  const { plugin, dispose } = await pluginWith(['projects:manage']);
  createWorkspace({ name: 'Design Studio' });
  await assert.rejects(as(manager, () => plugin.projects.create({ slug: 'ws-typo', workspace: 'Desing Studio' })), code('invalid'));
  assert.equal(dbApi.getProjectRow('ws-typo'), undefined);
  const made = await as(manager, () => plugin.projects.create({ slug: 'ws-ok', workspace: 'design studio' }));
  assert.equal(made.project.workspace, 'Design Studio', 'the stored name is the pole’s own');
  const fresh = await as(manager, () => plugin.projects.create({ slug: 'ws-new', workspace: 'Brand New', createWorkspace: true }));
  assert.equal(fresh.project.workspace, 'Brand New');
  assert.ok((await as(manager, () => plugin.projects.workspaces())).some((w) => w.name === 'Brand New' && w.projects.includes('ws-new')));
  await assert.rejects(as(manager, () => plugin.projects.update('ws-ok', { slug: 'renamed' } as never)), code('invalid'));
  await dispose();
});

test('role pins: read back, clear, and never more than the writer may hold', async () => {
  const { plugin, dispose } = await pluginWith(['projects:manage']);
  await as(manager, () => plugin.projects.create({ slug: 'roles-app' }));
  assert.deepEqual(await as(manager, () => plugin.projects.roles('roles-app')), {});
  const pinned = await as(manager, () => plugin.projects.setRole('roles-app', 'review', { agent: 'Jean-Pierre', permissionMode: 'plan' }));
  assert.deepEqual(pinned.review, { agent: 'Jean-Pierre', permissionMode: 'plan' });
  assert.deepEqual((await as(reader, async () => (await pluginWith(['projects:read'])).plugin.projects.roles('roles-app'))).review?.agent, 'Jean-Pierre');

  await assert.rejects(as(manager, () => plugin.projects.setRole('roles-app', 'code', { agent: 'x', permissionMode: 'bypassPermissions' })), code('forbidden'));
  await assert.rejects(plugin.projects.setRole('roles-app', 'code', { agent: 'x', permissionMode: 'bypassPermissions' }), code('forbidden'));
  await assert.rejects(as(manager, () => plugin.projects.setRole('roles-app', 'code', { agent: 'x', force: true } as never)), code('invalid'));
  await assert.rejects(as(manager, () => plugin.projects.setRole('roles-app', 'wizard', { agent: 'x' })), code('invalid'));
  await assert.rejects(as(manager, () => plugin.projects.roles('missing')), code('not_found'));
  assert.equal(await as(admin, () => plugin.projects.setRole('roles-app', 'code', { agent: 'x', permissionMode: 'bypassPermissions' })).then((r) => r.code?.permissionMode), 'bypassPermissions');

  const cleared = await as(manager, () => plugin.projects.setRole('roles-app', 'review', null));
  assert.equal(cleared.review, undefined);
  await dispose();
});

test('project events carry the writer, reach a reader, and need `projects:read`', async () => {
  const { plugin, dispose } = await pluginWith(['projects:manage', 'events:subscribe']);
  const bare = await pluginWith(['events:subscribe']);
  assert.throws(() => bare.plugin.events.on('project_created', () => { /* never */ }), PluginPermissionError);

  const seen: Array<{ kind: string; slug: string; origin: { kind: string; id: string | null }; changed?: readonly string[]; cwd: string | null }> = [];
  plugin.events.on('project_created', (ev) => { seen.push({ kind: ev.kind, slug: ev.slug, origin: ev.origin, cwd: ev.project.cwd }); });
  plugin.events.on('project_updated', (ev) => { seen.push({ kind: ev.kind, slug: ev.slug, origin: ev.origin, changed: ev.changed, cwd: ev.project.cwd }); });

  await as(manager, () => plugin.projects.create({ slug: 'evt-mine', cwd: dir() }));
  createProjectFromBody({ slug: 'evt-human' }, { privileged: true, origin: userOrigin });
  updateProjectFromBody('evt-human', { speech: 'hi' }, { privileged: true, origin: { kind: 'agent', id: 'Jean-Pierre' } });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.deepEqual(seen.map((e) => [e.kind, e.slug, e.origin.kind, e.origin.id]), [
    ['project_created', 'evt-mine', 'plugin', 'acme-projects'],
    ['project_created', 'evt-human', 'user', 'ada'],
    ['project_updated', 'evt-human', 'agent', 'Jean-Pierre'],
  ]);
  assert.deepEqual(seen[2]!.changed, ['speech']);
  createDemoProject({ origin: { kind: 'user', id: 'ada' } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(seen.slice(3).map((e) => [e.kind, e.slug, e.origin.id]), [['project_created', 'rooks-demo', 'ada']]);
  assert.ok(seen.every((e) => e.cwd === null), 'an event never carries a host path');
  await bare.dispose();
  await dispose();
});
