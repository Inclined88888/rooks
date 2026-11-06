/**
 * TODO #614 — a promise rejection nobody handled (a plugin's fire-and-forget,
 * timer or bus listener) must not take the daemon down, and must be put on
 * the name of whoever caused it. The process-level behaviour is proved in a
 * child process: in this one, the test runner has listeners of its own.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const {
  createRejectionReporter, guardPluginCallback, rejectionOwner, setPluginSource, clearPluginSource,
  REPEAT_WINDOW_MS, NOTIFY_WINDOW_MS,
} = await import('./rejection-guard.js');
const { createPluginContext, daemonHost } = await import('../plugins/context.js');
const { readManifest, PLUGIN_API_VERSION } = await import('../plugins/manifest.js');
const { bus } = await import('../bus.js');

const GUARD_URL = new URL('./rejection-guard.ts', import.meta.url).href;
const SECRET = 'sk-witness-secret-must-not-leak';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'timon-rejection-'));
}

/** A plugin package on disk whose code builds its errors itself, so their stack names its file. */
function pluginPackage(root: string, body: string): string {
  const dir = join(root, 'node_modules', 'acme-plugin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.mjs'), body);
  return dir;
}

async function runChild(dir: string, script: string): Promise<{ code: number | null; output: string }> {
  const file = join(dir, 'witness.mjs');
  writeFileSync(file, script);
  const child = spawn(process.execPath, ['--import', 'tsx', file], {
    cwd: process.cwd(),
    env: { ...process.env, TIMON_RESOURCE_GUARD_ENABLED: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const [code] = await once(child, 'exit') as [number | null];
  return { code, output };
}

const PLUGIN_BODY = `
export function forgetful() {
  // Fire-and-forget, and a timer: the two shapes #580 could not reach.
  void Promise.reject(new Error('acme fire-and-forget ${SECRET}'));
  setTimeout(async () => { throw new Error('acme timer'); }, 0);
}
`;

test('with the guard, a rejection nobody handled no longer ends the process, and names the plugin', { timeout: 30_000 }, async () => {
  const dir = tempDir();
  try {
    const pkg = pluginPackage(dir, PLUGIN_BODY);
    const { code, output } = await runChild(dir, `
      import { installRejectionGuard, setPluginSource } from ${JSON.stringify(GUARD_URL)};
      installRejectionGuard({ notify: (id) => console.log('notified ' + id) });
      setPluginSource('acme', ${JSON.stringify(pkg)});
      // Hot reload imports a plugin under ?rev=: its frames carry the query.
      const plugin = await import(${JSON.stringify(pathToFileURL(join(pkg, 'index.mjs')).href + '?rev=7')});
      plugin.forgetful();
      void Promise.reject(new Error('core forgot'));
      setTimeout(() => { console.log('still alive'); process.exit(0); }, 300);
    `);
    assert.equal(code, 0, output);
    assert.match(output, /still alive/);
    assert.match(output, /\[unhandled-rejection\] plugin `acme`: .*keeps running/);
    assert.match(output, /acme timer/);
    assert.match(output, /\[unhandled-rejection\] the daemon: .*\n.*core forgot/);
    // One notice per plugin, and it carries the id only.
    assert.equal(output.match(/notified acme/g)?.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('without the guard, the same rejection ends the process — what the daemon did before #614', { timeout: 30_000 }, async () => {
  const dir = tempDir();
  try {
    const pkg = pluginPackage(dir, PLUGIN_BODY);
    const { code, output } = await runChild(dir, `
      const plugin = await import(${JSON.stringify(pathToFileURL(join(pkg, 'index.mjs')).href)});
      plugin.forgetful();
      setTimeout(() => { console.log('still alive'); process.exit(0); }, 300);
    `);
    assert.equal(code, 1, output);
    assert.doesNotMatch(output, /still alive/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the guard does not swallow a synchronous throw nor an entry point that fails to boot', { timeout: 30_000 }, async () => {
  const dir = tempDir();
  try {
    const sync = await runChild(dir, `
      import { installRejectionGuard } from ${JSON.stringify(GUARD_URL)};
      installRejectionGuard({ notify: () => {} });
      setTimeout(() => { throw new Error('torn sync state'); }, 0);
      setTimeout(() => { console.log('still alive'); process.exit(0); }, 300);
    `);
    assert.equal(sync.code, 1, sync.output);
    assert.doesNotMatch(sync.output, /still alive/);

    const boot = await runChild(dir, `
      import { installRejectionGuard } from ${JSON.stringify(GUARD_URL)};
      installRejectionGuard({ notify: () => {} });
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('boot failed');
    `);
    assert.equal(boot.code, 1, boot.output);
    assert.match(boot.output, /boot failed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('attribution: a plugin frame anywhere in the stack wins, then a bundled module, else the core', async () => {
  const dir = tempDir();
  try {
    const pkg = pluginPackage(dir, 'export function fail() { return Promise.reject(new Error("from acme")); }\n');
    setPluginSource('acme', pkg);
    const mod = await import(pathToFileURL(join(pkg, 'index.mjs')).href + '?rev=3') as { fail(): Promise<void> };
    const fromPlugin = await mod.fail().catch((err: unknown) => err);
    assert.deepEqual(rejectionOwner(fromPlugin), { kind: 'plugin', id: 'acme' });

    // The core frame that threw sits on top; the plugin that called it is deeper.
    const viaFacade = new Error('facade refused');
    viaFacade.stack = `Error: facade refused\n    at assert (${join(dir, 'src', 'plugins', 'context.ts')}:10:5)\n    at async ${pathToFileURL(join(pkg, 'index.mjs')).href}?rev=3:1:30`;
    assert.deepEqual(rejectionOwner(viaFacade), { kind: 'plugin', id: 'acme' });

    const bundled = new Error('module');
    bundled.stack = `Error: module\n    at tick (${join(dir, 'dist', 'plugins-bundled', 'scheduler', 'index.js')}:4:2)`;
    assert.deepEqual(rejectionOwner(bundled), { kind: 'module', id: 'scheduler' });

    assert.deepEqual(rejectionOwner(new Error('plain')), { kind: 'core' });
    assert.deepEqual(rejectionOwner('a string'), { kind: 'core' });
    assert.deepEqual(rejectionOwner(undefined), { kind: 'core' });

    clearPluginSource('acme');
    assert.deepEqual(rejectionOwner(fromPlugin), { kind: 'core' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failure repeating inside the window is counted, not printed; a plugin is notified once an hour', () => {
  let now = 1_000_000;
  const lines: string[] = [];
  const notices: string[] = [];
  const report = createRejectionReporter({ log: (l) => void lines.push(l), notify: (id) => void notices.push(id), now: () => now });
  const owner = { kind: 'plugin', id: 'loopy' } as const;
  for (let i = 0; i < 50; i++) { report(new Error(`interval failed ${SECRET}`), { owner }); now += 100; }
  assert.equal(lines.length, 1, 'fifty identical failures in five seconds: one line');
  now += REPEAT_WINDOW_MS;
  report(new Error(`interval failed ${SECRET}`), { owner });
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /49 identical failure\(s\) not shown/);
  assert.deepEqual(notices, ['loopy'], 'one notice, not one per failure');
  now += NOTIFY_WINDOW_MS;
  report(new Error('another'), { owner });
  assert.deepEqual(notices, ['loopy', 'loopy']);

  report(new Error('core'), { owner: { kind: 'core' } });
  report(new Error('module'), { owner: { kind: 'module', id: 'scheduler' } });
  assert.equal(notices.length, 2, 'only a plugin is the human\'s to act on');
});

test('a guarded plugin callback that throws does not throw into the daemon code that called it', () => {
  const guarded = guardPluginCallback('acme', 'event task_done', () => { throw new Error('x'); });
  assert.doesNotThrow(() => guarded());
});

function manifestOf(id: string, permissions: string[]) {
  const res = readManifest({ timon: { id, apiVersion: PLUGIN_API_VERSION, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  return res.manifest;
}

test('a plugin event listener that throws or rejects stays its own failure: the publisher and the next listener carry on', async () => {
  const escaped: unknown[] = [];
  const onUnhandled = (reason: unknown) => { escaped.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  const logged: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  const root = new Context();
  try {
    let inner!: Context;
    await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
    const host = daemonHost(root);
    const thrower = createPluginContext(inner, { manifest: manifestOf('thrower', ['events:subscribe']), version: '1.0.0' }, host);
    const bystander = createPluginContext(inner, { manifest: manifestOf('bystander', ['events:subscribe']), version: '1.0.0' }, host);

    thrower.events.on('task_done', () => { throw new Error(`sync listener ${SECRET}`); });
    thrower.events.on('task_done', async () => { throw new Error('async listener'); });
    const seen: string[] = [];
    bystander.events.on('task_done', (ev) => void seen.push((ev as { taskId: string }).taskId));

    assert.doesNotThrow(() => bus.publish({ kind: 'task_done', taskId: 't1' }), 'the write that published must not fail');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(seen, ['t1'], 'the listener after the faulty one still receives the event');
    assert.deepEqual(escaped, [], 'nothing reaches the process as unhandled');
    assert.ok(logged.some((l) => /plugin `thrower` in event task_done/.test(l) && /sync listener/.test(l)), logged.join('\n'));
    assert.ok(logged.some((l) => /plugin `thrower` in event task_done/.test(l) && /async listener/.test(l)), logged.join('\n'));
  } finally {
    console.error = consoleError;
    process.off('unhandledRejection', onUnhandled);
    await root.fiber.dispose();
  }
});
