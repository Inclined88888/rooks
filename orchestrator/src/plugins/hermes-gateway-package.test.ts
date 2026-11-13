/**
 * The Hermes Gateway plugin as a package: its manifest, its independence from
 * the product's internals, its installation, and — end to end, through the
 * real plugin context — a mission whose session reaches a fake gateway with the
 * connection and key of the account that launched it, through the daemon's
 * approved-destination fetch.
 */
import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';
import { createPluginContext, daemonHost, PluginAgentError, type PluginContext } from './context.js';
import { PluginManifestSchema, readManifest } from './manifest.js';
import { integrationRegistries } from './integration-host.js';
import { runPluginRequest } from './als.js';
import { startUserConnections } from './user-connections.js';
import { daemonUserConnectionHost } from './user-connections-host.js';
import { addPlugin, inventory, removePlugin } from './install.js';
import { readBuiltinList } from './builtin.js';
import { createHttpPlugin } from '../kernel/http-service.js';
import { PluginLoader } from './loader.js';
import { attachPluginLoader } from './runtime.js';
import { dbApi } from '../db.js';
import { buildEffectivePrompt, getAgent, loadConfig, upsertAgent } from '../agent.js';
import { upsertSkill } from '../skills.js';
import { getBackend, isBackendName } from '../backends/index.js';
import { backendCapabilities } from '../backends/capabilities.js';
import { catalogClaimsModel } from '../backends/catalog.js';
import type { BuildSpawnOpts, NormalizedEvent } from '../backends/types.js';
import type { PluginUserConnection } from './integration-types.js';

const PACKAGE = fileURLToPath(new URL('../../../plugins/hermes-gateway', import.meta.url));
const pkg = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as { name: string; main: string; exports: Record<string, string>; rooks: unknown };
const lib = await import('../../../plugins/hermes-gateway/lib/index.js') as {
  apply(ctx: PluginContext): void;
  syncAgents(ctx: Pick<PluginContext, 'agents'>, connections: readonly PluginUserConnection[]): Promise<{ created: string[]; updated: string[]; kept: string[]; skipped: string[] }>;
};
type Identity = Parameters<typeof runPluginRequest>[0];
const as = (id: string, isSuperadmin: boolean, permissions: string[]): Identity => ({
  viewer: { id, isSuperadmin, permissions }, user: { id, email: `${id}@example.com`, name: id, is_superadmin: isSuperadmin }, ownerUserId: id,
});
const gatewayOf = (id: string, label: string, owner: string, config: Record<string, string> = {}): PluginUserConnection => ({
  id, pluginId: 'hermes-gateway', type: 'hermes-gateway:gateway@1', identity: { ownerUserId: owner } as PluginUserConnection['identity'], label,
  url: 'https://gw.example', allowPrivateNetwork: false, config, secrets: ['apiKey'], approval: 'approved', enabled: true, revision: 1,
});
const { startFakeGateway } = await import('../../../plugins/hermes-gateway/test/fake-gateway.mjs') as {
  startFakeGateway(options?: Record<string, unknown>): Promise<{ url: string; requests: Array<{ path: string }>; runs: Map<string, { body: { instructions?: string } }>; close(): Promise<void> }>;
};

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });

test('the manifest asks for the remote backend, connection, outbound and agent permissions only', () => {
  const manifest = PluginManifestSchema.parse(pkg.rooks);
  assert.equal(pkg.name, '@rooks/plugin-hermes-gateway');
  assert.equal(pkg.main, 'lib/index.js');
  assert.equal(pkg.exports['./client'], './lib/client.js');
  assert.equal(manifest.id, 'hermes-gateway');
  assert.equal(manifest.apiVersion, 7);
  assert.deepEqual([...manifest.permissions].sort(), ['agents:manage', 'backends:register', 'connections:register', 'connections:users:read', 'http:outbound']);
  assert.deepEqual(manifest.client?.slots, ['settings.section']);
  assert.equal(manifest.license.required, false);
});

