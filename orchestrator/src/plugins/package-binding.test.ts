/**
 * TODO #671: what is granted to a plugin names its id, and a package can leave
 * without `timon plugin remove`. The next package under that id must inherit
 * nothing; the same package, updated, must lose nothing.
 *
 * Real loader, real config file, real vault, real `integrations.db` handle as the
 * daemon holds it. The package's own `apply` takes a snapshot of what it would
 * reach: a test only reading the state after the pass would miss a package that
 * mounts first and is cleaned up afterwards.
 */
import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign as signCrypto } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import type { NpmRunner } from './install.js';
import type { StoredUserConnection } from './user-connections.js';
import type { PluginPackage } from './package-binding.js';

const { CONFIG_FILE, config, loadConfig, resetConfig } = await import('../config/load.js');
const { dbApi } = await import('../db.js');
const { agentDir, INTEGRATIONS_DB_PATH, pluginDataDir } = await import('../paths.js');
const { createRoutine } = await import('../routines.js');
const { resolveMasterKey } = await import('../secrets/key.js');
const { readPluginSecret, sealPluginKvValue } = await import('../secrets/plugins.js');
const { createSecret, getSecret } = await import('../secrets/store.js');
const { daemonHost } = await import('./context.js');
const { addPlugin, removePlugin } = await import('./install.js');
const { PluginInstallSources } = await import('./install-sources.js');
const { IntegrationStore } = await import('./integration-store.js');
const { PluginLoader } = await import('./loader.js');
const { PLUGIN_API_VERSION } = await import('./manifest.js');
const { DestinationRefusedError } = await import('./net-guard.js');
const {
  boundPluginPackage, keepsPluginData, PLUGIN_DATA_TRASH_DIR, pluginPackageChanged, pluginTakeoverCardWritten, settlePluginPackage, signsUnsignedCopy,
} = await import('./package-binding.js');
const {
  assertFetchAllowed, assertSpawnApproved, grantedKanbanProjects, narrowLivePluginGrants, pluginHttpHosts, resetPluginPolicyState,
} = await import('./policy.js');
const { hashPluginDirectory } = await import('./signature.js');
const { daemonUserConnectionHost } = await import('./user-connections-host.js');
const { UserConnectionService, UserConnectionStore } = await import('./user-connections.js');

resolveMasterKey({ keyring: null });
mkdirSync(agentDir('worker'), { recursive: true });

const pair = generateKeyPairSync('ed25519');
const KEYS = [{ keyId: 'test-binding', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }];

const WORK = mkdtempSync(join(tmpdir(), 'timon-binding-'));
let serial = 0;

type ApplyContext = {
  settings: { get(key: string): unknown };
  storage: { readonly dir: string };
  effect(fn: () => () => void): unknown;
};
type Apply = (pkg: string, ctx: ApplyContext) => void;
const onApply: { current: Apply } = { current: () => {} };
(globalThis as unknown as { __bindingApply: Apply }).__bindingApply = (pkg, ctx) => onApply.current(pkg, ctx);

type Manifest = Record<string, unknown>;
/** A package folder outside the plugins tree: what would be published. */
function packageSource(pkg: string, id: string, opts: { version?: string; signed?: boolean; manifest?: Manifest } = {}): string {
  const dir = join(WORK, `src-${++serial}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: pkg, version: opts.version ?? '1.0.0', type: 'module', main: 'index.js',
    timon: { id, apiVersion: PLUGIN_API_VERSION, kind: 'behavior', label: id, permissions: [], ...(opts.manifest ?? {}) },
  }));
  writeFileSync(join(dir, 'index.js'), `export function apply(ctx) { globalThis.__bindingApply(${JSON.stringify(pkg)}, ctx); }\n`);
  if (opts.signed) {
    const hash = hashPluginDirectory(dir);
    writeFileSync(join(dir, 'SIGNATURE'), JSON.stringify({
      alg: 'ed25519', keyId: 'test-binding', hash, sig: signCrypto(null, Buffer.from(hash, 'hex'), pair.privateKey).toString('base64'),
    }));
  }
  return dir;
}

function newRoot(): string {
  const root = join(WORK, `plugins-${++serial}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'timon-plugins', private: true, dependencies: {} }));
  return root;
}
const rootJson = (root: string) => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
function install(root: string, source: string): void {
  const { name } = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { name: string };
  const dest = join(root, 'node_modules', name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(source, dest, { recursive: true });
  const json = rootJson(root);
  json.dependencies[name] = `file:${source}`;
  writeFileSync(join(root, 'package.json'), JSON.stringify(json));
}
/** The folder deleted and the line removed: no `timon plugin remove`, so no purge. */
function removeByHand(root: string, pkg: string): void {
  rmSync(join(root, 'node_modules', pkg), { recursive: true, force: true });
  const json = rootJson(root);
  delete json.dependencies[pkg];
  writeFileSync(join(root, 'package.json'), JSON.stringify(json));
}
const fakeNpm: NpmRunner = async (args) => {
  const root = args[args.indexOf('--prefix') + 1]!;
  install(root, args[args.length - 1]!);
};

/** Passes against the given loader options, as the daemon wires them. */
async function daemonLoader(root: string, opts: { allowUnsigned?: boolean; settle?: (id: string, pkg: PluginPackage) => void } = {}) {
  const ctx = new Context();
  const loader = new PluginLoader(ctx, {
    dir: root,
    host: daemonHost(ctx),
    plugins: () => ({}),
    builtins: () => [],
    publicKeys: KEYS,
    allowUnsigned: () => opts.allowUnsigned ?? true,
    beforePass: () => narrowLivePluginGrants(),
    settlePackage: opts.settle ?? ((id, pkg) => { settlePluginPackage(id, pkg); }),
  });
  return { loader, stop: async () => { await loader.dispose(); await ctx.fiber.dispose(); } };
}

function connectionOwner(pluginIds: string[]): string {
  const id = randomUUID();
  createTestAccount(dbApi, { id, email: `${id}@example.test`, name: id, passwordHash: 'unused', status: 'active' });
  grantTestPermissions(dbApi, id, pluginIds.map((pluginId) => `plugin:${pluginId}`));
  return id;
}

/** The daemon's own handle on the real file. */
function daemonConnections() {
  const store = new IntegrationStore(INTEGRATIONS_DB_PATH);
  const connections = new UserConnectionStore(store.db);
  const host = daemonUserConnectionHost();
  const service = new UserConnectionService(connections, host);
  const seed = (pluginId: string, ownerUserId: string, origin: string) => {
    const id = randomUUID();
    connections.insert({
      id, pluginId, type: `${pluginId}:gateway@1`, identity: { ownerUserId } as StoredUserConnection['identity'], label: 'Gateway',
      url: `${origin}/v1`, origin, allowPrivateNetwork: true, config: {}, secrets: ['apiKey'], approval: 'approved', enabled: true, revision: 1,
      approvedBy: 'test-admin', approvedAt: 1, createdAt: 1, updatedAt: 1,
    });
    host.writeSecret(pluginId, `@connections/${id}/apiKey`, `key-of-${id}`);
    return id;
  };
  return { service, connections, seed, close: () => store.close() };
}

/** The operator's file AND this process's copy, as a daemon booted on it holds them. */
async function withGrants(ids: { id: string; other: string; hostOf: (id: string) => string }, run: () => Promise<void>): Promise<void> {
  const saved = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf8') : null;
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify({
    pluginPolicy: {
      spawn: { approved: [ids.id, ids.other] },
      kanban: { projects: { [ids.id]: ['alpha'], [ids.other]: ['beta'] } },
      http: { byPlugin: { [ids.id]: [ids.hostOf(ids.id)], [ids.other]: [ids.hostOf(ids.other)] } },
    },
  }, null, 2));
  resetConfig();
  resetPluginPolicyState();
  try {
    await run();
  } finally {
    if (saved === null) rmSync(CONFIG_FILE, { force: true }); else writeFileSync(CONFIG_FILE, saved);
    resetConfig();
    resetPluginPolicyState();
  }
}

