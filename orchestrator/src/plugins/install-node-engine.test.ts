/**
 * A plugin whose `engines.node` excludes the daemon's Node is refused at
 * install, and refused at load once installed (TODO #763). The daemon is
 * simulated as a packaged Rooks on Electron 33 (Node 20.18.3), the runtime
 * that let `node:sqlite` plugins in on the Windows VM.
 *
 * npm is injected: `install` copies a folder (a local spec, or a registry name
 * mapped to a folder) into `node_modules/`, `uninstall` removes it.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { NodeRuntimeFacts } from './node-engine.js';
import type { NpmRunner, NpmViewer } from './install.js';

const { addPlugin, inventory, registryEngineProblem, registryPackageName, removePlugin, PluginEngineError } = await import('./install.js');
const { PluginInstallSources, PluginSourceError } = await import('./install-sources.js');

const ELECTRON_33: NodeRuntimeFacts = { node: '20.18.3', electron: '33.4.11', packaged: true, source: 'daemon' };
const WORK = mkdtempSync(join(tmpdir(), 'rooks-node-engine-'));
let serial = 0;

type Json = Record<string, unknown>;

function readJson(file: string): Json {
  return JSON.parse(readFileSync(file, 'utf8')) as Json;
}

/** A plugin folder; `hostless` drops the host half and keeps a browser one. */
function source(opts: { name?: string; version?: string; node?: string; hostless?: boolean } = {}): string {
  const n = ++serial;
  const dir = join(WORK, `src-${n}`);
  mkdirSync(dir, { recursive: true });
  const name = opts.name ?? `@acme/engine-${n}`;
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    version: opts.version ?? '1.0.0',
    type: 'module',
    ...(opts.hostless ? {} : { main: 'index.js' }),
    ...(opts.node ? { engines: { node: opts.node } } : {}),
    rooks: {
      id: name.replace(/^@acme\//, 'acme-'),
      apiVersion: 1,
      permissions: [],
      ...(opts.hostless ? { kind: ['widget'], client: { entry: 'client.js', slots: ['cockpit.widget'] } } : { kind: ['behavior'] }),
    },
  }, null, 2));
  writeFileSync(join(dir, opts.hostless ? 'client.js' : 'index.js'), 'export function apply() {}\n');
  return dir;
}

/** npm's double. `registry` maps a spec (as typed: `name`, `name@1.0.0`) to the folder it fetches. */
function fakeNpm(registry: Record<string, string> = {}): { run: NpmRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: NpmRunner = async (args, cwd) => {
    calls.push(args);
    const root = args[args.indexOf('--prefix') + 1] ?? cwd;
    const spec = args[args.length - 1] as string;
    const pkgFile = join(root, 'package.json');
    const pkg = existsSync(pkgFile) ? readJson(pkgFile) : {};
    const deps = (pkg.dependencies as Record<string, string> | undefined) ?? {};
    if (args[0] === 'install') {
      const from = isAbsolute(spec) ? spec : registry[spec];
      if (!from) throw new Error(`no such package ${spec}`);
      const name = readJson(join(from, 'package.json')).name as string;
      const dest = join(root, 'node_modules', name);
      mkdirSync(dirname(dest), { recursive: true });
      rmSync(dest, { recursive: true, force: true });
      cpSync(from, dest, { recursive: true });
      // As npm records them: a folder relative to the root, a registry release as a caret range.
      deps[name] = isAbsolute(spec) ? `file:${relative(root, spec)}` : `^${readJson(join(from, 'package.json')).version as string}`;
    } else {
      delete deps[spec];
      rmSync(join(root, 'node_modules', spec), { recursive: true, force: true });
    }
    pkg.dependencies = deps;
    writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
  };
  return { run, calls };
}

function freshRoot(): { root: string; config: string } {
  const root = join(WORK, `plugins-${++serial}`);
  const config = join(WORK, `config-${serial}.json`);
  writeFileSync(config, '{}');
  return { root, config };
}

