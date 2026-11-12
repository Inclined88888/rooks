/**
 * `rooks plugin add <file.zip>` run for real, end to end: the CLI in its own
 * process, the zip extracted into the plugins folder, the real npm install, and
 * the confirmation. The refusal comes first: a "no" at the `[y/N]` must leave
 * neither the package nor the folder extracted from the zip (TODO #345, #549).
 *
 * The CLI loads `dist/`; `tests/helpers/dist-from-src.mjs` points it at `src/`.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildZip } from '../providers/acp-registry/archive-fixtures.js';

const ORCH = fileURLToPath(new URL('../../', import.meta.url));
const ROOKS = join(ORCH, 'bin', 'rooks');
const IMPORTS = [
  'tsx',
  pathToFileURL(join(ORCH, 'tests', 'helpers', 'dist-from-src.mjs')).href,
  // A fresh home has no licence, and a fixed composition refuses any install.
  pathToFileURL(join(ORCH, 'tests', 'helpers', 'paid-license.ts')).href,
];

function runRooks(args: string[], home: string, extra: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // A closed port by default: `add` asks the daemon for its Node, and a test never reaches the live one.
    const env: NodeJS.ProcessEnv = { ...process.env, ROOKS_HOME: home, ROOKS_RESOURCE_GUARD_ENABLED: '0', ROOKS_API: 'http://127.0.0.1:9', ROOKS_API_TOKEN: '', ...extra };
    delete env.ROOKS_MISSION_ID;
    delete env.FORCE_COLOR;
    delete env.NO_COLOR;
    const child = spawn(process.execPath, [...IMPORTS.flatMap((m) => ['--import', m]), ROOKS, ...args], {
      cwd: ORCH,
      env,
      // No terminal on stdin: the CLI cannot ask, which it reads as a "no".
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += String(c); });
    child.stderr.on('data', (c: Buffer) => { stderr += String(c); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function pluginZip(dir: string, n: number, extra: Record<string, unknown> = {}): string {
  const files = [
    { path: 'my-plugin/' },
    {
      path: 'my-plugin/package.json',
      data: JSON.stringify({
        name: `@acme/zip-demo-${n}`, version: '1.0.0', main: 'index.js',
        rooks: { id: `acme-zip-demo-${n}`, apiVersion: 1, kind: 'behavior', permissions: ['usage:read'] },
        ...extra,
      }),
    },
    { path: 'my-plugin/index.js', data: 'throw new Error("the CLI must never run a plugin");\n' },
    // What the Finder adds, dropped at extraction.
    { path: 'my-plugin/.DS_Store', data: 'finder' },
  ];
  const file = join(dir, `plugin-${n}.zip`);
  writeFileSync(file, buildZip(files));
  return file;
}

const installed = (home: string): Record<string, string> => {
  try {
    const pkg = JSON.parse(readFileSync(join(home, 'plugins', 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    return pkg.dependencies ?? {};
  } catch {
    return {};
  }
};
const folders = (home: string): string[] =>
  existsSync(join(home, 'plugins')) ? readdirSync(join(home, 'plugins')).filter((n) => !['package.json', 'package-lock.json', 'node_modules'].includes(n)) : [];

test('a "no" at the [y/N] uninstalls the package and removes the folder extracted from the zip', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rooks-cli-zip-'));
  const work = mkdtempSync(join(tmpdir(), 'rooks-cli-zip-src-'));
  try {
    const zip = pluginZip(work, 1);
    const r = await runRooks(['plugin', 'add', zip], home);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /acme-zip-demo-1@1\.0\.0/, 'the confirmation names the plugin');
    assert.match(r.stderr, /requests: usage:read/);
    assert.match(r.stderr, /Install and activate\? \[y\/N\]/);
    assert.match(r.stderr, /no interactive terminal: rerun with --yes/);
    assert.match(r.stdout, /cancelled, package uninstalled/);
    assert.deepEqual(installed(home), {}, 'npm no longer lists the package');
    assert.deepEqual(folders(home), [], 'the extracted folder is gone: it would linger as "available"');
    assert.ok(!existsSync(join(home, 'plugins', 'node_modules', '@acme', 'zip-demo-1')));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test('a zip that is not a plugin is refused before anything is installed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rooks-cli-zip-'));
  const work = mkdtempSync(join(tmpdir(), 'rooks-cli-zip-src-'));
  try {
    const bad = join(work, 'bad.zip');
    writeFileSync(bad, buildZip([{ path: 'p/index.js', data: 'x' }]));
    const r = await runRooks(['plugin', 'add', bad], home);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot install .*bad\.zip: /);
    assert.deepEqual(installed(home), {});
    assert.deepEqual(folders(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test('no daemon to ask: a zip whose engines.node excludes the CLI\'s Node installs with a warning (TODO #763)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rooks-cli-zip-'));
  const work = mkdtempSync(join(tmpdir(), 'rooks-cli-zip-src-'));
  try {
    mkdirSync(join(home, 'plugins'), { recursive: true });
    const zip = pluginZip(work, 3, { engines: { node: '>=999' } });
    // The closed port answers nothing: the CLI's Node is an estimate, it warns and leaves the daemon to decide.
    const r = await runRooks(['plugin', 'add', zip, '--yes'], home);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /warning: plugin `acme-zip-demo-3` requires Node >=999.*daemon could not be reached/);
    assert.match(r.stderr, /The daemon checks it again when it loads the plugin/);
    assert.ok('@acme/zip-demo-3' in installed(home));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test('with --yes the zip is installed from the plugins folder, and its code never runs in the CLI', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rooks-cli-zip-'));
  const work = mkdtempSync(join(tmpdir(), 'rooks-cli-zip-src-'));
  try {
    mkdirSync(join(home, 'plugins'), { recursive: true });
    const zip = pluginZip(work, 2);
    const r = await runRooks(['plugin', 'add', zip, '--yes'], home);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /acme-zip-demo-2@1\.0\.0 installed \(@acme\/zip-demo-2\)/);
    assert.match(r.stdout, /permissions: usage:read/);
    assert.match(r.stdout, /signature: unsigned/);
    assert.ok(installed(home)['@acme/zip-demo-2'], 'npm lists the package');
    const [folder] = folders(home);
    assert.ok(folder, 'the zip was extracted into the plugins folder');
    assert.ok(!existsSync(join(home, 'plugins', folder, '.DS_Store')), 'the Finder\'s files are left out');
    assert.doesNotMatch(r.stderr, /must never run/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});