const canSpawn = (id: string): boolean => {
  try { assertSpawnApproved(id); return true; } catch { return false; }
};
const canFetch = (id: string, url: string): boolean => {
  try { assertFetchAllowed(id, url); return true; } catch { return false; }
};
const hostName = (id: string) => `api.${id}.example`;
const newIds = () => {
  const n = ++serial;
  return { id: `binding-${n}`, other: `binding-other-${n}`, hostOf: hostName };
};

test('another package under the id of one deleted by hand inherits nothing, from its very first line', async () => {
  const ids = newIds();
  const { id, other } = ids;
  await withGrants(ids, async () => {
    const root = newRoot();
    const daemon = daemonConnections();
    const owner = connectionOwner([id, other]);
    const origin = `https://${id}.example`;
    const connection = daemon.seed(id, owner, origin);
    const stranger = daemon.seed(other, owner, origin);
    const SECRET = `TOKEN_${serial}`;
    const secret = createSecret({ name: SECRET, value: 'the-value', grants: [`agent:plugin:${id}`, `agent:plugin:${other}`] }).id;
    const routine = createRoutine({ name: `r-${id}`, agent_name: 'worker', prompt: 'p', cron_expr: '0 9 * * *', ownerUserId: `plugin:${id}` });
    const strangerRoutine = createRoutine({ name: `r-${other}`, agent_name: 'worker', prompt: 'p', cron_expr: '0 9 * * *', ownerUserId: `plugin:${other}` });

    const first = await daemonLoader(root);
    install(root, packageSource('@acme/first', id));
    await first.loader.update();
    // The first package seen under an id adopts what is there: an upgrade costs nobody a grant.
    assert.deepEqual(boundPluginPackage(id), { pkg: '@acme/first', trust: 'unsigned' });
    assert.equal(readPluginSecret(id, SECRET), 'the-value');
    assert.equal(canSpawn(id), true);
    assert.equal(daemon.service.secret(id, owner, connection, 'apiKey'), `key-of-${connection}`);
    assert.deepEqual(daemon.service.destination(id, new URL(`${origin}/x`)), { allowPrivateNetwork: true });

    removeByHand(root, '@acme/first');
    await first.loader.update();
    await first.stop();
    // Nothing moved yet: a package leaving the disk proves nothing (a removal in flight, an update).
    assert.equal(readPluginSecret(id, SECRET), 'the-value');
    assert.equal(daemon.connections.get(connection)?.approval, 'approved');

    const seen: Array<Record<string, unknown>> = [];
    onApply.current = (pkg) => {
      seen.push({
        pkg,
        secret: readPluginSecret(id, SECRET),
        spawn: canSpawn(id),
        kanban: [...grantedKanbanProjects(id)],
        hosts: pluginHttpHosts(id),
        destination: daemon.service.destination(id, new URL(`${origin}/x`)),
        key: daemon.service.secret(id, owner, connection, 'apiKey'),
      });
    };
    const second = await daemonLoader(root);
    install(root, packageSource('@mallory/second', id));
    const records = await second.loader.update();
    onApply.current = () => {};

    assert.equal(records.find((r) => r.id === id)?.state, 'active');
    assert.deepEqual(seen, [{
      pkg: '@mallory/second', secret: undefined, spawn: false, kanban: [], hosts: [], destination: undefined, key: undefined,
    }], 'nothing reaches the first line of the new package');

    await assert.rejects(daemon.service.fetch(id, `${origin}/x`), DestinationRefusedError);
    assert.equal(canFetch(id, `https://${hostName(id)}/`), false);
    const row = daemon.connections.get(connection);
    assert.equal(row?.approval, 'pending');
    assert.deepEqual(row?.secrets, []);
    assert.equal(row?.url, `${origin}/v1`, 'the connection stays, it is its owner\'s');
    assert.deepEqual(dbApi.pluginKvList(id, '@connections/'), [], 'no sealed key left behind');
    assert.equal(dbApi.getRoutine(routine.id)!.enabled, 0, 'nobody answers for its routines any more');

    const file = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as { pluginPolicy: { spawn: { approved: string[] }; kanban: { projects: Record<string, string[]> }; http: { byPlugin: Record<string, string[]> } } };
    assert.deepEqual(file.pluginPolicy.spawn.approved, [other], 'gone from the file too, or the next restart hands them back');
    assert.deepEqual(Object.keys(file.pluginPolicy.kanban.projects), [other]);
    assert.deepEqual(Object.keys(file.pluginPolicy.http.byPlugin), [other]);

    // Another plugin, same origin, same secret: untouched.
    assert.equal(readPluginSecret(other, SECRET), 'the-value');
    assert.deepEqual(getSecret(secret)?.grants.map((g) => g.scope_ref), [`plugin:${other}`]);
    assert.equal(canSpawn(other), true);
    assert.deepEqual([...grantedKanbanProjects(other)], ['beta']);
    assert.equal(canFetch(other, `https://${hostName(other)}/`), true);
    assert.equal(daemon.service.secret(other, owner, stranger, 'apiKey'), `key-of-${stranger}`);
    assert.deepEqual(daemon.service.destination(other, new URL(`${origin}/x`)), { allowPrivateNetwork: true });
    assert.equal(dbApi.getRoutine(strangerRoutine.id)!.enabled, 1);

    assert.deepEqual(boundPluginPackage(id), { pkg: '@mallory/second', trust: 'unsigned' });
    await pluginTakeoverCardWritten();
    const card = dbApi.listActiveNotifications('action_required').find((n) => n.anchor === `plugin-package:${id}`);
    assert.ok(card, 'the operator is told');
    assert.match(card!.body ?? '', /@mallory\/second/);
    assert.ok(!(card!.body ?? '').includes('the-value') && !(card!.body ?? '').includes(`key-of-${connection}`), 'no value in the card');

    await second.stop();
    daemon.close();
  });
});

test('a daemon that was down when the package changed catches it at boot, the same way', async () => {
  const ids = newIds();
  const { id } = ids;
  await withGrants(ids, async () => {
    const root = newRoot();
    const daemon = daemonConnections();
    const owner = connectionOwner([id]);
    const connection = daemon.seed(id, owner, `https://${id}.example`);
    const running = await daemonLoader(root);
    install(root, packageSource('@acme/first', id));
    await running.loader.update();
    await running.stop();

    // Everything happens while nothing is running, and the two never appear in one pass.
    removeByHand(root, '@acme/first');
    install(root, packageSource('@mallory/second', id));
    const booted = await daemonLoader(root);
    await booted.loader.update();

    assert.equal(canSpawn(id), false);
    assert.equal(daemon.service.secret(id, owner, connection, 'apiKey'), undefined);
    await booted.stop();
    daemon.close();
  });
});