test('a local folder that needs a newer Node is refused before npm runs', async () => {
  const { root, config } = freshRoot();
  const npm = fakeNpm();
  const dir = source({ node: '>=22.5' });
  await assert.rejects(
    addPlugin(dir, root, { npm: npm.run, config, builtins: [], runtime: ELECTRON_33 }),
    (err: unknown) => err instanceof PluginEngineError
      && /requires Node >=22\.5/.test(err.message)
      && /runs Node 20\.18\.3/.test(err.message)
      && /not on the Node installed on this system/.test(err.message),
  );
  assert.equal(npm.calls.length, 0, 'npm never ran');
});

test('a registry package that needs a newer Node is uninstalled at once', async () => {
  const { root, config } = freshRoot();
  const dir = source({ name: '@acme/growth', node: '>=22.5' });
  const npm = fakeNpm({ '@acme/growth': dir });
  await assert.rejects(
    addPlugin('@acme/growth', root, { npm: npm.run, config, builtins: [], runtime: ELECTRON_33 }),
    PluginEngineError,
  );
  assert.deepEqual(npm.calls.map((c) => c[0]), ['install', 'uninstall']);
  assert.deepEqual(readJson(join(root, 'package.json')).dependencies, {});
});

/** `npm view`'s double: the `--json` answer for a spec, `null` when npm could not say. */
function fakeView(answers: Record<string, unknown> = {}): { view: NpmViewer; calls: string[] } {
  const calls: string[] = [];
  return { calls, view: async (spec) => { calls.push(spec); return answers[spec] ?? null; } };
}

/** The registry document of a source folder, as `npm view <spec> version engines main rooks --json` gives it. */
function viewOf(dir: string): Json {
  const { version, engines, main, rooks } = readJson(join(dir, 'package.json'));
  return { version, ...(engines ? { engines } : {}), ...(main ? { main } : {}), rooks };
}

function installedVersion(root: string, pkg: string): unknown {
  return readJson(join(root, 'node_modules', pkg, 'package.json')).version;
}

/** `@acme/<name>` 1.0.0 (any Node) installed from the registry, 2.0.0 (`>=22.5`) published since. */
async function installedThenPublished(name: string): Promise<{ root: string; config: string; pkg: string; v1: string; v2: string; registry: Record<string, string>; npm: ReturnType<typeof fakeNpm> }> {
  const { root, config } = freshRoot();
  const pkg = `@acme/${name}`;
  const v1 = source({ name: pkg, node: '>=18' });
  const v2 = source({ name: pkg, version: '2.0.0', node: '>=22.5' });
  const registry: Record<string, string> = { [pkg]: v1, [`${pkg}@1.0.0`]: v1 };
  const npm = fakeNpm(registry);
  const first = await addPlugin(pkg, root, { npm: npm.run, view: fakeView().view, config, builtins: [], runtime: ELECTRON_33 });
  assert.equal(first.refused, null);
  registry[pkg] = v2;
  npm.calls.length = 0;
  return { root, config, pkg, v1, v2, registry, npm };
}

test('an update the registry says needs a newer Node is refused before npm runs (TODO #794)', async () => {
  const { root, config, pkg, v2, npm } = await installedThenPublished('upd-view');
  const view = fakeView({ [pkg]: viewOf(v2) });
  await assert.rejects(
    addPlugin(pkg, root, { npm: npm.run, view: view.view, config, builtins: [], runtime: ELECTRON_33 }),
    (err: unknown) => err instanceof PluginEngineError
      && /requires Node >=22\.5/.test(err.message)
      && /Nothing was installed: release 1\.0\.0 stays in place/.test(err.message),
  );
  assert.deepEqual(view.calls, [pkg]);
  assert.equal(npm.calls.length, 0, 'npm never ran');
  assert.equal(installedVersion(root, pkg), '1.0.0');
});

test('an update npm could not be asked about is put back once npm brought it (TODO #794)', async () => {
  const { root, config, pkg, npm } = await installedThenPublished('upd-restore');
  // The registry did not answer `npm view`: only the installed files can tell.
  await assert.rejects(
    addPlugin(pkg, root, { npm: npm.run, view: fakeView().view, config, builtins: [], runtime: ELECTRON_33 }),
    (err: unknown) => err instanceof PluginEngineError
      && /requires Node >=22\.5/.test(err.message)
      && /Release 1\.0\.0, installed before, was put back/.test(err.message),
  );
  assert.deepEqual(npm.calls.map((c) => c.at(-1)), [pkg, `${pkg}@1.0.0`], 'the exact release, not the range that brought 2.0.0');
  assert.equal(installedVersion(root, pkg), '1.0.0');
  assert.equal((readJson(join(root, 'package.json')).dependencies as Json)[pkg], '^1.0.0');
});

