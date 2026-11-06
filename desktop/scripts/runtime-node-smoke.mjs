// Opt-in, headless: the two runtimes of a package, checked on the build machine.
//
//  - TIMON_TEST_ELECTRON_NODE points at a DISPOSABLE COPY of the Electron
//    binary: it receives the release fuses and must no longer run as Node
//    (RunAsNode off, TODO #764). The GUI is never started: on Linux the probe
//    runs without a display and ends on its own.
//  - The Node the package ships (TIMON_TEST_BUNDLED_NODE, by default the one
//    `fetch-node.mjs` fetched) is the pinned version, has `node:sqlite`, and
//    starts the daemon (TIMON_TEST_DAEMON_ENTRY, by default
//    ../orchestrator/dist/boot.js) on a throwaway home until /api/health answers.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flipFuses, getCurrentFuseWire, FuseState, FuseV1Options } from '@electron/fuses';
import { runtimeFuses } from './release-hooks.mjs';
import { bundledNodeExecutable, nodeRuntimeSpec } from './fetch-node.mjs';

const executable = process.env.TIMON_TEST_ELECTRON_NODE;
if (!executable) throw new Error('Point TIMON_TEST_ELECTRON_NODE at a DISPOSABLE COPY of the Electron binary');
const relativePath = relative(realpathSync(tmpdir()), realpathSync(executable));
if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
  throw new Error('The disposable Electron copy must be inside the OS temporary directory');
}
const node = process.env.TIMON_TEST_BUNDLED_NODE || bundledNodeExecutable();
if (!existsSync(node)) throw new Error(`${node} is missing: run prepare:deps (fetch-node.mjs) or point TIMON_TEST_BUNDLED_NODE at the Node the package ships`);
const entry = process.env.TIMON_TEST_DAEMON_ENTRY || resolve(fileURLToPath(new URL('../../orchestrator/dist/boot.js', import.meta.url)));
if (!existsSync(entry)) throw new Error(`${entry} is missing: build the orchestrator or point TIMON_TEST_DAEMON_ENTRY at its boot.js`);

/** The runtime variables of the shell must never reach either probe. */
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'TIMON_HOME'].includes(key.toUpperCase())) delete env[key];
  }
  return env;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms));

/** Polls the daemon until it answers, exits, or the deadline passes. */
async function waitForHealth(url, child, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let exited = null;
  child.once('exit', (code, signal) => { exited = { code, signal }; });
  while (Date.now() < deadline) {
    if (exited) throw new Error(`the daemon exited before answering (${exited.code ?? exited.signal})`);
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch { /* not listening yet */ }
    await sleep(500);
  }
  throw new Error(`the daemon did not answer ${url} within ${deadlineMs} ms`);
}

async function endDaemon(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise((done) => child.once('exit', done));
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
  else child.kill('SIGTERM');
  const result = await Promise.race([gone.then(() => 'exited'), sleep(15_000).then(() => 'alive')]);
  if (result === 'alive') child.kill('SIGKILL');
}

const root = mkdtempSync(join(tmpdir(), 'timon-runtime-smoke-'));
try {
  // 1. The app's executable, with the release fuses, is not a Node any more.
  await flipFuses(executable, runtimeFuses(process.platform));
  const fuses = await getCurrentFuseWire(executable);
  assert.equal(fuses[FuseV1Options.RunAsNode], FuseState.DISABLE);
  assert.equal(fuses[FuseV1Options.EnableNodeOptionsEnvironmentVariable], FuseState.DISABLE);
  assert.equal(fuses[FuseV1Options.EnableNodeCliInspectArguments], FuseState.DISABLE);
  if (process.platform === 'linux') {
    // Without a display the GUI cannot come up and the process ends on its
    // own; a Node would have printed 2 and exited 0. Elsewhere the probe would
    // open the default Electron window: the fuse wire above is the proof.
    const env = { ...cleanEnv(), ELECTRON_RUN_AS_NODE: '1' };
    delete env.DISPLAY;
    delete env.WAYLAND_DISPLAY;
    const probe = spawnSync(executable, ['-p', '1+1'], { env, encoding: 'utf8', timeout: 20_000 });
    assert.notEqual(probe.stdout.trim(), '2', 'the Electron binary still runs as Node');
    assert.notEqual(probe.status, 0, 'the Electron binary still runs as Node');
  }

  // 2. The Node the package ships is the pinned one and carries node:sqlite.
  const spec = nodeRuntimeSpec();
  const version = spawnSync(node, ['-p', 'process.versions.node'], { env: cleanEnv(), encoding: 'utf8', timeout: 10_000 });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), spec.version);
  const sqlite = spawnSync(node, ['-p', "typeof require('node:sqlite').DatabaseSync"], { env: cleanEnv(), encoding: 'utf8', timeout: 10_000 });
  assert.equal(sqlite.status, 0, sqlite.stderr);
  assert.equal(sqlite.stdout.trim(), 'function');
  // The daemon's heap limit travels as a CLI argument (the environments of the
  // package strip NODE_OPTIONS): the shipped Node must honour it.
  const heap = spawnSync(node, ['--max-old-space-size=512', '-p', "require('node:v8').getHeapStatistics().heap_size_limit"], { env: cleanEnv(), encoding: 'utf8', timeout: 10_000 });
  assert.equal(heap.status, 0, heap.stderr);
  assert.ok(Number(heap.stdout) < 700 * 1024 * 1024, heap.stdout);

  // 3. That Node starts the daemon, as the shell and the services do.
  const home = join(root, 'home');
  const port = await freePort();
  const daemon = spawn(node, ['--max-old-space-size=512', entry], {
    env: {
      ...cleanEnv(),
      TIMON_HOME: home,
      PORT: String(port),
      TIMON_APP_ENABLED: '0',
      TIMON_RESOURCE_GUARD_ENABLED: '0',
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  daemon.stdout.on('data', (chunk) => { output += chunk; });
  daemon.stderr.on('data', (chunk) => { output += chunk; });
  try {
    const health = await waitForHealth(`http://127.0.0.1:${port}/api/health`, daemon, 90_000);
    assert.ok(health && typeof health === 'object', 'health must be a JSON object');
  } catch (error) {
    throw new Error(`${error.message}\n--- daemon output ---\n${output.slice(-4000)}`);
  } finally {
    await endDaemon(daemon);
  }
  console.log(`Packaged runtimes verified: Electron no longer runs as Node, Node ${spec.version} carries node:sqlite and starts the daemon`);
} finally { rmSync(root, { recursive: true, force: true }); }