test('sources and shipped modules never import product internals', () => {
  function check(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== '__fixtures__') check(path); continue; }
      if (!/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
      const source = readFileSync(path, 'utf8');
      assert.doesNotMatch(source, /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"][^'"]*(?:app\/|@\/|orchestrator\/src|packages\/sdk)/, path);
      assert.doesNotMatch(source, /(?:text|bg|border|tracking|h|w|max-h)-\[/, `${path}: arbitrary Tailwind value`);
    }
  }
  check(join(PACKAGE, 'src'));
  check(join(PACKAGE, 'lib'));
  check(join(PACKAGE, 'test'));
  const client = readFileSync(join(PACKAGE, 'lib', 'client.js'), 'utf8');
  const imports = [...client.matchAll(/from\s*["']([^"']+)["']/g)].map((m) => m[1]);
  assert.ok(imports.every((id) => id === 'react' || id === '@rooks/ui'), `client imports: ${imports.join(', ')}`);
  assert.doesNotMatch(client, /\bfetch\s*\(/);
  // The MIT credit travels with the package.
  assert.match(readFileSync(join(PACKAGE, 'NOTICE'), 'utf8'), /Copyright \(c\) 2025 Hermes Web UI Contributors/);
});

test('the package installs and removes in a disposable home', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rooks-hermes-package-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'plugins');
  const config = join(home, 'rooks.config.json');
  writeFileSync(config, JSON.stringify({ plugins: {} }));
  const added = await addPlugin(PACKAGE, root, { config, publicKeys: [] });
  assert.equal(added.refused, null, added.message ?? 'valid package');
  // Without the shipped list: what is tested here is the package as a third party installs it.
  assert.equal(inventory(root, config, []).find((p) => p.id === 'hermes-gateway')?.enabled, true);
  await removePlugin('hermes-gateway', root, { config });
  assert.equal(inventory(root, config, []).some((p) => p.id === 'hermes-gateway'), false);
});