test('a range whose releases do not all agree is left to npm, then put back', async () => {
  const { root, config, pkg, v1, v2, npm } = await installedThenPublished('upd-range');
  const view = fakeView({ [`${pkg}@>=1`]: [viewOf(v1), viewOf(v2)] });
  npm.calls.length = 0;
  const registry = { [`${pkg}@>=1`]: v2, [`${pkg}@1.0.0`]: v1 };
  const ranged = fakeNpm(registry);
  await assert.rejects(addPlugin(`${pkg}@>=1`, root, { npm: ranged.run, view: view.view, config, builtins: [], runtime: ELECTRON_33 }), PluginEngineError);
  assert.equal(ranged.calls.length, 2, 'installed, then put back');
  assert.equal(installedVersion(root, pkg), '1.0.0');
});

test('an update that cannot be put back stays inert, and names the release to reinstall', async () => {
  const { root, config, pkg, registry, npm } = await installedThenPublished('upd-gone');
  delete registry[`${pkg}@1.0.0`];
  const second = await addPlugin(pkg, root, { npm: npm.run, view: fakeView().view, config, builtins: [], runtime: ELECTRON_33 });
  assert.equal(second.refused, 'skipped:node-engine');
  assert.match(second.message ?? '', /requires Node >=22\.5/);
  assert.match(second.message ?? '', /could not be put back: reinstall it \(`rooks plugin add @acme\/upd-gone@1\.0\.0`\)/);
});

test('a release installed from a folder is put back from that folder', async () => {
  const { root, config } = freshRoot();
  const v1 = source({ name: '@acme/upd-folder', node: '>=18' });
  const v2 = source({ name: '@acme/upd-folder', version: '2.0.0', node: '>=22.5' });
  const npm = fakeNpm({ '@acme/upd-folder': v2 });
  const view = fakeView();
  assert.equal((await addPlugin(v1, root, { npm: npm.run, view: view.view, config, builtins: [], runtime: ELECTRON_33 })).refused, null);
  await assert.rejects(addPlugin('@acme/upd-folder', root, { npm: npm.run, view: view.view, config, builtins: [], runtime: ELECTRON_33 }), /was put back/);
  assert.equal(npm.calls.at(-1)?.at(-1), v1);
  assert.equal(installedVersion(root, '@acme/upd-folder'), '1.0.0');
});

test('npm view is asked only for an update, and only when the daemon\'s Node is known', async () => {
  const { root, config } = freshRoot();
  const dir = source({ name: '@acme/fresh', node: '>=18' });
  const view = fakeView();
  const npm = fakeNpm({ '@acme/fresh': dir });
  await addPlugin('@acme/fresh', root, { npm: npm.run, view: view.view, config, builtins: [], runtime: ELECTRON_33 });
  assert.deepEqual(view.calls, [], 'a fresh package is removed again if it does not fit: nothing to protect');
  await addPlugin('@acme/fresh', root, { npm: npm.run, view: view.view, config, builtins: [], runtime: { ...ELECTRON_33, source: 'local' } });
  assert.deepEqual(view.calls, [], 'the CLI\'s own Node only warns');
  await addPlugin('@acme/fresh', root, { npm: npm.run, view: view.view, config, builtins: [], runtime: ELECTRON_33 });
  assert.deepEqual(view.calls, ['@acme/fresh']);
});

test('registryPackageName: registry specs only', () => {
  assert.equal(registryPackageName('@acme/growth'), '@acme/growth');
  assert.equal(registryPackageName('@acme/growth@1.2.3'), '@acme/growth');
  assert.equal(registryPackageName('@acme/growth@^1.2'), '@acme/growth');
  assert.equal(registryPackageName('growth@latest'), 'growth');
  assert.equal(registryPackageName('growth@>=1 <2'), 'growth');
  for (const spec of ['./growth', '../growth', '/abs/growth', 'file:growth', 'growth-1.0.0.tgz', 'acme/growth', 'github:acme/growth', 'npm:growth@1', 'https://x.test/growth.tgz', 'git+https://x.test/g.git']) {
    assert.equal(registryPackageName(spec), null, spec);
  }
});