test('the same package updated keeps everything, even through a pass that finds its folder missing', async () => {
  const ids = newIds();
  const { id } = ids;
  await withGrants(ids, async () => {
    const root = newRoot();
    const daemon = daemonConnections();
    const owner = connectionOwner([id]);
    const origin = `https://${id}.example`;
    const connection = daemon.seed(id, owner, origin);
    const SECRET = `TOKEN_${serial}`;
    createSecret({ name: SECRET, value: 'the-value', grants: [`agent:plugin:${id}`] });
    const routine = createRoutine({ name: `r-${id}`, agent_name: 'worker', prompt: 'p', cron_expr: '0 9 * * *', ownerUserId: `plugin:${id}` });
    config(); // The first load stamps `version` in the file: not what is measured here.
    const before = readFileSync(CONFIG_FILE, 'utf8');

    const { loader, stop } = await daemonLoader(root);
    install(root, packageSource('@acme/first', id, { version: '1.0.0' }));
    await loader.update();

    // npm mid-update: still declared, folder gone. A pass here reads a refusal, not a departure.
    rmSync(join(root, 'node_modules', '@acme/first'), { recursive: true, force: true });
    await loader.update();
    // Then half written: a manifest that does not validate.
    mkdirSync(join(root, 'node_modules', '@acme/first'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '@acme/first', 'package.json'), JSON.stringify({ name: '@acme/first', version: '2.0.0' }));
    await loader.update();
    install(root, packageSource('@acme/first', id, { version: '2.0.0' }));
    const records = await loader.update();
    assert.equal(records.find((r) => r.id === id)?.version, '2.0.0');

    assert.equal(readPluginSecret(id, SECRET), 'the-value');
    assert.equal(canSpawn(id), true);
    assert.deepEqual([...grantedKanbanProjects(id)], ['alpha']);
    assert.equal(canFetch(id, `https://${hostName(id)}/`), true);
    assert.equal(daemon.connections.get(connection)?.approval, 'approved');
    assert.equal(daemon.service.secret(id, owner, connection, 'apiKey'), `key-of-${connection}`);
    assert.deepEqual(daemon.service.destination(id, new URL(`${origin}/x`)), { allowPrivateNetwork: true });
    assert.equal(dbApi.getRoutine(routine.id)!.enabled, 1);
    assert.equal(readFileSync(CONFIG_FILE, 'utf8'), before, 'the file is not even rewritten');
    await stop();
    daemon.close();
  });
});

/** What the Settings form leaves behind: sealed for a `secret`, plain JSON otherwise. */
function typeSettings(id: string): void {
  dbApi.pluginKvSet(id, '@settings/token', sealPluginKvValue(id, '@settings/token', JSON.stringify('the-token')));
  dbApi.pluginKvSet(id, '@settings/apiUrl', JSON.stringify('https://api.example'));
}
const secretManifest = {
  permissions: ['settings', 'storage'],
  settings: [{ key: 'token', type: 'secret', label: 'Token' }, { key: 'apiUrl', type: 'string', label: 'URL' }],
};

/** What a package's own code finds of its id, taken from inside its `apply`. */
function snapshot(id: string, pkg: string, ctx: ApplyContext) {
  return {
    pkg,
    token: ctx.settings.get('token'),
    apiUrl: ctx.settings.get('apiUrl'),
    kv: dbApi.pluginKvList(id).map((r) => r.key),
    files: readdirSync(ctx.storage.dir),
  };
}
/** What the previous package left: its settings, its free storage, a file in its folder. */
function leaveData(id: string): void {
  typeSettings(id);
  dbApi.pluginKvSet(id, 'free', JSON.stringify({ kept: true }));
  mkdirSync(pluginDataDir(id), { recursive: true });
  writeFileSync(join(pluginDataDir(id), 'notes.txt'), 'written by the previous package');
}
const trashOf = (id: string): string[] => existsSync(PLUGIN_DATA_TRASH_DIR)
  ? readdirSync(PLUGIN_DATA_TRASH_DIR).filter((name) => name.startsWith(`${id}-`))
  : [];

test('another package under the id reads nothing of the previous one: settings, storage, data folder', async () => {
  const id = `binding-${++serial}`;
  const other = `binding-other-${serial}`;
  const root = newRoot();
  const first = await daemonLoader(root);
  install(root, packageSource('@acme/first', id, { manifest: secretManifest }));
  await first.loader.update();
  leaveData(id);
  leaveData(other);
  removeByHand(root, '@acme/first');
  await first.loader.update();
  await first.stop();
  assert.ok(dbApi.pluginKvGet(id, '@settings/token'), 'a package leaving the disk proves nothing');
  assert.ok(existsSync(join(pluginDataDir(id), 'notes.txt')));

  const seen: Array<ReturnType<typeof snapshot>> = [];
  onApply.current = (pkg, ctx) => { seen.push(snapshot(id, pkg, ctx)); };
  const second = await daemonLoader(root);
  install(root, packageSource('@mallory/second', id, { manifest: secretManifest }));
  const records = await second.loader.update();
  onApply.current = () => {};

  assert.equal(records.find((r) => r.id === id)?.state, 'active');
  assert.deepEqual(seen, [{ pkg: '@mallory/second', token: undefined, apiUrl: undefined, kv: [], files: [] }], 'from its very first line');
  assert.deepEqual(dbApi.pluginKvList(id), [], 'gone, not just hidden');
  const [trashed, ...more] = trashOf(id);
  assert.ok(trashed && more.length === 0, 'the folder went to the trash, once');
  assert.equal(readFileSync(join(PLUGIN_DATA_TRASH_DIR, trashed, 'notes.txt'), 'utf8'), 'written by the previous package');
  assert.ok(dbApi.pluginKvGet(other, '@settings/token'), 'another plugin keeps its own');
  assert.ok(dbApi.pluginKvGet(other, 'free'));
  assert.ok(existsSync(join(pluginDataDir(other), 'notes.txt')));

  await pluginTakeoverCardWritten();
  const card = dbApi.listActiveNotifications('action_required').find((n) => n.anchor === `plugin-package:${id}`);
  assert.match(card?.body ?? '', /secret settings deleted, to be typed again: token/);
  assert.match(card?.body ?? '', /settings deleted: apiUrl/);
  assert.match(card?.body ?? '', /stored entries deleted: 1/);
  assert.ok((card?.body ?? '').includes(trashed), 'the card says where the folder went');
  assert.ok(!(card?.body ?? '').includes('the-token'), 'the key in the card, never the value');
  await second.stop();
});

test('a data folder that cannot be moved keeps the package off, and the next pass finishes the job', async () => {
  const id = `binding-${++serial}`;
  const root = newRoot();
  const first = await daemonLoader(root);
  install(root, packageSource('@acme/first', id, { manifest: secretManifest }));
  await first.loader.update();
  leaveData(id);
  removeByHand(root, '@acme/first');
  await first.stop();

  // A file where the trash should be: the rename fails as a held-open file does on Windows.
  rmSync(PLUGIN_DATA_TRASH_DIR, { recursive: true, force: true });
  mkdirSync(dirname(PLUGIN_DATA_TRASH_DIR), { recursive: true });
  writeFileSync(PLUGIN_DATA_TRASH_DIR, 'in the way');
  const loaded: string[] = [];
  onApply.current = (pkg) => { loaded.push(pkg); };
  const second = await daemonLoader(root);
  try {
    install(root, packageSource('@mallory/second', id, { manifest: secretManifest }));
    const records = await second.loader.update();
    assert.deepEqual(loaded, [], 'not one line of it ran');
    assert.equal(records.find((r) => r.id === id)?.state, 'failed');
    assert.match(records.find((r) => r.id === id)?.error ?? '', /data folder/);
    assert.equal(boundPluginPackage(id)?.pkg, '@acme/first', 'the record does not move');
    assert.ok(existsSync(join(pluginDataDir(id), 'notes.txt')), 'the folder stays where it was, for nobody');
  } finally {
    rmSync(PLUGIN_DATA_TRASH_DIR, { force: true });
  }
  await second.loader.update();
  onApply.current = () => {};
  assert.deepEqual(loaded, ['@mallory/second']);
  assert.equal(boundPluginPackage(id)?.pkg, '@mallory/second');
  assert.equal(existsSync(pluginDataDir(id)), false);
  assert.equal(trashOf(id).length, 1);
  await second.stop();
});

