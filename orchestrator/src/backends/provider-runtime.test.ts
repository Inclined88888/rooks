/**
 * The split of the provider kit (decision of 18/10/2026): behaviour comes from
 * the daemon through `ctx.provider.runtime`, the package keeps types and constants.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const kit = await import('../../../packages/sdk/src/provider.js') as Record<string, unknown>;
const testing = await import('../../../packages/sdk/src/testing.js') as Record<string, unknown>;
const { providerRuntime } = await import('./provider-runtime.js');
const { dialectProblems } = await import('./dialect-check.js');

/** The only functions the package may export: they decide nothing a fix could change. */
const GUARDS = ['isRemoteDialect', 'probeLaunchContext', 'isRemoteDefinition', 'isLineSessionDriver'];

test('the package exports constants and guards, never behaviour', () => {
  const functions = Object.entries(kit).filter(([, value]) => typeof value === 'function').map(([name]) => name).sort();
  assert.deepEqual(functions, [...GUARDS].sort(),
    'a function joined `@rooks/sdk/provider`: behaviour belongs in `provider-runtime.ts`, so that a fix reaches every plugin');
});

test('every namespace of the runtime is frozen and holds only functions, classes and constants', () => {
  for (const [name, namespace] of Object.entries(providerRuntime)) {
    assert.ok(Object.isFrozen(namespace), `runtime.${name} must be frozen`);
    assert.ok(Object.keys(namespace).length > 0, `runtime.${name} is empty`);
  }
});

test('the stand-in ctx of the testing kit carries the same runtime', () => {
  const ctx = (testing.createProviderContext as () => { provider: { runtime: unknown } })();
  assert.equal(ctx.provider.runtime, providerRuntime);
  assert.equal(testing.providerRuntime, providerRuntime);
});

test('the stand-in ctx refuses a plugin that declares an older contract, as the daemon does', () => {
  const ctx = (testing.createProviderContext as (o: { apiVersion: number }) => { provider: { runtime: unknown } })({ apiVersion: 11 });
  assert.throws(() => ctx.provider.runtime, /needs apiVersion 12/);
});

test('the stand-in ctx applies the registration check the daemon applies', () => {
  type Registering = { backends: { registerDialect(id: string, dialect: unknown): unknown } };
  const create = testing.createProviderContext as (o?: { apiVersion: number }) => Registering;
  // `protocol` permission without a session driver: contradicts itself.
  const broken = {
    id: 'broken', defaultCmd: 'x', persistentProcess: false, finishMissionOnExit: false, sessionResumable: false,
    sessionStore: 'global', permissionModel: 'protocol', rateLimitReporting: 'none', hostedConnectors: false,
    buildSpawn: async () => ({ cmd: 'x', args: [], initialStdin: null }), writeUserInput() {}, parseLine: () => [],
    extractSessionId: () => null,
  };
  assert.ok(dialectProblems(broken as never).length > 0, 'the fixture must be incoherent');
  assert.throws(() => create({ apiVersion: 12 }).backends.registerDialect('broken', broken), /contradicts itself/);
  // API ≤ 10: accepted, with the reasons in the log (the previous contract is not tightened).
  assert.doesNotThrow(() => create({ apiVersion: 10 }).backends.registerDialect('broken', broken));
});

test('the stand-in ctx answers S1 and S2 with references and no privilege', async () => {
  type Ctx = { provider: { mcp(s: unknown, o?: unknown): Promise<{ servers: Array<{ role: string; env: Record<string, string> }>; identityEnv: Record<string, string>; permissionTool: string | null }>; env(s: unknown): Promise<{ env: Record<string, string> }> } };
  const create = testing.createProviderContext as (o?: unknown) => Ctx;
  const spawn = { missionId: 'm1', agentName: 'a', cfg: { cwd: '.' } };
  const ctx = create({ baseEnv: { PATH: '/bin' } });
  const plan = await ctx.provider.mcp(spawn);
  assert.deepEqual(plan.servers.map((s) => s.role), ['rooks', 'forms']);
  assert.equal(plan.identityEnv.ROOKS_API_TOKEN, testing.FAKE_TOKEN_REFERENCE);
  assert.equal(plan.servers[1]!.env.ROOKS_ASK_FORMS_ONLY, '1');
  assert.equal((await ctx.provider.mcp(spawn, { permissionPrompt: true })).permissionTool, 'mcp__nova_ask__request');
  const base = await ctx.provider.env(spawn);
  assert.equal(base.env.PATH, '/bin');
  assert.equal(base.env.ROOKS_MISSION_ID, 'm1');
  assert.equal(Object.keys(base.env).some((k) => /token/i.test(k)), false);
});

test('the stand-in ctx registers a native provider with the daemon\'s check, and hands the bench its dialect', () => {
  type Def = Record<string, unknown>;
  type Ctx = {
    provider: { registerProvider(d: Def): () => void; replaceProvider(d: Def): () => void };
    registered: { providers: Map<string, Def>; dialect(id: string): { persistentProcess: boolean; defaultCmd: string } };
  };
  const ctx = (testing.createProviderContext as () => Ctx)();
  const events = (testing.providerRuntime as typeof providerRuntime).events;
  const def: Def = {
    id: 'stand-in', transport: { kind: 'process-per-turn' },
    codec: { kind: 'lines', parseLine: () => [], extractSessionId: events.extractInitSessionId, writeUserInput: () => {} },
    launch: async () => ({ cmd: 'x', args: [], initialStdin: null }),
    session: { store: 'per-mission', resumable: false }, permission: { model: 'sandbox' }, limits: { reporting: 'none' },
    mcp: { rooks: true }, declares: { binary: { names: ['stand-in-cli'] } },
  };
  assert.throws(() => ctx.provider.registerProvider({ ...def, permission: { model: 'protocol' } }), /protocol/);
  ctx.provider.registerProvider(def);
  assert.equal(ctx.registered.dialect('stand-in').defaultCmd, 'stand-in-cli');
  assert.equal(ctx.registered.dialect('stand-in').persistentProcess, false);
  assert.throws(() => ctx.provider.registerProvider(def), /already registered/);
  ctx.provider.replaceProvider({ ...def, session: { store: 'per-mission', resumable: false, maxPromptBytes: 5 } });
  assert.throws(() => ctx.provider.replaceProvider({ ...def, transport: { kind: 'stdio-persistent' }, session: { store: 'per-mission', resumable: true } }), /transport changed/);
  assert.throws(() => ctx.provider.replaceProvider({ ...def, id: 'never-registered' }), /not registered/);
});