test('the app ships it built in, switched off until someone turns it on', () => {
  const home = mkdtempSync(join(tmpdir(), 'rooks-hermes-builtin-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const config = join(home, 'rooks.config.json');
  writeFileSync(config, JSON.stringify({ plugins: {} }));
  const entry = readBuiltinList().find((p) => p.pkg === '@rooks/plugin-hermes-gateway');
  assert.equal(entry?.enabledByDefault, false);
  const shipped = inventory(join(home, 'plugins'), config).find((p) => p.id === 'hermes-gateway');
  assert.equal(shipped?.builtin, true);
  assert.equal(shipped?.enabled, false);
  writeFileSync(config, JSON.stringify({ plugins: { 'hermes-gateway': true } }));
  assert.equal(inventory(join(home, 'plugins'), config).find((p) => p.id === 'hermes-gateway')?.enabled, true);
});

async function loaded() {
  const db = new Database(':memory:');
  const started = startUserConnections(db, { ...daemonUserConnectionHost(), approvalPolicy: () => 'admin' });
  cleanup.push(() => { started.stop(); db.close(); });
  const root = new Context();
  // `ctx.router()` mounts on the kernel's http service.
  const app = express();
  // What the daemon's auth middleware sets for a signed-in superadmin, named by a test header.
  app.use((req, _res, next) => {
    const user = dbApi.getUserById(String(req.headers['x-test-user'] ?? ''));
    if (user) req.auth = { kind: 'session', user, isSuperadmin: true };
    next();
  });
  await root.plugin(createHttpPlugin(app));
  let inner!: Context;
  await root.plugin({ name: 'holder', apply(ctx: Context) { inner = ctx; } });
  cleanup.push(() => root.fiber.dispose());
  const manifest = readManifest(pkg);
  assert.ok(manifest.ok);
  const plugin = createPluginContext(inner, { manifest: manifest.manifest, version: '0.1.0' }, daemonHost(root));
  lib.apply(plugin);
  return { plugin, app, service: started.service };
}

function account(name: string, permissions: string[] = []): string {
  const id = randomUUID();
  createTestAccount(dbApi, { id, email: `${name}-${id}@example.test`, name, passwordHash: 'unused', status: 'active' });
  grantTestPermissions(dbApi, id, ['plugin:hermes-gateway', ...permissions]);
  return id;
}

test('apply registers a remote backend that declares what it cannot do, and its connection type', async () => {
  await loaded();
  assert.equal(isBackendName('hermes-gateway'), true);
  assert.deepEqual(backendCapabilities('hermes-gateway'), { worktree: false, rooksMcp: false, attachments: false, rooksPreamble: false });
  assert.equal(catalogClaimsModel('hermes-gateway', 'hermes/default'), true);
  assert.equal(catalogClaimsModel('hermes-gateway', 'hermes/coder'), true, 'any profile, by the slug prefix');
  const type = integrationRegistries.connectionTypes.get('hermes-gateway:gateway@1')?.definition;
  assert.equal(type?.label, 'Hermes Gateway');
  assert.deepEqual(type?.secrets?.map((s) => s.name), ['apiKey']);
  assert.deepEqual(type?.configSchema.parse({ profile: 'coder' }), { profile: 'coder' });
  assert.deepEqual(type?.configSchema.parse({ profile: '' }), {}, 'empty = the default profile');
  assert.throws(() => type?.configSchema.parse({ profile: '../admin' }), 'a profile name never walks the URL');
});

test('end to end: a mission of an account reaches ITS gateway, through the approved destination', async () => {
  const { service } = await loaded();
  const gw = await startFakeGateway();
  cleanup.push(() => gw.close());
  const ada = account('ada');
  await service.create({ userId: ada, isAdmin: true }, {
    type: 'hermes-gateway:gateway@1', label: 'Ada\'s Hermes', url: gw.url, allowPrivateNetwork: true,
    config: {}, secrets: { apiKey: 'gateway-default-key-0001' },
  });
  const missionId = `hermes-e2e-${randomUUID().slice(0, 8)}`;
  dbApi.createMission(missionId, 'hermes.default', 'hello', undefined, ada);
  const emitted: NormalizedEvent[] = [];
  const backend = getBackend('hermes-gateway');
  const driver = backend.openRemoteSession!({
    spawn: { agentName: 'hermes.default', systemPrompt: '', message: 'hello', resumeSession: null, cfg: { model: 'hermes/default' }, missionId } as unknown as BuildSpawnOpts,
    host: { emit: (ev) => { emitted.push(ev); }, requestPermission: async () => ({ allow: false }), end: () => undefined, saveResume: () => undefined },
  });
  await driver.start();
  assert.equal((await driver.prompt('hello')).stopReason, 'end_turn');
  assert.ok(emitted.some((e) => e.type === 'result'));
  assert.ok(gw.requests.some((r) => r.path === '/v1/runs'));
  driver.close();

  // Another account, with no connection, is told so — and nothing reaches the gateway for it.
  const bob = account('bob');
  const other = `hermes-e2e-${randomUUID().slice(0, 8)}`;
  dbApi.createMission(other, 'hermes.default', 'hello', undefined, bob);
  const before = gw.requests.length;
  const refused = backend.openRemoteSession!({
    spawn: { agentName: 'hermes.default', systemPrompt: '', message: 'hello', resumeSession: null, cfg: { model: 'hermes/default' }, missionId: other } as unknown as BuildSpawnOpts,
    host: { emit: () => undefined, requestPermission: async () => ({ allow: false }), end: () => undefined, saveResume: () => undefined },
  });
  await assert.rejects(refused.start(), /No Hermes gateway is configured for your account/);
  assert.equal(gw.requests.length, before);
});

test('a skill checked on a gateway agent reaches the gateway as its body, not as a line pointing at Rooks\'s disk', async () => {
  const { service } = await loaded();
  const gw = await startFakeGateway();
  cleanup.push(() => gw.close());
  const ada = account('ada');
  await service.create({ userId: ada, isAdmin: true }, {
    type: 'hermes-gateway:gateway@1', label: 'Ada\'s Hermes', url: gw.url, allowPrivateNetwork: true,
    config: {}, secrets: { apiKey: 'gateway-default-key-0001' },
  });
  upsertSkill('gw-skill', '---\nname: gw-skill\ndescription: Gateway procedure.\n---\n\nGATEWAY SKILL BODY\n');
  upsertAgent({ name: 'hermes.skilled', system_prompt: 'Witness.', config: { backend: 'hermes-gateway', model: 'hermes/default', memory_scope: 'NONE', skills: ['gw-skill'] } });
  const backend = getBackend('hermes-gateway');
  const systemPrompt = buildEffectivePrompt('hermes.skilled', loadConfig('hermes.skilled'), backend);
  const missionId = `hermes-e2e-${randomUUID().slice(0, 8)}`;
  dbApi.createMission(missionId, 'hermes.skilled', 'hello', undefined, ada);
  const driver = backend.openRemoteSession!({
    spawn: { agentName: 'hermes.skilled', systemPrompt, message: 'hello', resumeSession: null, cfg: { model: 'hermes/default' }, missionId } as unknown as BuildSpawnOpts,
    host: { emit: () => undefined, requestPermission: async () => ({ allow: false }), end: () => undefined, saveResume: () => undefined },
  });
  await driver.start();
  await driver.prompt('hello');
  driver.close();
  const [run] = [...gw.runs.values()];
  const instructions = run?.body.instructions ?? '';
  assert.ok(instructions.includes('GATEWAY SKILL BODY'), 'what the gateway receives carries the procedure');
  assert.ok(!instructions.includes('skill_get'), 'a tool it was not handed');
  assert.ok(!instructions.includes('SKILL.md'), 'a file it cannot open');
});

test('creating the agents: an agent manager may — the backend starts nothing here — an account without agents:manage may not', async () => {
  const { plugin } = await loaded();
  const connections: PluginUserConnection[] = [
    { id: 'c1', pluginId: 'hermes-gateway', type: 'hermes-gateway:gateway@1', identity: { ownerUserId: 'x' } as PluginUserConnection['identity'], label: 'Default', url: 'https://gw.example', allowPrivateNetwork: false, config: {}, secrets: ['apiKey'], approval: 'approved', enabled: true, revision: 1 },
    { id: 'c2', pluginId: 'hermes-gateway', type: 'hermes-gateway:gateway@1', identity: { ownerUserId: 'x' } as PluginUserConnection['identity'], label: 'Coder', url: 'https://gw.example', allowPrivateNetwork: false, config: { profile: 'Coder' }, secrets: ['apiKey'], approval: 'approved', enabled: true, revision: 1 },
    { id: 'c3', pluginId: 'hermes-gateway', type: 'hermes-gateway:gateway@1', identity: { ownerUserId: 'x' } as PluginUserConnection['identity'], label: 'Pending', url: 'https://gw.example', allowPrivateNetwork: false, config: { profile: 'writer' }, secrets: ['apiKey'], approval: 'pending', enabled: true, revision: 1 },
  ];
  // No `agents:manage`: refused whatever the backend.
  await assert.rejects(runPluginRequest(as('plain', false, []), () => lib.syncAgents(plugin, connections)));
  assert.equal(getAgent('hermes.coder') ?? null, null);
  // A remote backend runs on someone else's host: a manager may point agents at
  // it (the connection that serves a mission is the launching account's own).
  const report = await runPluginRequest(as('manager', false, ['agents:manage']), () => lib.syncAgents(plugin, connections));
  assert.deepEqual(report, { created: ['hermes.default', 'hermes.coder'], updated: [], kept: [], skipped: [] });
  assert.equal(getAgent('hermes.coder')?.backend, 'hermes-gateway');
  assert.equal(getAgent('hermes.coder')?.model, 'hermes/Coder');
  const again = await runPluginRequest(as('root', true, []), () => lib.syncAgents(plugin, connections));
  assert.deepEqual(again.kept, ['hermes.default', 'hermes.coder'], 'a second click restarts nothing');
});

test('two gateways on one profile: one agent per connection, the door agent untouched, another account never re-points them', async () => {
  const { plugin } = await loaded();
  const manager = as('manager', false, ['agents:manage']);
  const door = getAgent('hermes.default')?.model;
  const ada = [gatewayOf(randomUUID(), 'Home', 'ada'), gatewayOf(randomUUID(), 'Work', 'ada'), gatewayOf(randomUUID(), 'Writer', 'ada', { profile: 'writer' })];
  const report = await runPluginRequest(manager, () => lib.syncAgents(plugin, ada));
  // `writer` has one gateway: its door agent. `default` has two: one agent each.
  assert.deepEqual(report, { created: ['hermes.home.default', 'hermes.work.default', 'hermes.writer'], updated: [], kept: [], skipped: [] });
  assert.equal(getAgent('hermes.home.default')?.model, `hermes/${ada[0]!.id}/default`);
  assert.equal(getAgent('hermes.work.default')?.model, `hermes/${ada[1]!.id}/default`);
  assert.equal(getAgent('hermes.writer')?.model, 'hermes/writer');
  assert.equal(getAgent('hermes.default')?.model, door, 'the door agent of before is neither renamed nor re-pointed');
  const again = await runPluginRequest(manager, () => lib.syncAgents(plugin, ada));
  assert.deepEqual(again, { created: [], updated: [], kept: ['hermes.home.default', 'hermes.work.default', 'hermes.writer'], skipped: [] });

  // Bob labels his gateways alike: his agents get the start of the connection id, Ada's keep their routing.
  const bob = [gatewayOf(randomUUID(), 'Home', 'bob'), gatewayOf(randomUUID(), 'Work', 'bob')];
  const his = await runPluginRequest(as('bob', false, ['agents:manage']), () => lib.syncAgents(plugin, bob));
  const suffixed = bob.map((c) => `hermes.${c.label.toLowerCase()}-${c.id.slice(0, 8)}.default`);
  assert.deepEqual(his, { created: suffixed, updated: [], kept: [], skipped: [] });
  assert.equal(getAgent('hermes.home.default')?.model, `hermes/${ada[0]!.id}/default`);
  assert.equal(getAgent(suffixed[0]!)?.model, `hermes/${bob[0]!.id}/default`);

  // Two of one account's gateways labelled alike: the second takes the id.
  const twins = [gatewayOf(randomUUID(), 'Lab', 'cleo'), gatewayOf(randomUUID(), 'Lab', 'cleo')];
  const cleo = await runPluginRequest(as('cleo', false, ['agents:manage']), () => lib.syncAgents(plugin, twins));
  assert.deepEqual(cleo.created, ['hermes.lab.default', `hermes.lab-${twins[1]!.id.slice(0, 8)}.default`]);
  // Relabelled, a connection keeps its agent: it is found by its routing.
  const relabelled = await runPluginRequest(as('cleo', false, ['agents:manage']), () => lib.syncAgents(plugin, [{ ...twins[0]!, label: 'Garage' }, twins[1]!]));
  assert.deepEqual(relabelled.kept, ['hermes.lab.default', `hermes.lab-${twins[1]!.id.slice(0, 8)}.default`]);
  assert.deepEqual(relabelled.created, []);
});

test('end to end: two gateways of one account, each agent reaches its own; the status names them; a deleted connection is said', async () => {
  const { service, plugin, app } = await loaded();
  const attic = await startFakeGateway({ key: 'attic-key-00000000001' });
  const cellar = await startFakeGateway({ key: 'cellar-key-0000000002' });
  cleanup.push(() => attic.close(), () => cellar.close());
  const ada = account('ada');
  const actor = { userId: ada, isAdmin: true };
  const a = await service.create(actor, { type: 'hermes-gateway:gateway@1', label: 'Attic', url: attic.url, allowPrivateNetwork: true, config: {}, secrets: { apiKey: 'attic-key-00000000001' } });
  const c = await service.create(actor, { type: 'hermes-gateway:gateway@1', label: 'Cellar', url: cellar.url, allowPrivateNetwork: true, config: {}, secrets: { apiKey: 'cellar-key-0000000002' } });
  const mine = await plugin.connections.forUser(ada);
  const report = await runPluginRequest(as(ada, false, ['agents:manage']), () => lib.syncAgents(plugin, mine));
  assert.deepEqual(report.created, ['hermes.attic.default', 'hermes.cellar.default']);

  const backend = getBackend('hermes-gateway');
  const launchAs = (owner: string, agentName: string) => {
    const missionId = `hermes-multi-${randomUUID().slice(0, 8)}`;
    dbApi.createMission(missionId, agentName, 'hello', undefined, owner);
    return backend.openRemoteSession!({
      spawn: { agentName, systemPrompt: '', message: 'hello', resumeSession: null, cfg: { model: getAgent(agentName)!.model }, missionId } as unknown as BuildSpawnOpts,
      host: { emit: () => undefined, requestPermission: async () => ({ allow: false }), end: () => undefined, saveResume: () => undefined },
    });
  };
  for (const [agentName, reached, idle] of [['hermes.cellar.default', cellar, attic], ['hermes.attic.default', attic, cellar]] as const) {
    const before = idle.requests.length;
    const driver = launchAs(ada, agentName);
    await driver.start();
    assert.equal((await driver.prompt('hello')).stopReason, 'end_turn');
    assert.ok(reached.requests.some((r) => r.path === '/v1/runs'), `${agentName} reaches its gateway`);
    assert.equal(idle.requests.length, before, `${agentName} never reaches the other one`);
    driver.close();
  }

  // The settings say which agent reaches which gateway.
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const status = await fetch(`http://127.0.0.1:${port}/api/plugins/hermes-gateway/status`, { headers: { 'x-test-user': ada } });
  assert.equal(status.status, 200);
  const body = await status.json() as { connections: Array<{ id: string; state: string; agents: string[] }> };
  const byId = new Map(body.connections.map((x) => [x.id, x]));
  assert.equal(byId.get(a.id)?.state, 'ok');
  assert.ok(byId.get(a.id)?.agents.includes('hermes.attic.default'));
  assert.ok(byId.get(a.id)?.agents.includes('hermes.default'), 'the door agent reaches the first usable gateway');
  assert.deepEqual(byId.get(c.id)?.agents, ['hermes.cellar.default']);
  assert.doesNotMatch(JSON.stringify(body), /attic-key|cellar-key/);

  // Bob may not use Ada's gateway through her agent.
  const bob = account('bob');
  const before = cellar.requests.length;
  await assert.rejects(launchAs(bob, 'hermes.cellar.default').start(), /it was deleted, or it belongs to another account/);
  assert.equal(cellar.requests.length, before);
  // Ada deletes the connection: her agent says so, and the other one still works.
  service.remove(actor, c.id);
  await assert.rejects(launchAs(ada, 'hermes.cellar.default').start(), (err: Error) => /it was deleted/.test(err.message) && !err.message.includes('127.0.0.1'));
  const still = launchAs(ada, 'hermes.attic.default');
  await still.start();
  still.close();
});

test('the routes answer the signed-in caller only: an anonymous request is refused', async () => {
  const { app } = await loaded();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const status = await fetch(`http://127.0.0.1:${port}/api/plugins/hermes-gateway/status`);
  assert.equal(status.status, 401);
  const agents = await fetch(`http://127.0.0.1:${port}/api/plugins/hermes-gateway/agents`, { method: 'POST' });
  assert.equal(agents.status, 401);
});

test('the real loader admits and activates the package (permissions, settings.section, API 7)', async () => {
  const app = express();
  app.use(express.json());
  const ctx = new Context();
  await ctx.plugin(createHttpPlugin(app));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const dir = mkdtempSync(join(tmpdir(), 'rooks-hermes-loader-'));
  const dest = join(dir, 'node_modules', '@rooks', 'plugin-hermes-gateway');
  mkdirSync(join(dir, 'node_modules', '@rooks'), { recursive: true });
  symlinkSync(PACKAGE, dest, 'dir');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'rooks-plugins', private: true, dependencies: { '@rooks/plugin-hermes-gateway': 'file:hermes' } }));
  const loader = new PluginLoader(ctx, { dir, host: daemonHost(ctx), plugins: () => ({}), allowUnsigned: () => true });
  attachPluginLoader(app, loader);
  try {
    const [record] = await loader.update();
    assert.equal(record?.state, 'active', `refused: ${record?.error ?? 'unknown reason'}`);
    assert.equal(isBackendName('hermes-gateway'), true);
    const port = (server.address() as { port: number }).port;
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/plugins/hermes-gateway/status`)).status, 401);
  } finally {
    await loader.dispose();
    await new Promise<void>((resolve) => { server.close(() => resolve()); (server as { closeAllConnections?: () => void }).closeAllConnections?.(); });
    await ctx.fiber.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(isBackendName('hermes-gateway'), false, 'unloading takes the backend away');
});