test('the previous package still running is stopped first when it holds its folder, and the move is tried again', async () => {
  const id = `binding-${++serial}`;
  const root = newRoot();
  // Stands for a file the running package holds open: it lets go when it is unloaded.
  onApply.current = (pkg, ctx) => {
    if (pkg !== '@zed/first') return;
    writeFileSync(join(ctx.storage.dir, 'notes.txt'), 'open');
    rmSync(PLUGIN_DATA_TRASH_DIR, { recursive: true, force: true });
    writeFileSync(PLUGIN_DATA_TRASH_DIR, 'held');
    ctx.effect(() => () => { rmSync(PLUGIN_DATA_TRASH_DIR, { force: true }); });
  };
  const { loader, stop } = await daemonLoader(root);
  install(root, packageSource('@zed/first', id, { manifest: secretManifest }));
  await loader.update();
  assert.ok(existsSync(join(pluginDataDir(id), 'notes.txt')));

  const seen: Array<ReturnType<typeof snapshot>> = [];
  const inner = onApply.current;
  onApply.current = (pkg, ctx) => { inner(pkg, ctx); if (pkg === '@aaa/second') seen.push(snapshot(id, pkg, ctx)); };
  install(root, packageSource('@aaa/second', id, { manifest: secretManifest }));
  const records = await loader.update();
  onApply.current = () => {};
  assert.equal(records.find((r) => r.pkg === '@aaa/second')?.state, 'active');
  assert.deepEqual(seen.map((s) => s.files), [[]]);
  assert.equal(trashOf(id).length, 1);
  await stop();
});

test('a secret still in clear goes too, even when the next package declares it as a plain string', async () => {
  const id = `binding-${++serial}`;
  const root = newRoot();
  const first = await daemonLoader(root);
  install(root, packageSource('@acme/first', id, { manifest: secretManifest }));
  await first.loader.update();
  await first.stop();
  // Typed before the vault, and never read since: the lazy migration has not sealed it.
  dbApi.pluginKvSet(id, '@settings/token', JSON.stringify('legacy-token'));
  removeByHand(root, '@acme/first');

  const seen: unknown[] = [];
  onApply.current = (_pkg, ctx) => { seen.push(ctx.settings.get('token')); };
  const second = await daemonLoader(root);
  install(root, packageSource('@mallory/second', id, {
    manifest: { permissions: ['settings'], settings: [{ key: 'token', type: 'string', label: 'Token' }] },
  }));
  await second.loader.update();
  onApply.current = () => {};
  assert.deepEqual(seen, [undefined]);
  await second.stop();
});

test('a sealed setting goes whatever the record says, and one declared in an update is on record', () => {
  const id = `binding-${++serial}`;
  const file = join(WORK, `config-${serial}.json`);
  settlePluginPackage(id, { pkg: '@acme/first', trust: 'signed' }, file);
  dbApi.pluginKvSet(id, '@settings/sealed', sealPluginKvValue(id, '@settings/sealed', JSON.stringify('a')));
  dbApi.pluginKvSet(id, '@settings/later', JSON.stringify('b'));
  dbApi.pluginKvSet(id, '@settings/dropped', JSON.stringify('c'));
  dbApi.pluginKvSet(id, '@settings/plain', JSON.stringify('d'));

  // v2 starts declaring two secrets, v3 stops declaring one: its row is still there.
  settlePluginPackage(id, { pkg: '@acme/first', trust: 'signed', secretSettings: ['later', 'dropped'] }, file);
  settlePluginPackage(id, { pkg: '@acme/first', trust: 'signed', secretSettings: ['later'] }, file);
  assert.deepEqual(boundPluginPackage(id)?.secretSettings, ['dropped', 'later']);

  const takeover = settlePluginPackage(id, { pkg: '@mallory/second', trust: 'signed', secretSettings: ['fresh'] }, file);
  assert.deepEqual(takeover?.secretSettings, ['dropped', 'later', 'sealed']);
  assert.deepEqual(takeover?.settings, ['plain'], 'the plain one goes too, as a setting');
  assert.deepEqual(dbApi.pluginKvList(id), []);
  assert.deepEqual(boundPluginPackage(id)?.secretSettings, ['fresh'], 'the new package answers for its own');
});

test('the same package keeps all its data: updated, removed by hand, or through `timon plugin remove`', async () => {
  const id = `binding-${++serial}`;
  const root = newRoot();
  const seen: unknown[] = [];
  const all: Array<ReturnType<typeof snapshot>> = [];
  onApply.current = (pkg, ctx) => { seen.push(ctx.settings.get('token')); all.push(snapshot(id, pkg, ctx)); };
  const { loader, stop } = await daemonLoader(root);
  install(root, packageSource('@acme/first', id, { version: '1.0.0', manifest: secretManifest }));
  await loader.update();
  leaveData(id);

  install(root, packageSource('@acme/first', id, { version: '2.0.0', manifest: secretManifest }));
  await loader.update();
  assert.equal(seen.at(-1), 'the-token', 'updated');

  removeByHand(root, '@acme/first');
  await loader.update();
  install(root, packageSource('@acme/first', id, { version: '2.0.0', manifest: secretManifest }));
  await loader.update();
  assert.equal(seen.at(-1), 'the-token', 'deleted by hand, then reinstalled');

  await removePlugin(id, root, { npm: async (args) => { if (args[0] === 'uninstall') removeByHand(root, args[args.length - 1]!); } });
  await loader.update();
  install(root, packageSource('@acme/first', id, { version: '2.0.0', manifest: secretManifest }));
  await loader.update();
  assert.equal(seen.at(-1), 'the-token', 'a removal keeps it for the same package');
  assert.deepEqual(all.slice(1).map(({ apiUrl, kv, files }) => ({ apiUrl, kv, files })), Array(3).fill({
    apiUrl: 'https://api.example', kv: ['@settings/apiUrl', '@settings/token', 'free'], files: ['notes.txt'],
  }), 'its other settings, its storage and its folder, through all three');
  assert.deepEqual(trashOf(id), []);

  // The record survives that removal: the next author is caught all the same.
  await removePlugin(id, root, { npm: async (args) => { if (args[0] === 'uninstall') removeByHand(root, args[args.length - 1]!); } });
  await loader.update();
  install(root, packageSource('@mallory/second', id, { manifest: secretManifest }));
  await loader.update();
  assert.equal(seen.at(-1), undefined, 'after `timon plugin remove`, another package gets nothing');
  onApply.current = () => {};
  await stop();
});

test('a built-in renamed by a release keeps what it stores under its settings', () => {
  const id = `binding-${++serial}`;
  const file = join(WORK, `config-${serial}.json`);
  settlePluginPackage(id, { pkg: '@timon/old-name', trust: 'builtin' }, file);
  dbApi.pluginKvSet(id, '@settings/saved', sealPluginKvValue(id, '@settings/saved', JSON.stringify('password')));
  leaveData(id);

  const renamed = settlePluginPackage(id, { pkg: '@timon/new-name', trust: 'builtin' }, file);
  assert.deepEqual(renamed?.secretSettings, []);
  assert.ok(dbApi.pluginKvGet(id, '@settings/saved'));
  assert.deepEqual([renamed?.settings, renamed?.storage, renamed?.dataDir], [[], 0, null], 'nor anything else it keeps');
  assert.ok(dbApi.pluginKvGet(id, 'free'));
  assert.ok(existsSync(join(pluginDataDir(id), 'notes.txt')));

  // Anything else taking that id is not the product.
  const taken = settlePluginPackage(id, { pkg: '@mallory/second', trust: 'signed' }, file);
  assert.deepEqual([taken?.secretSettings, taken?.settings, taken?.storage], [['saved', 'token'], ['apiUrl'], 1]);
  assert.equal(existsSync(pluginDataDir(id)), false);
});

