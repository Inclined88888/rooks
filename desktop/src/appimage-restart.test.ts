import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import { queueAppImageRelaunch } from './appimage-restart.js';

const exec = promisify(execFile);
const electron = fileURLToPath(new URL('../node_modules/electron/dist/electron', import.meta.url));
const linux = process.platform === 'linux';
// A sandboxed shell (Codex, a container, a hardened unit) may hand the whole
// test tree NoNewPrivs=1: no child can lose it, so fusermount's setuid is void.
const inheritsNoNewPrivs = linux && /^NoNewPrivs:\s*1/m.test(readFileSync('/proc/self/status', 'utf8'));
// A real Electron start under a loaded full suite can take well over 10 s.
// Two modes x (launch + result) must stay under the 2 min per-test limit.
const STEP_MS = 25_000;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'timon-restart-'));
  const home = join(root, 'same home');
  mkdirSync(home);
  writeFileSync(join(home, 'account-fixture'), 'same-account');
  const compiled = ts.transpileModule(readFileSync(new URL('./appimage-restart.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  writeFileSync(join(root, 'restart.mjs'), compiled);
  writeFileSync(join(root, 'target.cjs'), `
const fs = require('node:fs');
const path = require('node:path');
const readParentState = () => {
  try { return fs.readFileSync('/proc/' + process.env.TIMON_TEST_PARENT + '/stat', 'utf8').split(') ')[1][0]; } catch { return null; }
};
// The lifetime pipe reaches EOF once Electron's Node layer has closed its
// handles; Chromium may still be tearing down (state S) for a few ms. What
// matters is that the parent is on its way out, not the exact instant.
let parentState = readParentState();
const exitDeadline = Date.now() + 10000;
while (parentState !== null && parentState !== 'Z' && Date.now() < exitDeadline) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  parentState = readParentState();
}
// Written then renamed: the test polls for the file and must never read it half-written.
const partial = path.join(process.env.TIMON_HOME, 'result.json.partial');
fs.writeFileSync(partial, JSON.stringify({
  noNewPrivs: fs.readFileSync('/proc/self/status', 'utf8').match(/^NoNewPrivs:\\s*(\\d)/m)[1],
  args: process.argv.slice(2), home: process.env.TIMON_HOME, cwd: process.cwd(), parentState,
  account: fs.readFileSync(path.join(process.env.TIMON_HOME, 'account-fixture'), 'utf8'),
}));
fs.renameSync(partial, path.join(process.env.TIMON_HOME, 'result.json'));
`);
  writeFileSync(join(root, 'parent.cjs'), `
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.TIMON_HOME;
app.setPath('userData', path.join(home, 'profile'));
process.env.TIMON_TEST_PARENT = String(process.pid);
fs.writeFileSync(path.join(home, 'parent-privs'), fs.readFileSync('/proc/self/status', 'utf8').match(/^NoNewPrivs:\\s*(\\d)/m)[1]);
(async () => {
  const executable = process.env.TIMON_TEST_EXEC;
  const args = JSON.parse(process.env.TIMON_TEST_ARGS);
  if (process.env.TIMON_TEST_MODE === 'electron') {
    app.relaunch({ execPath: executable, args });
  } else {
    const { queueAppImageRelaunch } = await import('./restart.mjs');
    const cancel = await queueAppImageRelaunch(executable, args, home);
    if (process.env.TIMON_TEST_MODE === 'cancel') cancel();
    // The replacement must still be waiting, even though it was armed.
    await new Promise(resolve => setTimeout(resolve, 80));
    if (fs.existsSync(path.join(home, 'result.json'))) throw new Error('restarted before parent exit');
  }
  app.exit(0);
})().catch(error => { console.error(error); app.exit(1); });
`);
  const env: NodeJS.ProcessEnv = { ...process.env, TIMON_HOME: home, TIMON_TEST_NODE: process.execPath, TIMON_TEST_TARGET: join(root, 'target.cjs') };
  delete env.ELECTRON_RUN_AS_NODE;
  return { root, home, env };
}

async function launch(f: ReturnType<typeof fixture>, mode: string, executable: string, args: string[]) {
  await exec(electron, ['--no-sandbox', '--ozone-platform=headless', join(f.root, 'parent.cjs')], {
    env: { ...f.env, TIMON_TEST_MODE: mode, TIMON_TEST_EXEC: executable, TIMON_TEST_ARGS: JSON.stringify(args) },
    timeout: STEP_MS,
  });
}

async function result(home: string) {
  const file = join(home, 'result.json');
  const deadline = Date.now() + STEP_MS;
  while (!existsSync(file) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(existsSync(file), `No restart result. ${existsSync(join(home, 'tmp/desktop-restart.log')) ? readFileSync(join(home, 'tmp/desktop-restart.log'), 'utf8') : ''}`);
  return JSON.parse(readFileSync(file, 'utf8')) as {
    noNewPrivs: string; args: string[]; home: string; cwd: string; parentState: string | null; account: string;
  };
}

test('real Electron relaunch adds NoNewPrivs, native AppImage handoff preserves it', { skip: !linux }, async () => {
  for (const mode of ['electron', 'native']) {
    const f = fixture();
    try {
      const args = [join(f.root, 'target.cjs'), 'space in argument', '$(not-a-command)', 'quote"value'];
      await launch(f, mode, process.execPath, args);
      const child = await result(f.home);
      const parentPrivs = readFileSync(join(f.home, 'parent-privs'), 'utf8');
      assert.equal(child.noNewPrivs, mode === 'electron' ? '1' : parentPrivs);
      assert.deepEqual(child.args, args.slice(1), 'arguments must remain data');
      assert.equal(child.home, f.home);
      assert.equal(child.account, 'same-account');
      assert.ok(child.parentState === null || child.parentState === 'Z', `the original shell exits after the handoff (${mode}: ${child.parentState})`);
      if (mode === 'native') assert.equal(child.cwd, f.home);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('cancelling an armed AppImage restart does not reopen on exit', { skip: !linux }, async () => {
  const f = fixture();
  try {
    await launch(f, 'cancel', process.execPath, [join(f.root, 'target.cjs')]);
    assert.equal(existsSync(join(f.home, 'result.json')), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('invalid or missing AppImages are refused before arming a restart', { skip: !linux }, async () => {
  const f = fixture();
  try {
    await assert.rejects(queueAppImageRelaunch('relative.AppImage', [], f.home), /Invalid AppImage/);
    await assert.rejects(queueAppImageRelaunch(join(f.root, 'missing'), [], f.home), /ENOENT/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('the relaunched AppImage starts as the application: ELECTRON_RUN_AS_NODE is never inherited (P3)', { skip: !linux }, async () => {
  const f = fixture();
  try {
    const target = join(f.root, 'fake AppImage');
    writeFileSync(target, `#!/bin/sh\nprintf '%s|%s' "\${ELECTRON_RUN_AS_NODE-unset}" "$TIMON_HOME" > "$TIMON_HOME/env.txt"\n`, { mode: 0o755 });
    // A plain Node parent that arms the relaunch with a polluted environment, then exits.
    writeFileSync(join(f.root, 'arm.mjs'), `
const { queueAppImageRelaunch } = await import('./restart.mjs');
await queueAppImageRelaunch(process.argv[2], [], process.env.TIMON_HOME, { ...process.env, ELECTRON_RUN_AS_NODE: '1' });
process.exit(0);
`);
    await exec(process.execPath, [join(f.root, 'arm.mjs'), target], { env: f.env, timeout: STEP_MS });
    const file = join(f.home, 'env.txt');
    const deadline = Date.now() + STEP_MS;
    while (!existsSync(file) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(readFileSync(file, 'utf8'), `unset|${f.home}`);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('the packaged FUSE runtime really mounts after a native Electron handoff', { skip: !linux }, async (t) => {
  const packaged = fileURLToPath(new URL('../release/Timon-0.1.0.AppImage', import.meta.url));
  if (!existsSync('/dev/fuse') || !existsSync(packaged)) {
    t.skip('requires host FUSE and a previously built AppImage runtime'); return;
  }
  if (inheritsNoNewPrivs) { t.skip('the test process already has NoNewPrivs=1: no FUSE mount is possible below it'); return; }
  try { await exec('mksquashfs', ['-version']); } catch { t.skip('requires mksquashfs'); return; }
  const f = fixture();
  try {
    // Only the existing ELF runtime is reused, never the application or daemon.
    const offset = Number((await exec(packaged, ['--appimage-offset'])).stdout.trim());
    assert.ok(Number.isSafeInteger(offset) && offset > 0 && offset < 2_000_000);
    const runtime = Buffer.alloc(offset);
    const fd = openSync(packaged, 'r');
    try { assert.equal(readSync(fd, runtime, 0, offset, 0), offset); } finally { closeSync(fd); }
    const appDir = join(f.root, 'AppDir');
    mkdirSync(appDir);
    writeFileSync(join(appDir, 'AppRun'), '#!/bin/sh\nexec "$TIMON_TEST_NODE" "$TIMON_TEST_TARGET" "$@"\n', { mode: 0o755 });
    const filesystem = join(f.root, 'payload.squashfs');
    await exec('mksquashfs', [appDir, filesystem, '-noappend', '-processors', '1', '-quiet']);
    const image = join(f.root, 'Timon restart fixture.AppImage');
    writeFileSync(image, runtime, { mode: 0o755 });
    appendFileSync(image, readFileSync(filesystem));
    delete f.env.APPIMAGE_EXTRACT_AND_RUN;
    await launch(f, 'native', image, ['same instance']);
    const child = await result(f.home);
    assert.deepEqual(child.args, ['same instance']);
    assert.equal(child.home, f.home);
    assert.equal(child.account, 'same-account');
    assert.equal(child.noNewPrivs, '0');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