test('registryEngineProblem: refuses only what is certain', () => {
  const manifest = { id: 'acme-g', apiVersion: 1, permissions: [], kind: ['behavior'] };
  const needs = (node: string, extra: Json = {}): Json => ({ version: '2.0.0', engines: { node }, main: 'index.js', rooks: manifest, ...extra });
  assert.match(registryEngineProblem(needs('>=22.5'), ELECTRON_33) ?? '', /`acme-g` requires Node >=22\.5/);
  assert.equal(registryEngineProblem(needs('>=20'), ELECTRON_33), null);
  assert.match(registryEngineProblem([needs('>=22.5'), needs('>=23')], ELECTRON_33) ?? '', /requires Node/);
  assert.equal(registryEngineProblem([needs('>=22.5'), needs('>=18')], ELECTRON_33), null, 'npm picks: cannot tell');
  for (const unclear of [null, '2.0.0', [], { version: '2.0.0' }, needs('>=22.5', { rooks: 'nope' })]) {
    assert.equal(registryEngineProblem(unclear, ELECTRON_33), null, JSON.stringify(unclear));
  }
  // No host half, or one only the files can tell: the daemon's Node never runs it, or the disk decides.
  const widget = { ...manifest, kind: ['widget'], client: { entry: 'client.js', slots: ['cockpit.widget'] } };
  assert.equal(registryEngineProblem({ version: '2.0.0', engines: { node: '>=22.5' }, rooks: widget }, ELECTRON_33), null);
  assert.match(registryEngineProblem({ ...needs('>=22.5'), rooks: widget }, ELECTRON_33) ?? '', /requires Node/, 'a `main` is a host half');
});

test('a compatible range installs, and a plugin with no host half is not asked', async () => {
  const { root, config } = freshRoot();
  const npm = fakeNpm();
  const ok = await addPlugin(source({ node: '>=20' }), root, { npm: npm.run, config, builtins: [], runtime: ELECTRON_33 });
  assert.equal(ok.refused, null);
  const widget = await addPlugin(source({ node: '>=99', hostless: true }), root, { npm: npm.run, config, builtins: [], runtime: ELECTRON_33 });
  assert.equal(widget.refused, null);
});