test('a secret setting that cannot be deleted keeps the package off, and the next pass finishes the job', () => {
  const id = `binding-${++serial}`;
  const file = join(WORK, `config-${serial}.json`);
  settlePluginPackage(id, { pkg: '@acme/first', trust: 'signed' }, file);
  dbApi.pluginKvSet(id, '@settings/token', sealPluginKvValue(id, '@settings/token', JSON.stringify('the-token')));

  const realDelete = dbApi.pluginKvDelete;
  dbApi.pluginKvDelete = () => { throw new Error('database is locked'); };
  try {
    assert.throws(() => settlePluginPackage(id, { pkg: '@mallory/second', trust: 'signed' }, file), /database is locked/);
  } finally {
    dbApi.pluginKvDelete = realDelete;
  }
  assert.equal(boundPluginPackage(id)?.pkg, '@acme/first', 'the record does not move');
  assert.deepEqual(settlePluginPackage(id, { pkg: '@mallory/second', trust: 'signed' }, file)?.secretSettings, ['token']);
  assert.equal(dbApi.pluginKvGet(id, '@settings/token'), undefined);
});

test('a package refused at admission takes nothing away; an unsigned copy under the same npm name is another package', async () => {
  const ids = newIds();
  const { id } = ids;
  await withGrants(ids, async () => {
    const root = newRoot();
    const daemon = daemonConnections();
    const owner = connectionOwner([id]);
    const connection = daemon.seed(id, owner, `https://${id}.example`);
    const strict = await daemonLoader(root, { allowUnsigned: false });
    install(root, packageSource('@acme/first', id, { signed: true }));
    await strict.loader.update();
    assert.deepEqual(boundPluginPackage(id), { pkg: '@acme/first', trust: 'signed' });

    // Dropped over it, unsigned, and refused: it never runs, so nothing is owed to it.
    install(root, packageSource('@acme/first', id));
    const refused = await strict.loader.update();
    assert.equal(refused.find((r) => r.pkg === '@acme/first')?.state, 'skipped');
    assert.deepEqual(boundPluginPackage(id), { pkg: '@acme/first', trust: 'signed' });
    assert.equal(canSpawn(id), true);
    assert.equal(daemon.service.secret(id, owner, connection, 'apiKey'), `key-of-${connection}`);
    await strict.stop();

    // Developer mode lets it load: it can carry any npm name, so the name proves nothing.
    const developer = await daemonLoader(root, { allowUnsigned: true });
    await developer.loader.update();
    assert.deepEqual(boundPluginPackage(id), { pkg: '@acme/first', trust: 'unsigned' });
    assert.equal(canSpawn(id), false);
    assert.equal(daemon.service.secret(id, owner, connection, 'apiKey'), undefined);
    await developer.stop();
    daemon.close();
  });
});

test('the signed release of an unsigned copy keeps everything; an unsigned copy coming back takes the id', async () => {
  const ids = newIds();
  const { id } = ids;
  await withGrants(ids, async () => {
    const root = newRoot();
    const daemon = daemonConnections();
    const owner = connectionOwner([id]);
    const origin = `https://${id}.example`;
    const connection = daemon.seed(id, owner, origin);
    const SECRET = `TOKEN_${serial}`;
    createSecret({ name: SECRET, value: 'the-value', grants: [`agent:plugin:${id}`] });
    const routine = createRoutine({ name: `r-${id}`, agent_name: 'worker', prompt: 'p', cron_expr: '0 9 * * *', ownerUserId: `plugin:${id}` });
    const all: Array<ReturnType<typeof snapshot>> = [];
    // The connection's own key is not what is measured: its approval is.
    onApply.current = (pkg, ctx) => {
      const seen = snapshot(id, pkg, ctx);
      all.push({ ...seen, kv: seen.kv.filter((key) => !key.startsWith('@connections/')) });
    };

    // A release candidate installed unsigned, in developer mode.
    const { loader, stop } = await daemonLoader(root, { allowUnsigned: true });
    try {
      install(root, packageSource('@acme/studio', id, { version: '1.0.0-rc.21', manifest: secretManifest }));
      await loader.update();
      assert.deepEqual(boundPluginPackage(id), { pkg: '@acme/studio', trust: 'unsigned', secretSettings: ['token'] });
      leaveData(id);

      install(root, packageSource('@acme/studio', id, { version: '1.0.0-rc.22', manifest: secretManifest, signed: true }));
      const records = await loader.update();
      assert.equal(records.find((r) => r.id === id)?.version, '1.0.0-rc.22');
      assert.deepEqual(all.at(-1), {
        pkg: '@acme/studio', token: 'the-token', apiUrl: 'https://api.example', kv: ['@settings/apiUrl', '@settings/token', 'free'], files: ['notes.txt'],
      }, 'its settings, secret included, its storage and its folder, from its very first line');
      assert.deepEqual(trashOf(id), []);
      assert.equal(readPluginSecret(id, SECRET), 'the-value');
      assert.equal(canSpawn(id), true);
      assert.deepEqual([...grantedKanbanProjects(id)], ['alpha']);
      assert.equal(canFetch(id, `https://${hostName(id)}/`), true);
      assert.equal(daemon.connections.get(connection)?.approval, 'approved');
      assert.equal(daemon.service.secret(id, owner, connection, 'apiKey'), `key-of-${connection}`);
      assert.equal(dbApi.getRoutine(routine.id)!.enabled, 1);
      assert.equal(dbApi.listActiveNotifications('action_required').some((n) => n.anchor === `plugin-package:${id}`), false, 'no takeover card');
      assert.deepEqual(boundPluginPackage(id), { pkg: '@acme/studio', trust: 'signed', secretSettings: ['token'] }, 'signed from now on');

      // The way back is not an update: anyone can build an unsigned package under that name.
      install(root, packageSource('@acme/studio', id, { version: '1.0.0-rc.23', manifest: secretManifest }));
      await loader.update();
      assert.deepEqual(all.at(-1), { pkg: '@acme/studio', token: undefined, apiUrl: undefined, kv: [], files: [] });
      assert.equal(trashOf(id).length, 1, 'the folder went to the trash');
      assert.equal(readPluginSecret(id, SECRET), undefined);
      assert.equal(canSpawn(id), false);
      assert.equal(daemon.connections.get(connection)?.approval, 'pending');
      assert.deepEqual(boundPluginPackage(id), { pkg: '@acme/studio', trust: 'unsigned', secretSettings: ['token'] });
    } finally {
      onApply.current = () => {};
      await stop();
      daemon.close();
    }
  });
});

test('a signed package under another npm name takes the id from an unsigned copy all the same', () => {
  const id = `binding-${++serial}`;
  const file = join(WORK, `config-${serial}.json`);
  settlePluginPackage(id, { pkg: '@acme/studio', trust: 'unsigned' }, file);
  leaveData(id);
  const taken = settlePluginPackage(id, { pkg: '@mallory/studio', trust: 'signed' }, file);
  assert.deepEqual([taken?.secretSettings, taken?.settings, taken?.storage], [['token'], ['apiUrl'], 1]);
  assert.equal(existsSync(pluginDataDir(id)), false);
  assert.deepEqual(boundPluginPackage(id), { pkg: '@mallory/studio', trust: 'signed' });
});

test('another package winning the id over one still on disk takes it the same way', async () => {
  const ids = newIds();
  const { id } = ids;
  await withGrants(ids, async () => {
    const root = newRoot();
    const { loader, stop } = await daemonLoader(root);
    install(root, packageSource('@zed/first', id));
    await loader.update();
    assert.equal(canSpawn(id), true);

    // Two packages cannot share an id: the first by npm name wins, and this one sorts first.
    install(root, packageSource('@aaa/second', id));
    const records = await loader.update();
    assert.equal(records.find((r) => r.pkg === '@aaa/second')?.state, 'active');
    assert.equal(records.find((r) => r.pkg === '@zed/first')?.reason, 'skipped:duplicate-id');
    assert.equal(canSpawn(id), false);
    assert.deepEqual(boundPluginPackage(id)?.pkg, '@aaa/second');
    await stop();
  });
});

