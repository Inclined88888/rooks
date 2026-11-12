/**
 * `ctx.system`, `modules`, `license`, `docs`, `backup`, `browser`,
 * `plugins` — what each refuses (manifest, anonymous, account, job) before
 * what each does.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-plugin-system-'));
const docsDir = mkdtempSync(join(tmpdir(), 'rooks-plugin-docs-'));
process.env.ROOKS_DOCS_DIR = docsDir;
await import('../../tests/helpers/paid-license.js');
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

mkdirSync(join(docsDir, 'plugins'), { recursive: true });
writeFileSync(join(docsDir, 'index.json'), JSON.stringify({
  pages: [{ route: '/plugins/permissions', title: 'Permissions', description: 'What a plugin may ask', section: 'Plugins', file: 'plugins/permissions.md' }],
}));
writeFileSync(join(docsDir, 'plugins', 'permissions.md'), '# Permissions\n\nA plugin declares permissions.\n\n## Sensitive\n\nSecrets are sensitive.\n');

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError, PluginCallerError, PluginAdminError } = await import('./context.js');
const { pluginsAdminFor } = await import('./plugins-facade.js');
const { backupFor } = await import('./backup-facade.js');
const { runPluginRequest } = await import('./als.js');
const { dbApi } = await import('../db.js');
const { appendDatedLog } = await import('../log-file.js');
const { setRedactionSource } = await import('../secrets/redact.js');
const { ROOKS_HOME } = await import('../paths.js');

type Identity = Parameters<typeof runPluginRequest>[0];
const caller = (id: string, permissions: string[], isSuperadmin = false): Identity => ({
  viewer: { id, isSuperadmin, permissions },
  user: { id, email: `${id}@example.com`, name: id, is_superadmin: isSuperadmin },
  ownerUserId: id,
});
const plain = caller('ada', []);
const pluginManager = caller('pam', ['plugins:manage']);
const admin = caller('root', [], true);
const anonymous: Identity = { viewer: null, user: undefined, ownerUserId: null };
const as = <T>(who: Identity, fn: () => Promise<T>) => runPluginRequest(who, fn);

const fakeApp = (() => { const m = new Map<string, unknown>(); return { get: (k: string) => m.get(k), set: (k: string, v: unknown) => { m.set(k, v); } }; })();

async function pluginWith(permissions: string[], id = 'acme-system') {
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const res = readManifest({ rooks: { id, apiVersion: PLUGIN_API_VERSION, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  const base = daemonHost(root);
  const host = { ...base, admin: { ...base.admin!, plugins: (scope: Parameters<typeof pluginsAdminFor>[0]) => pluginsAdminFor(scope, { app: () => fakeApp }) } };
  const plugin = createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, host);
  return { plugin, dispose: () => root.fiber.dispose() };
}

const code = (c: string) => (err: unknown) => err instanceof PluginAdminError && err.code === c;

test('without a permission in the manifest every facade refuses', async () => {
  const { plugin, dispose } = await pluginWith(['storage']);
  const calls: Array<() => Promise<unknown>> = [
    () => plugin.system.health(), () => plugin.system.doctor(), () => plugin.system.logs(),
    () => plugin.modules.list(), () => plugin.license.edition(), () => plugin.docs.search('x'), () => plugin.docs.read('/x'),
    () => plugin.backup.status(), () => plugin.backup.enable(), () => plugin.browser.list(), () => plugin.browser.status('p'),
    () => plugin.browser.start('p'), () => plugin.browser.stop('p'),
    () => plugin.plugins.list(), () => plugin.plugins.setEnabled('x', false),
  ];
  for (const call of calls) await assert.rejects(as(admin, call), PluginPermissionError);
  await dispose();
});

test('an anonymous request is refused everywhere', async () => {
  const { plugin, dispose } = await pluginWith([
    'system:read', 'system:logs', 'plugins:read', 'plugins:manage', 'license:read', 'docs:read', 'backup:manage', 'browser:manage',
  ]);
  const calls: Array<() => Promise<unknown>> = [
    () => plugin.system.health(), () => plugin.system.doctor(), () => plugin.system.logs(), () => plugin.modules.list(),
    () => plugin.license.edition(), () => plugin.docs.search('x'), () => plugin.backup.status(), () => plugin.backup.enable(), () => plugin.browser.list(),
    () => plugin.plugins.list(), () => plugin.plugins.setEnabled('x', true),
  ];
  for (const call of calls) await assert.rejects(as(anonymous, call), PluginCallerError);
  await dispose();
});

test('license: the edition string and nothing else', async () => {
  const { plugin, dispose } = await pluginWith(['license:read']);
  const edition = await as(plain, () => plugin.license.edition());
  assert.ok(edition === 'lite' || edition === 'expert');
  assert.equal(await plugin.license.edition(), edition, 'a job reads it too');
  await dispose();
});

test('system: health for anyone signed in and for a job; doctor and logs need a superadmin request, logs never a job', async () => {
  const { plugin, dispose } = await pluginWith(['system:read', 'system:logs']);
  const health = await as(plain, () => plugin.system.health());
  assert.equal(health.ok, true);
  assert.equal((await plugin.system.health()).ok, true);
  await assert.rejects(as(plain, () => plugin.system.doctor()), PluginCallerError);
  assert.equal(typeof (await as(admin, () => plugin.system.doctor())).platform, 'string');
  assert.equal(typeof (await plugin.system.doctor()).platform, 'string', 'a job reads the doctor report');
  await assert.rejects(as(plain, () => plugin.system.logs()), PluginCallerError);
  await assert.rejects(plugin.system.logs(), PluginCallerError);
  await dispose();
});

test('system: logs come masked, newest first, never the prompts log', async () => {
  const { plugin, dispose } = await pluginWith(['system:logs']);
  const secret = 'secret-value-xyz-1234567';
  const previous = setRedactionSource(() => [secret]);
  try {
    appendDatedLog(ROOKS_HOME, 'daemon', `connected with ${secret} ok`);
    appendDatedLog(ROOKS_HOME, 'prompts', 'a prompt an agent was given');
    const lines = await as(admin, () => plugin.system.logs({ lines: 50 }));
    assert.ok(lines.some((l) => l.includes('connected with')));
    assert.ok(!lines.join('\n').includes(secret), 'vault values are masked');
    assert.ok(!lines.join('\n').includes('a prompt an agent was given'));
    await assert.rejects(as(admin, () => plugin.system.logs({ kind: 'prompts' } as never)), code('invalid'));
    await assert.rejects(as(admin, () => plugin.system.logs({ lines: 0 })), code('invalid'));
  } finally { setRedactionSource(previous); }
  await dispose();
});

test('modules: the bundled modules and their state', async () => {
  const { plugin, dispose } = await pluginWith(['plugins:read']);
  const modules = await as(plain, () => plugin.modules.list());
  const db = modules.find((m) => m.id === '@rooks/db');
  assert.equal(db?.tier, 'core');
  assert.equal(db?.active, true);
  await dispose();
});

test('docs: search and read the installed documentation, offline', async () => {
  const { plugin, dispose } = await pluginWith(['docs:read']);
  const hits = await as(plain, () => plugin.docs.search('permissions'));
  assert.equal(hits[0]?.route, '/plugins/permissions');
  const page = await plugin.docs.read('/plugins/permissions');
  assert.ok(page.includes('A plugin declares permissions.'));
  assert.ok((await plugin.docs.read('/plugins/permissions', 'Sensitive')).includes('Secrets are sensitive.'));
  await assert.rejects(plugin.docs.read('/nope'), code('not_found'));
  await assert.rejects(plugin.docs.search('a'), code('invalid'));
  await assert.rejects(plugin.docs.search(''), code('invalid'));
  await dispose();
});

test('backup: status names where every account\'s archives lie, so a request needs a superadmin (TODO #627)', async () => {
  for (const permissions of [['backup:read'], ['backup:manage']]) {
    const { plugin, dispose } = await pluginWith(permissions);
    // `*` is what a mission of a developer account holds, and it comes with the
    // superadmin flag: the account's rights alone never open this.
    for (const who of [plain, pluginManager, caller('wildcard', ['*'])]) {
      await assert.rejects(as(who, () => plugin.backup.status()), (err: unknown) => {
        assert.ok(err instanceof PluginCallerError);
        assert.ok(!err.message.includes(ROOKS_HOME), 'a refusal does not name the backups folder');
        return true;
      });
    }
    await assert.rejects(as(anonymous, () => plugin.backup.status()), PluginCallerError);
    assert.equal((await as(admin, () => plugin.backup.status())).dir, join(ROOKS_HOME, 'backups'));
    assert.equal((await plugin.backup.status()).dir, join(ROOKS_HOME, 'backups'), 'a job reads it, as it may enable it');
    await dispose();
  }
});

test('backup: the facade refuses by itself, whatever scope it is handed', () => {
  const ordinary = { pluginId: 'acme-system', job: false, viewer: plain.viewer, userId: 'ada', superadmin: false };
  assert.throws(() => backupFor(ordinary).status(), code('forbidden'));
  assert.throws(() => backupFor(ordinary).enable(), code('forbidden'));
  const job = { pluginId: 'acme-system', job: true, viewer: null, userId: null, superadmin: false };
  assert.equal(typeof backupFor(job).status().enabled, 'boolean');
});

test('backup: enable for a superadmin request or a job, leaving an audit row', async () => {
  const { plugin, dispose } = await pluginWith(['backup:read', 'backup:manage'], 'safety');
  await assert.rejects(as(plain, () => plugin.backup.enable()), PluginCallerError);
  await assert.rejects(as(pluginManager, () => plugin.backup.enable()), PluginCallerError);
  const status = await as(admin, () => plugin.backup.enable());
  assert.equal(status.enabled, true);
  assert.ok(!('routine' in status), 'the routine row is not returned');
  assert.ok(dbApi.listAuditLog(50).some((a) => a.action === 'backup.enable' && a.actor === 'plugin:safety'));
  assert.equal((await plugin.backup.enable()).enabled, true);
  await dispose();
});

test('backup: read-only permission cannot enable', async () => {
  const { plugin, dispose } = await pluginWith(['backup:read']);
  await assert.rejects(as(admin, () => plugin.backup.enable()), PluginPermissionError);
  await dispose();
});

test('browser: another account\'s session answers like a missing one and carries no debugging endpoint', async () => {
  const { plugin, dispose } = await pluginWith(['browser:read', 'browser:manage']);
  dbApi.upsertBrowserSession({
    project: 'alpha', containerName: 'rooks-browser-alpha', cdpPort: 9301, novncPort: 3000,
    status: 'running', startedAt: Date.now(), stoppedAt: null, ownerUserId: 'ada',
  });
  const mine = await as(plain, () => plugin.browser.list());
  assert.deepEqual(mine.map((s) => s.project), ['alpha']);
  assert.equal(mine[0]?.mine, true);
  // Values, not the JSON text: a timestamp (`1793010…`) holds the port's digits.
  assert.ok(!Object.values(mine[0]!).includes(9301) && !JSON.stringify(mine).includes('cdp') && !JSON.stringify(mine).includes('container'));
  const eve = caller('eve', []);
  assert.deepEqual(await as(eve, () => plugin.browser.list()), []);
  assert.equal(await as(eve, () => plugin.browser.status('alpha')), undefined);
  await assert.rejects(as(eve, () => plugin.browser.start('alpha')), code('not_found'));
  await assert.rejects(as(eve, () => plugin.browser.stop('alpha')), code('not_found'));
  await assert.rejects(as(eve, () => plugin.browser.status('')), code('invalid'));
  assert.deepEqual(await plugin.browser.list(), [], 'a job sees only what it started');
  await assert.rejects(as(plain, () => plugin.browser.start('no-such-project')), code('not_found'));
  await assert.rejects(plugin.browser.start('no-such-project'), code('not_found'));
  await dispose();
});

test('plugins: list through the curtain; a job lists everything', async () => {
  const { plugin, dispose } = await pluginWith(['plugins:read']);
  const all = await plugin.plugins.list();
  assert.ok(all.some((p) => p.id === '@rooks/db'));
  assert.ok(all.every((p) => !('settings' in p) && !('client' in p) && !('error' in p)));
  const seen = await as(plain, () => plugin.plugins.list());
  assert.ok(seen.length <= all.length);
  await assert.rejects(as(plain, () => plugin.plugins.setEnabled('@rooks/vault', false)), PluginPermissionError);
  await dispose();
});

test('plugins.setEnabled: never a job, never itself, a bundled module for plugins:manage, a third-party one for a superadmin', async () => {
  const { plugin, dispose } = await pluginWith(['plugins:read', 'plugins:manage'], 'switcher');
  await assert.rejects(plugin.plugins.setEnabled('@rooks/vault', false), PluginCallerError);
  await assert.rejects(as(plain, () => plugin.plugins.setEnabled('@rooks/vault', false)), code('forbidden'));
  await assert.rejects(as(pluginManager, () => plugin.plugins.setEnabled('switcher', false)), code('forbidden'));
  await assert.rejects(as(admin, () => plugin.plugins.setEnabled('switcher', false)), code('forbidden'));
  // A third-party plugin is a superadmin's call, even for the holder of plugins:manage.
  await assert.rejects(as(pluginManager, () => plugin.plugins.setEnabled('some-third-party', false)), code('forbidden'));
  await assert.rejects(as(admin, () => plugin.plugins.setEnabled('some-third-party', false)), code('not_found'));
  // A core module cannot be switched off, whoever asks.
  await assert.rejects(as(admin, () => plugin.plugins.setEnabled('@rooks/db', false)), code('forbidden'));
  assert.equal(await as(pluginManager, () => plugin.plugins.setEnabled('@rooks/vault', false)), true);
  assert.ok(dbApi.listAuditLog(50).some((a) => a.action === 'plugin.disable' && a.target === 'plugin:@rooks/vault' && a.actor === 'plugin:switcher'));
  assert.equal(await as(pluginManager, () => plugin.plugins.setEnabled('@rooks/vault', true)), true);
  await assert.rejects(as(admin, () => plugin.plugins.setEnabled('', true)), code('invalid'));
  await dispose();
});