test('an installed plugin that no longer fits is listed refused under its id, and still removable by it', async () => {
  const { root, config } = freshRoot();
  const dir = source({ name: '@acme/later', node: '>=22.5' });
  mkdirSync(join(root, 'node_modules', '@acme'), { recursive: true });
  cpSync(dir, join(root, 'node_modules', '@acme', 'later'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@acme/later': '^1.0.0' } }));
  const [refused] = inventory(root, config, [], ELECTRON_33);
  assert.equal(refused?.id, 'acme-later');
  assert.equal(refused?.refused, 'skipped:node-engine');
  assert.match(refused?.message ?? '', /`acme-later` requires Node >=22\.5/);
  assert.equal(inventory(root, config, [], { ...ELECTRON_33, node: '22.12.0' })[0]?.refused, null);

  const npm = fakeNpm();
  const removed = await removePlugin('acme-later', root, { npm: npm.run, config, builtins: [] });
  assert.equal(removed.pkg, '@acme/later');
  assert.deepEqual(readJson(join(root, 'package.json')).dependencies, {});
});

test('without the daemon\'s answer the CLI\'s Node only warns: the install goes on', async () => {
  const { root, config } = freshRoot();
  const npm = fakeNpm();
  const result = await addPlugin(source({ node: '>=22.5' }), root, { npm: npm.run, config, builtins: [], runtime: { ...ELECTRON_33, packaged: false, electron: null, source: 'local' } });
  assert.equal(result.refused, null);
  assert.match(result.engineWarning ?? '', /requires Node >=22\.5.*daemon could not be reached/);
});

test('the install sheet blocks the button and says why; installing anyway is a 422', async () => {
  const { root, config } = freshRoot();
  const npm = fakeNpm();
  const sheet = new PluginInstallSources({
    pluginsRoot: root,
    stagingRoot: join(WORK, `staging-${++serial}`),
    forbiddenRoots: [join(WORK, 'forbidden')],
    unsignedLoads: () => true,
    configFile: config,
    install: { npm: npm.run, config, builtins: [], runtime: ELECTRON_33 },
  });
  const preview = sheet.stagePath(source({ node: '>=22.5' }));
  assert.equal(preview.installable, false);
  assert.equal(preview.blocked, 'node-engine');
  assert.equal(preview.manifestError, null);
  assert.match(preview.engineError ?? '', /requires Node >=22\.5.*runs Node 20\.18\.3/);
  assert.ok(preview.id, 'the manifest is valid: what the plugin is stays readable');
  await assert.rejects(sheet.installStaged(preview.token), (err: unknown) => err instanceof PluginSourceError
    && err.status === 422 && err.code === 'node-engine' && /requires Node >=22\.5/.test(err.message));
  assert.equal(npm.calls.length, 0);

  const fine = sheet.stagePath(source({ node: '>=20' }));
  assert.equal(fine.blocked, null);
  assert.equal(fine.engineError, null);
});

/** A bundle shipping two children in its `node_modules`: `old` fits any Node, `new` needs `>=22.5`. */
function engineBundle(): { dir: string; ids: { old: string; new: string }; registry: Record<string, string> } {
  const n = ++serial;
  const dir = join(WORK, `bundle-${n}`);
  const registry: Record<string, string> = {};
  const ids = { old: '', new: '' };
  for (const [key, node] of [['old', '>=18'], ['new', '>=22.5']] as const) {
    const child = source({ name: `@acme/kid-${key}-${n}`, node });
    cpSync(child, join(dir, 'node_modules', '@acme', `kid-${key}-${n}`), { recursive: true });
    registry[`@acme/kid-${key}-${n}@^1.0.0`] = child;
    ids[key] = `acme-kid-${key}-${n}`;
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `@acme/set-${n}`, version: '1.0.0', main: 'index.js',
    dependencies: { [`@acme/kid-old-${n}`]: '^1.0.0', [`@acme/kid-new-${n}`]: '^1.0.0' },
    rooks: { id: `acme-set-${n}`, apiVersion: 1, kind: ['bundle'], permissions: [], contains: [ids.old, ids.new] },
  }));
  writeFileSync(join(dir, 'index.js'), 'export function apply() {}\n');
  return { dir, ids, registry };
}

test('a bundle child that needs a newer Node is said on the sheet and on install, and asks nothing (TODO #794)', async () => {
  const { root, config } = freshRoot();
  const { dir, ids, registry } = engineBundle();
  const npm = fakeNpm(registry);
  const sheet = new PluginInstallSources({
    pluginsRoot: root,
    stagingRoot: join(WORK, `staging-${++serial}`),
    forbiddenRoots: [join(WORK, 'forbidden')],
    unsignedLoads: () => true,
    configFile: config,
    install: { npm: npm.run, config, builtins: [], runtime: ELECTRON_33 },
  });
  const preview = sheet.stagePath(dir);
  assert.equal(preview.blocked, null, 'the bundle itself fits: only its child does not');
  const kids = new Map(preview.children.map((c) => [c.id, c]));
  assert.equal(kids.get(ids.old)?.engineError, null);
  assert.equal(kids.get(ids.new)?.state, 'install', 'it lands with the bundle');
  assert.match(kids.get(ids.new)?.engineError ?? '', new RegExp(`\`${ids.new}\` requires Node >=22\\.5.*runs Node 20\\.18\\.3`));
  assert.equal(kids.get(ids.new)?.vault, null, 'nothing is asked for a child that will not load');
  assert.equal(kids.get(ids.new)?.provider, null);

  const result = await sheet.installStaged(preview.token);
  const landed = new Map(result.children.map((c) => [c.id, c]));
  assert.equal(landed.get(ids.old)?.state, 'installed');
  assert.equal(landed.get(ids.old)?.message, null);
  assert.equal(landed.get(ids.new)?.state, 'installed');
  assert.match(landed.get(ids.new)?.message ?? '', /^installed, but NOT loaded: .*requires Node >=22\.5/);
});