test('what keeps the data: the npm name, and a signature never lost on the way', () => {
  const pkg = (name: string, trust: PluginPackage['trust']): PluginPackage => ({ pkg: name, trust });
  assert.equal(keepsPluginData(pkg('a', 'signed'), pkg('a', 'signed')), true);
  assert.equal(keepsPluginData(pkg('a', 'unsigned'), pkg('a', 'unsigned')), true);
  assert.equal(keepsPluginData(pkg('a', 'builtin'), pkg('a', 'signed')), true, 'both vouched for by the product');
  assert.equal(keepsPluginData(pkg('a', 'signed'), pkg('a', 'builtin')), true);
  assert.equal(keepsPluginData(pkg('a', 'unsigned'), pkg('a', 'signed')), true, 'the signed release of an unsigned copy: an update');
  assert.equal(keepsPluginData(pkg('a', 'unsigned'), pkg('a', 'builtin')), true);
  assert.equal(keepsPluginData(pkg('a', 'signed'), pkg('a', 'unsigned')), false, 'anyone can build an unsigned copy of the name');
  assert.equal(keepsPluginData(pkg('a', 'builtin'), pkg('a', 'unsigned')), false);
  assert.equal(keepsPluginData(pkg('a', 'signed'), pkg('b', 'signed')), false);
  assert.equal(keepsPluginData(pkg('a', 'unsigned'), pkg('b', 'signed')), false, 'signed, but another name');

  assert.equal(signsUnsignedCopy(pkg('a', 'unsigned'), pkg('a', 'signed')), true);
  assert.equal(signsUnsignedCopy(pkg('a', 'unsigned'), pkg('b', 'signed')), false);
  assert.equal(signsUnsignedCopy(pkg('a', 'signed'), pkg('a', 'signed')), false, 'an update, but nothing to say');
  assert.equal(signsUnsignedCopy(pkg('a', 'unsigned'), pkg('a', 'unsigned')), false);
  assert.equal(signsUnsignedCopy(null, pkg('a', 'signed')), false);

  const id = `binding-${++serial}`;
  assert.equal(pluginPackageChanged(id, pkg('a', 'signed')), false, 'nothing on record');
  dbApi.pluginKvSet('@timon/plugin-packages', id, 'not json');
  assert.equal(boundPluginPackage(id), null);
});

test('what cannot be withdrawn keeps the package off, and the next pass finishes the job', async () => {
  const id = `binding-${++serial}`;
  const SECRET = `TOKEN_${serial}`;
  const file = join(WORK, `config-${serial}.json`);
  createSecret({ name: SECRET, value: 'the-value', grants: [`agent:plugin:${id}`] });
  settlePluginPackage(id, { pkg: '@acme/first', trust: 'signed' }, file);
  writeFileSync(file, '{ "pluginPolicy": { "spawn": { "approved": [');

  assert.throws(() => settlePluginPackage(id, { pkg: '@mallory/second', trust: 'signed' }, file), /@acme\/first/);
  assert.deepEqual(boundPluginPackage(id)?.pkg, '@acme/first', 'the record stays: it is what the next attempt compares with');
  assert.equal(readPluginSecret(id, SECRET), undefined, 'the rest went anyway');

  writeFileSync(file, JSON.stringify({ pluginPolicy: { spawn: { approved: [id] } } }));
  const takeover = settlePluginPackage(id, { pkg: '@mallory/second', trust: 'signed' }, file);
  assert.equal(takeover?.spawnApproval, true);
  assert.deepEqual((JSON.parse(readFileSync(file, 'utf8')) as { pluginPolicy: { spawn: { approved: string[] } } }).pluginPolicy.spawn.approved, []);
  assert.deepEqual(boundPluginPackage(id)?.pkg, '@mallory/second');

  // Through the loader: the package does not run, and says why.
  const root = newRoot();
  const loaded: string[] = [];
  onApply.current = (pkg) => { loaded.push(pkg); };
  let refuse = true;
  const { loader, stop } = await daemonLoader(root, { settle: () => { if (refuse) throw new Error('cannot withdraw'); } });
  install(root, packageSource('@acme/blocked', `binding-${++serial}`));
  const records = await loader.update();
  assert.deepEqual(loaded, []);
  assert.equal(records.find((r) => r.pkg === '@acme/blocked')?.state, 'failed');
  assert.match(records.find((r) => r.pkg === '@acme/blocked')?.error ?? '', /cannot withdraw/);
  refuse = false;
  await loader.update();
  assert.deepEqual(loaded, ['@acme/blocked']);
  onApply.current = () => {};
  await stop();
});

test('the live copy does not survive a file failing the schema', async () => {
  const ids = newIds();
  const { id, other } = ids;
  await withGrants(ids, async () => {
    settlePluginPackage(id, { pkg: '@acme/first', trust: 'signed' });
    assert.equal(canSpawn(id), true);
    // Valid JSON, refused by the schema: `narrowLivePluginGrants` moves nothing on such a file.
    const broken = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as { pluginPolicy: { http: Record<string, unknown> } };
    broken.pluginPolicy.http.allow = 'not a list';
    writeFileSync(CONFIG_FILE, JSON.stringify(broken));
    assert.throws(() => loadConfig(CONFIG_FILE, { readonly: true }));
    settlePluginPackage(id, { pkg: '@mallory/second', trust: 'signed' });
    assert.equal(config().pluginPolicy.spawn.approved.includes(id), false);
    assert.equal(canSpawn(id), false);
    assert.equal(canSpawn(other), true);
    assert.deepEqual(pluginHttpHosts(id), []);
    assert.deepEqual(pluginHttpHosts(other), [hostName(other)]);
  });
});

function sheet(root: string, file: string) {
  return new PluginInstallSources({
    pluginsRoot: root,
    stagingRoot: join(WORK, `staging-${++serial}`),
    forbiddenRoots: [join(WORK, 'forbidden')],
    publicKeys: KEYS,
    unsignedLoads: () => true,
    configFile: file,
    install: { npm: fakeNpm, config: file, publicKeys: KEYS, builtins: [] },
  });
}

test('install sheet: the lines read as withdrawn, the sheet names the package replaced, and what is ticked survives the next pass', async () => {
  const ids = newIds();
  const { id } = ids;
  await withGrants(ids, async () => {
    const root = newRoot();
    const KEPT = `KEPT_${serial}`;
    const OLD = `OLD_${serial}`;
    const kept = createSecret({ name: KEPT, value: 'kept-value', grants: [`agent:plugin:${id}`] }).id;
    createSecret({ name: OLD, value: 'old-value', grants: [`agent:plugin:${id}`] });
    const manifest = {
      permissions: ['secrets:read', 'http:outbound'],
      secrets: [{ name: KEPT, mode: 'read' }, { name: OLD, mode: 'read' }],
      http: { hosts: [{ host: hostName(id) }] },
    };
    const first = await daemonLoader(root);
    install(root, packageSource('@acme/first', id, { manifest }));
    await first.loader.update();

    const installed = sheet(root, CONFIG_FILE);
    const again = installed.stagePath(packageSource('@acme/first', id, { manifest, version: '1.1.0' }));
    assert.equal(again.replaces, null, 'its own update replaces nobody');
    assert.deepEqual(again.vault?.secrets.map((s) => s.state), ['granted', 'granted']);
    assert.equal(again.vault?.hosts[0]?.allowedBy, 'plugin');
    installed.discard(again.token);

    removeByHand(root, '@acme/first');
    await first.loader.update();
    await first.stop();

    const sources = sheet(root, CONFIG_FILE);
    const preview = sources.stagePath(packageSource('@mallory/second', id, { manifest }));
    assert.equal(preview.replaces, '@acme/first');
    assert.deepEqual(preview.vault?.secrets.map((s) => s.state), ['grantable', 'grantable'], 'what the old one held is not this one\'s');
    assert.equal(preview.vault?.hosts[0]?.allowedBy, null);
    assert.equal(readPluginSecret(id, KEPT), 'kept-value', 'a preview changes nothing');
    assert.deepEqual(boundPluginPackage(id)?.pkg, '@acme/first');

    await sources.installStaged(preview.token, {
      vault: {
        secrets: preview.vault!.secrets.map((s) => ({ name: s.name, mode: s.mode, state: s.state, grant: s.name === KEPT })),
        hosts: preview.vault!.hosts.map((h) => ({ host: h.host, allowedBy: h.allowedBy, grant: true })),
      },
    });

    const second = await daemonLoader(root);
    await second.loader.update();
    assert.equal(readPluginSecret(id, KEPT), 'kept-value', 'ticked: granted again, and the pass leaves it');
    assert.equal(readPluginSecret(id, OLD), undefined, 'not ticked: gone');
    assert.deepEqual(getSecret(kept)?.grants.map((g) => g.scope_ref), [`plugin:${id}`]);
    assert.deepEqual(pluginHttpHosts(id), [hostName(id)]);
    assert.equal(canSpawn(id), false, 'never on the sheet: gone');
    assert.deepEqual(boundPluginPackage(id)?.pkg, '@mallory/second');
    await second.stop();
  });
});

