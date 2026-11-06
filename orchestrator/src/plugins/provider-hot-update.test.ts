/**
 * A provider plugin updated while the daemon runs: the new code takes over
 * without a restart, and the backend it provides never disappears from the
 * registry in between (a mission dispatched mid-update must not run elsewhere).
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';

const { createHttpPlugin } = await import('../kernel/http-service.js');
const { PluginLoader } = await import('./loader.js');
const { daemonHost } = await import('./context.js');
const { TimonConfigSchema } = await import('../config/schema.js');
const { setConfig, resetConfig } = await import('../config/load.js');
const { resetPluginPolicyState } = await import('./policy.js');
const { getBackend, isBackendName } = await import('../backends/index.js');

const PKG = '@acme/hot-provider';

function writePlugin(root: string, version: string, tag: string, dropsBackend = false, persistent = false): string {
  const dir = join(root, 'node_modules', PKG);
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: PKG, version, type: 'module', main: 'lib/index.js',
    timon: {
      id: 'hot-provider', apiVersion: 10, kind: 'provider', permissions: ['backends:register'],
      provider: { binaries: [{ name: 'echo' }] },
    },
  }));
  writeFileSync(join(dir, 'lib', 'tag.js'), `export const TAG = '${tag}'\n`);
  writeFileSync(join(dir, 'lib', 'index.js'), `
import { TAG } from './tag.js'
export const name = 'hot-provider'
export function apply(ctx) {
  ctx.backends.registerDialect('hot-echo', {
    id: 'hot-echo', defaultCmd: 'echo', persistentProcess: ${persistent}, finishMissionOnExit: ${persistent},
    sessionResumable: true, sessionStore: 'global', permissionModel: 'none', rateLimitReporting: 'none',
    hostedConnectors: false,
    async buildSpawn(opts, profile) { return { cmd: profile.cmd, args: [TAG], env: {}, cwd: opts.cfg.cwd, initialStdin: null } },
    writeUserInput() {}, parseLine() { return [] }, extractSessionId() { return null },
  })
  ${dropsBackend ? '' : `ctx.backends.registerProfile({
    id: 'hot-llm', dialect: 'hot-echo', label: 'Hot', vendor: 'Acme', custom: true,
    defaultModel: 'm-1', models: [{ slug: 'm-1', label: 'm-1' }],
  })`}
}
`);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'timon-plugins', private: true, dependencies: { [PKG]: 'file:fixture' } }));
  return dir;
}

async function tagOf(): Promise<string> {
  const spawned = await getBackend('hot-llm').buildSpawn({
    agentName: 'timon.test', systemPrompt: 's', message: 'hi', resumeSession: null,
    cfg: { cwd: tmpdir(), model: 'm-1', permission_mode: 'auto' }, missionId: 'm',
  });
  return spawned.args[0] ?? '';
}

test('a new version of a provider takes over live, with no moment where its backend is missing', async () => {
  setConfig(TimonConfigSchema.parse({ pluginPolicy: { exec: { allow: ['echo'] } } }));
  resetPluginPolicyState();
  const app = express();
  const ctx = new Context();
  await ctx.plugin(createHttpPlugin(app));
  const root = mkdtempSync(join(tmpdir(), 'timon-hot-provider-'));
  writePlugin(root, '1.0.0', 'one');
  const loader = new PluginLoader(ctx, { dir: root, host: daemonHost(ctx), allowUnsigned: () => true });
  try {
    const [first] = await loader.update();
    assert.equal(first?.state, 'active', first?.error ?? '');
    assert.equal(await tagOf(), 'one');

    // Sample the registry on every turn of the event loop while the swap runs.
    const missing: string[] = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        if (!isBackendName('hot-llm')) missing.push('missing');
        await new Promise((r) => setImmediate(r));
      }
    })();

    writePlugin(root, '1.0.1', 'two');
    const [second] = await loader.update();
    sampling = false;
    await sampler;

    assert.equal(second?.state, 'active', second?.error ?? '');
    assert.equal(second?.version, '1.0.1');
    assert.deepEqual(missing, [], 'the backend was dispatchable during the whole swap');
    assert.equal(await tagOf(), 'two', 'the new code answers');

    // A version that drops the backend removes it, with no restart either.
    writePlugin(root, '1.0.2', 'three', true);
    await loader.update();
    assert.equal(isBackendName('hot-llm'), false);
    assert.throws(() => getBackend('hot-llm'), /not available/);
  } finally {
    await loader.dispose();
    await ctx.fiber.dispose();
    rmSync(root, { recursive: true, force: true });
    resetConfig();
    resetPluginPolicyState();
  }
});

async function mounted(options: { inFlight?: () => ReadonlySet<string>; enabled?: () => boolean } = {}) {
  setConfig(TimonConfigSchema.parse({ pluginPolicy: { exec: { allow: ['echo'] } } }));
  resetPluginPolicyState();
  const app = express();
  const ctx = new Context();
  await ctx.plugin(createHttpPlugin(app));
  const root = mkdtempSync(join(tmpdir(), 'timon-hot-provider-'));
  const loader = new PluginLoader(ctx, {
    dir: root, host: daemonHost(ctx), allowUnsigned: () => true,
    ...(options.inFlight ? { backendsInFlight: options.inFlight } : {}),
    ...(options.enabled ? { plugins: () => ({ 'hot-provider': options.enabled!() }) } : {}),
  });
  return {
    root, loader,
    close: async () => { await loader.dispose(); await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }); resetConfig(); resetPluginPolicyState(); },
  };
}

test('an update waits for the missions running on the provider, then applies', async () => {
  let busy = false;
  const env = await mounted({ inFlight: () => new Set(busy ? ['hot-llm'] : []) });
  try {
    writePlugin(env.root, '1.0.0', 'one');
    assert.equal((await env.loader.update())[0]?.state, 'active');
    assert.equal(await tagOf(), 'one');

    busy = true;
    writePlugin(env.root, '1.0.1', 'two');
    const [waiting] = await env.loader.update();
    assert.equal(waiting?.state, 'active');
    assert.equal(waiting?.reason, 'update-pending');
    assert.equal(waiting?.version, '1.0.0', 'the running version is the one reported');
    assert.equal(await tagOf(), 'one', 'the mission keeps its provider');

    busy = false;
    const [applied] = await env.loader.update();
    assert.equal(applied?.reason, null);
    assert.equal(applied?.version, '1.0.1');
    assert.equal(await tagOf(), 'two');
  } finally { await env.close(); }
});

test('an update that changes transport is refused live: the running version stays, nothing disappears', async () => {
  const env = await mounted();
  try {
    writePlugin(env.root, '1.0.0', 'one');
    await env.loader.update();
    const missing: number[] = [];
    let sampling = true;
    const sampler = (async () => { while (sampling) { if (!isBackendName('hot-llm')) missing.push(1); await new Promise((r) => setImmediate(r)); } })();

    writePlugin(env.root, '2.0.0', 'persistent', false, true);
    const [refused] = await env.loader.update();
    assert.equal(refused?.state, 'active');
    assert.equal(refused?.reason, 'update-refused');
    assert.equal(refused?.version, '1.0.0');
    assert.match(refused?.error ?? '', /transport changed/);
    // The same files are not judged twice.
    const [again] = await env.loader.update();
    sampling = false; await sampler;
    assert.equal(again?.reason, 'update-refused');
    assert.deepEqual(missing, [], 'the backend never left the registry');
    assert.equal(await tagOf(), 'one', 'the old version still answers');

    // A compatible version afterwards applies normally.
    writePlugin(env.root, '2.0.1', 'compatible');
    const [fixed] = await env.loader.update();
    assert.equal(fixed?.reason, null);
    assert.equal(await tagOf(), 'compatible');
  } finally { await env.close(); }
});

test('a waiting update asks again only once a mission is gone, and stops asking when the plugin goes', async (t) => {
  let busy = true;
  let enabled = true;
  const env = await mounted({ inFlight: () => new Set(busy ? ['hot-llm'] : []), enabled: () => enabled });
  try {
    writePlugin(env.root, '1.0.0', 'one');
    busy = false;
    await env.loader.update();
    busy = true;
    writePlugin(env.root, '1.0.1', 'two');

    let reconciles = 0;
    const realUpdate = env.loader.update.bind(env.loader);
    t.mock.method(env.loader, 'update', () => { reconciles += 1; return realUpdate(); });
    t.mock.timers.enable({ apis: ['setTimeout'] });

    // First pass defers and arms the timer.
    const waiting = await realUpdate();
    assert.equal(waiting[0]?.reason, 'update-pending');

    // The mission lives on: the timer looks, and does NOT reconcile.
    t.mock.timers.tick(5_000);
    t.mock.timers.tick(5_000);
    assert.equal(reconciles, 0, 'a cheap look, not a full reconciliation, while the mission lives');

    // The mission ends: the next look reconciles once and the update lands.
    busy = false;
    t.mock.timers.tick(5_000);
    assert.equal(reconciles, 1);
    await new Promise((done) => setImmediate(done));
    await new Promise((done) => setImmediate(done));

    // A second update, deferred again, then the plugin is switched off.
    busy = true;
    writePlugin(env.root, '1.0.2', 'three');
    assert.equal((await realUpdate())[0]?.reason, 'update-pending');
    reconciles = 0;
    enabled = false;
    assert.equal((await realUpdate())[0]?.state, 'disabled');
    reconciles = 0;
    t.mock.timers.tick(5_000);
    t.mock.timers.tick(5_000);
    busy = false;
    t.mock.timers.tick(5_000);
    assert.equal(reconciles, 0, 'nothing is left waiting once the plugin is off');
  } finally { await env.close(); }
});

for (const backend of ['hot-llm@account123', 'rider-llm', 'rider-llm@account123']) {
  test(`an update also waits for ${backend}, including a profile supplied by another plugin`, async () => {
    let busy = false;
    const env = await mounted({ inFlight: () => new Set(busy ? [backend] : []) });
    const { registerProfile } = await import('../backends/registry.js');
    let off: (() => void) | undefined;
    try {
      writePlugin(env.root, '1.0.0', 'one', false, true);
      await env.loader.update();
      off = registerProfile('rider-plugin', { id: 'rider-llm', dialect: 'hot-echo', label: 'Rider', defaultModel: 'm', models: [] });
      busy = true;
      writePlugin(env.root, '1.0.1', 'two', false, true);
      assert.equal((await env.loader.update())[0]?.reason, 'update-pending');
      assert.equal(await tagOf(), 'one');
      busy = false;
      assert.equal((await env.loader.update())[0]?.reason, null);
      assert.equal(await tagOf(), 'two');
    } finally { off?.(); await env.close(); }
  });
}