/** A bundle beside its one child, `file:../`, as a picked folder brings them. */
function bundleSource(pkg: string, id: string, child: string): string {
  const dir = join(WORK, `src-${++serial}`);
  mkdirSync(dir, { recursive: true });
  const childPkg = (JSON.parse(readFileSync(join(child, 'package.json'), 'utf8')) as { name: string }).name;
  const childId = (JSON.parse(readFileSync(join(child, 'package.json'), 'utf8')) as { timon: { id: string } }).timon.id;
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: pkg, version: '1.0.0', type: 'module', main: 'index.js',
    dependencies: { [childPkg]: `file:../${child.split(/[\\/]/).pop()}` },
    timon: { id, apiVersion: PLUGIN_API_VERSION, kind: 'bundle', label: id, permissions: [], contains: [childId] },
  }));
  writeFileSync(join(dir, 'index.js'), 'export function apply() {}\n');
  return dir;
}

test('install sheet: a bundle child taking the id reads the old lines as withdrawn, and what is ticked survives the next pass', async () => {
  const ids = newIds();
  const { id } = ids;
  await withGrants(ids, async () => {
    const root = newRoot();
    const KEPT = `KEPT_${serial}`;
    const OLD = `OLD_${serial}`;
    const kept = createSecret({ name: KEPT, value: 'kept-value', grants: [`agent:plugin:${id}`] }).id;
    createSecret({ name: OLD, value: 'old-value', grants: [`agent:plugin:${id}`] });
    const manifest = {
      permissions: ['secrets:read', 'http:outbound'],
      secrets: [{ name: KEPT, mode: 'read' }, { name: OLD, mode: 'read' }],
      http: { hosts: [{ host: hostName(id) }] },
    };
    const first = await daemonLoader(root);
    install(root, packageSource('@acme/first', id, { manifest }));
    await first.loader.update();
    removeByHand(root, '@acme/first');
    await first.loader.update();
    await first.stop();

    const sources = sheet(root, CONFIG_FILE);
    const bundle = bundleSource('@mallory/bundle', `${id}-bundle`, packageSource('@mallory/child', id, { manifest }));
    const preview = sources.stagePath(bundle);
    const child = preview.children.find((c) => c.id === id);
    assert.equal(child?.state, 'install');
    assert.equal(child?.replaces, '@acme/first');
    assert.deepEqual(child?.vault?.secrets.map((s) => s.state), ['grantable', 'grantable'], 'what the old one held is not this child\'s');
    assert.equal(child?.vault?.hosts[0]?.allowedBy, null);
    assert.deepEqual(boundPluginPackage(id)?.pkg, '@acme/first', 'a preview changes nothing');

    const consent = (state: (s: { state: string }) => string) => [{
      id, pkg: child!.pkg!, version: child!.version!,
      secrets: child!.vault!.secrets.map((s) => ({ name: s.name, mode: s.mode, state: state(s) as typeof s.state, grant: s.name === KEPT })),
      hosts: child!.vault!.hosts.map((h) => ({ host: h.host, allowedBy: h.allowedBy, grant: true })),
    }];
    // What a sheet blind to the takeover sent: the old package's grants passed off as this child's.
    await assert.rejects(
      sources.installStaged(preview.token, { vaultChildren: consent(() => 'granted') }),
      (err: unknown) => (err as { code?: string }).code === 'mismatch',
    );
    assert.equal(readPluginSecret(id, OLD), 'old-value', 'refused before anything is withdrawn');

    const done = await sources.installStaged(preview.token, { vaultChildren: consent((s) => s.state) });
    assert.deepEqual(done.vaultChildren, [{ id, granted: { secrets: [KEPT], hosts: [hostName(id)] }, refused: null }]);
    assert.deepEqual(boundPluginPackage(id)?.pkg, '@mallory/child', 'settled before the grant, not by the next pass');
    assert.equal(readPluginSecret(id, OLD), undefined, 'not ticked: gone at once');

    const second = await daemonLoader(root);
    await second.loader.update();
    assert.equal(readPluginSecret(id, KEPT), 'kept-value', 'ticked: granted again, and the pass leaves it');
    assert.equal(readPluginSecret(id, OLD), undefined);
    assert.deepEqual(getSecret(kept)?.grants.map((g) => g.scope_ref), [`plugin:${id}`]);
    assert.deepEqual(pluginHttpHosts(id), [hostName(id)]);
    assert.equal(canSpawn(id), false, 'never on the sheet: gone');
    assert.deepEqual(boundPluginPackage(id)?.pkg, '@mallory/child');
    await second.stop();
  });
});

test('install sheet: a bundle child gets nothing when another package takes the id after the sheet was shown', async () => {
  const ids = newIds();
  const { id } = ids;
  await withGrants(ids, async () => {
    const root = newRoot();
    const SECRET = `LATE_${serial}`;
    // Granted to the id, never to a package: the sheet of a first comer shows it as its own.
    const secret = createSecret({ name: SECRET, value: 'late-value', grants: [`agent:plugin:${id}`] }).id;
    const manifest = { permissions: ['secrets:read'], secrets: [{ name: SECRET, mode: 'read' }] };
    const lines = (child: { pkg: string | null; version: string | null; vault: { secrets: Array<{ name: string; mode: 'read' | 'inject'; state: string }> } | null }) => [{
      id, pkg: child.pkg!, version: child.version!, hosts: [],
      secrets: child.vault!.secrets.map((s) => ({ name: s.name, mode: s.mode, state: s.state as 'granted', grant: true })),
    }];

    // Before the click: the lines are read again, and `granted` no longer holds.
    const sources = sheet(root, CONFIG_FILE);
    const preview = sources.stagePath(bundleSource('@acme/bundle', `${id}-bundle`, packageSource('@acme/child', id, { manifest })));
    const shown = preview.children.find((c) => c.id === id)!;
    assert.equal(shown.replaces, null, 'nobody on record yet');
    assert.deepEqual(shown.vault?.secrets.map((s) => s.state), ['granted']);
    settlePluginPackage(id, { pkg: '@zed/other', trust: 'unsigned' });
    await assert.rejects(sources.installStaged(preview.token, { vaultChildren: lines(shown) }), (err: unknown) => (err as { code?: string }).code === 'mismatch');
    sources.discard(preview.token);

    // While npm runs: the child lands, but what the sheet planned was for a first comer.
    const other = `${id}-late`;
    createSecret({ name: `${SECRET}_B`, value: 'late-b' });
    const racing = new PluginInstallSources({
      pluginsRoot: root, stagingRoot: join(WORK, `staging-${++serial}`), forbiddenRoots: [join(WORK, 'forbidden')],
      publicKeys: KEYS, unsignedLoads: () => true, configFile: CONFIG_FILE,
      install: {
        npm: async (args, cwd) => { await fakeNpm(args, cwd); settlePluginPackage(other, { pkg: '@zed/other', trust: 'unsigned' }); },
        config: CONFIG_FILE, publicKeys: KEYS, builtins: [],
      },
    });
    const late = racing.stagePath(bundleSource('@acme/late-bundle', `${other}-bundle`, packageSource('@acme/late-child', other, {
      manifest: { permissions: ['secrets:read'], secrets: [{ name: `${SECRET}_B`, mode: 'read' }] },
    })));
    const child = late.children.find((c) => c.id === other)!;
    assert.equal(child.replaces, null);
    const done = await racing.installStaged(late.token, {
      vaultChildren: [{ ...lines(child)[0]!, id: other }],
    });
    assert.deepEqual(done.vaultChildren, [{ id: other, granted: null, refused: 'changed' }]);
    assert.equal(readPluginSecret(other, `${SECRET}_B`), undefined, 'consent given to a first comer is not given to a takeover');
    assert.deepEqual(boundPluginPackage(other)?.pkg, '@zed/other', 'left to the loader, which withdraws before mounting');
    assert.equal(readPluginSecret(id, SECRET), 'late-value', 'the refused click withdrew nothing');
    assert.ok(getSecret(secret));
  });
});

test('install sheet: a bundle child whose package keeps the id replaces nobody and keeps what it holds', async () => {
  const ids = newIds();
  const { id } = ids;
  await withGrants(ids, async () => {
    const root = newRoot();
    const KEPT = `KEPT_${serial}`;
    createSecret({ name: KEPT, value: 'kept-value', grants: [`agent:plugin:${id}`] });
    const manifest = { permissions: ['secrets:read'], secrets: [{ name: KEPT, mode: 'read' }] };
    const first = await daemonLoader(root);
    install(root, packageSource('@acme/child', id, { manifest }));
    await first.loader.update();
    removeByHand(root, '@acme/child');
    await first.loader.update();
    await first.stop();

    const sources = sheet(root, CONFIG_FILE);
    const preview = sources.stagePath(bundleSource('@acme/bundle', `${id}-bundle`, packageSource('@acme/child', id, { manifest })));
    const child = preview.children.find((c) => c.id === id);
    assert.equal(child?.replaces, null);
    assert.deepEqual(child?.vault?.secrets.map((s) => s.state), ['granted']);
    const done = await sources.installStaged(preview.token, {
      vaultChildren: [{ id, pkg: child!.pkg!, version: child!.version!, secrets: child!.vault!.secrets.map((s) => ({ ...s, grant: true })), hosts: [] }],
    });
    assert.deepEqual(done.vaultChildren, [{ id, granted: { secrets: [], hosts: [] }, refused: null }]);
    const second = await daemonLoader(root);
    await second.loader.update();
    assert.equal(readPluginSecret(id, KEPT), 'kept-value');
    assert.equal(canSpawn(id), true, 'the same package loses nothing');
    await second.stop();
  });
});

test('install sheet: while another package holds the id, nothing is withdrawn before the loader decides', async () => {
  const ids = newIds();
  const { id } = ids;
  await withGrants(ids, async () => {
    const root = newRoot();
    const { loader, stop } = await daemonLoader(root);
    install(root, packageSource('@acme/first', id));
    await loader.update();
    const sources = sheet(root, CONFIG_FILE);
    const preview = sources.stagePath(packageSource('@zed/second', id));
    assert.equal(preview.replaces, null);
    await sources.installStaged(preview.token, { vault: { secrets: [], hosts: [] } });
    assert.deepEqual(boundPluginPackage(id)?.pkg, '@acme/first');
    assert.equal(canSpawn(id), true);
    // `@acme/first` sorts first and keeps the id: the newcomer is the one refused.
    const records = await loader.update();
    assert.equal(records.find((r) => r.pkg === '@zed/second')?.reason, 'skipped:duplicate-id');
    assert.equal(canSpawn(id), true);
    await stop();
  });
});

/** No test boots the real daemon: without this wiring, every test above passes and the hole stays open. */
test('install sheet and `timon plugin add`: the signed release of an unsigned copy says it is an update, and replaces nobody', async () => {
  const ids = newIds();
  const { id } = ids;
  await withGrants(ids, async () => {
    const root = newRoot();
    const SECRET = `TOKEN_${serial}`;
    createSecret({ name: SECRET, value: 'the-value', grants: [`agent:plugin:${id}`] });
    const manifest = { permissions: ['secrets:read', 'http:outbound'], secrets: [{ name: SECRET, mode: 'read' }], http: { hosts: [{ host: hostName(id) }] } };
    const first = await daemonLoader(root);
    install(root, packageSource('@acme/studio', id, { manifest }));
    await first.loader.update();
    await first.stop();

    const sources = sheet(root, CONFIG_FILE);
    const preview = sources.stagePath(packageSource('@acme/studio', id, { manifest, version: '1.1.0', signed: true }));
    assert.equal(preview.updatesUnsigned, true);
    assert.equal(preview.replaces, null);
    assert.deepEqual(preview.vault?.secrets.map((s) => s.state), ['granted'], 'what the unsigned copy held stays this one\'s');
    assert.equal(preview.vault?.hosts[0]?.allowedBy, 'plugin');
    sources.discard(preview.token);

    const unsigned = sources.stagePath(packageSource('@acme/studio', id, { manifest, version: '1.1.0' }));
    assert.equal(unsigned.updatesUnsigned, false, 'unsigned to unsigned: an update with nothing to say');
    sources.discard(unsigned.token);

    // `timon plugin add <tgz> --yes`: npm only, nothing withdrawn, and the CLI says why.
    const added = await addPlugin(packageSource('@acme/studio', id, { manifest, version: '1.1.0', signed: true }), root, {
      npm: fakeNpm, config: CONFIG_FILE, publicKeys: KEYS, builtins: [],
    });
    assert.equal(added.updatesUnsigned, true);
    assert.equal(readPluginSecret(id, SECRET), 'the-value');
    assert.equal(canSpawn(id), true);
    const second = await daemonLoader(root);
    await second.loader.update();
    assert.equal(readPluginSecret(id, SECRET), 'the-value');
    assert.equal(canSpawn(id), true);
    assert.equal(canFetch(id, `https://${hostName(id)}/`), true);
    assert.deepEqual(boundPluginPackage(id), { pkg: '@acme/studio', trust: 'signed' });

    // Signed on record now: an unsigned copy is a takeover on the sheet.
    const back = sheet(root, CONFIG_FILE).stagePath(packageSource('@acme/studio', id, { manifest, version: '1.2.0' }));
    assert.equal(back.updatesUnsigned, false);
    assert.equal(back.replaces, '@acme/studio', 'its own name, but what the signed one holds goes');
    const again = await addPlugin(packageSource('@acme/studio', id, { manifest, version: '1.2.0', signed: true }), root, {
      npm: fakeNpm, config: CONFIG_FILE, publicKeys: KEYS, builtins: [],
    });
    assert.equal(again.updatesUnsigned, false, 'signed to signed: nothing to say');
    await second.stop();
  });
});

test('the daemon settles every package it loads', () => {
  const boot = readFileSync(new URL('../kernel-boot.ts', import.meta.url), 'utf8');
  assert.match(boot, /settlePackage: \(id, pkg\) => \{ settlePluginPackage\(id, pkg\); \}/);
});
