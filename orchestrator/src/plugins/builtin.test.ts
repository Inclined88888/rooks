/**
 * Built-in plugins — what these tests protect.
 *
 * Trust by location is only as good as the check that bounds it: in a
 * packaged build, a built-in is trusted ONLY when every one of its files is
 * vouched for by the verified release manifest. The refusals come first on
 * purpose — a check that only proves the happy path proves nothing.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  BUILTIN_DIR, BUILTIN_LIST, RELEASE_MARKER, readBuiltinList, resolveBuiltins, verifiedRelease, verifyBuiltinFiles,
} = await import('./builtin.js');

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ok');
const PKG = '@fixtures/plugin-ok';
const PREFIX = `${BUILTIN_DIR}/${PKG}`;

function files(dir: string, root = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path, root) : [relative(root, path).split(sep).join('/')];
  });
}

/** A packaged orchestrator root holding one built-in, and the manifest a release would sign for it. */
function packagedRoot(): { root: string; dir: string; release: { files: Record<string, string> } } {
  const root = mkdtempSync(join(tmpdir(), 'rooks-builtin-'));
  const dir = join(root, BUILTIN_DIR, ...PKG.split('/'));
  mkdirSync(dirname(dir), { recursive: true });
  cpSync(FIXTURE, dir, { recursive: true });
  const list = JSON.stringify({ plugins: [{ pkg: PKG, source: 'unused-when-packaged' }] });
  writeFileSync(join(root, BUILTIN_LIST), list);
  writeFileSync(join(root, 'release-manifest.json'), '{}');
  const manifest: Record<string, string> = {
    'dist/boot.js': 'x',
    [BUILTIN_LIST]: createHash('sha256').update(list).digest('hex'),
  };
  for (const name of files(dir)) {
    manifest[`${PREFIX}/${name}`] = createHash('sha256').update(readFileSync(join(dir, ...name.split('/')))).digest('hex');
  }
  return { root, dir, release: { files: manifest } };
}

test('refused: no release manifest verified at boot', () => {
  const { root, dir } = packagedRoot();
  const trust = verifyBuiltinFiles(dir, PREFIX, null);
  assert.equal(trust.ok, false);
  const [resolved] = resolveBuiltins({ root, release: null });
  assert.equal(resolved?.trust.ok, false, 'a release-manifest.json on disk without the boot marker is not trust');
  rmSync(root, { recursive: true, force: true });
});

test('refused: a file altered after the release was signed', () => {
  const { root, dir, release } = packagedRoot();
  writeFileSync(join(dir, 'lib', 'index.js'), 'export function apply() { /* altered */ }');
  const trust = verifyBuiltinFiles(dir, PREFIX, release);
  assert.equal(trust.ok, false);
  assert.match(trust.ok ? '' : trust.message, /lib\/index\.js does not match/);
  rmSync(root, { recursive: true, force: true });
});

test('refused: a file the release manifest does not list', () => {
  const { root, dir, release } = packagedRoot();
  writeFileSync(join(dir, 'lib', 'extra.js'), 'export {}');
  const trust = verifyBuiltinFiles(dir, PREFIX, release);
  assert.equal(trust.ok, false);
  assert.match(trust.ok ? '' : trust.message, /extra\.js is not covered/);
  rmSync(root, { recursive: true, force: true });
});

test('refused: a listed file that is gone, or a plugin the manifest does not cover at all', () => {
  const { root, dir, release } = packagedRoot();
  rmSync(join(dir, 'cover.png'));
  const gone = verifyBuiltinFiles(dir, PREFIX, release);
  assert.match(gone.ok ? '' : gone.message, /cover\.png is listed .* but missing/);
  const uncovered = verifyBuiltinFiles(dir, PREFIX, { files: { 'dist/boot.js': 'x' } });
  assert.match(uncovered.ok ? '' : uncovered.message, /not covered by the release manifest/);
  rmSync(root, { recursive: true, force: true });
});

test('refused: a symbolic link inside the plugin', () => {
  const { root, dir, release } = packagedRoot();
  symlinkSync(join(dir, 'package.json'), join(dir, 'link.json'));
  const trust = verifyBuiltinFiles(dir, PREFIX, release);
  assert.match(trust.ok ? '' : trust.message, /symbolic link/);
  rmSync(root, { recursive: true, force: true });
});

test('trusted: every file matches the verified release manifest', () => {
  const { root, dir, release } = packagedRoot();
  assert.deepEqual(verifyBuiltinFiles(dir, PREFIX, release), { ok: true });
  const [resolved] = resolveBuiltins({ root, release });
  assert.equal(resolved?.pkg, PKG);
  assert.equal(resolved?.dir, dir);
  assert.deepEqual(resolved?.trust, { ok: true });
  rmSync(root, { recursive: true, force: true });
});

test('the boot marker is read from the global the packaged boot sets', () => {
  const store = globalThis as Record<symbol, unknown>;
  assert.equal(verifiedRelease(), null);
  store[RELEASE_MARKER] = { files: { 'dist/boot.js': 'x' } };
  try {
    assert.deepEqual(verifiedRelease(), { files: { 'dist/boot.js': 'x' } });
  } finally {
    delete store[RELEASE_MARKER];
  }
});

/** A fake checkout: `<repo>/orchestrator` (with `src/plugins/builtin.ts`) and `<repo>/examples/<name>`. */
function checkout(source: (repo: string) => string): { repo: string; root: string } {
  const repo = mkdtempSync(join(tmpdir(), 'rooks-builtin-src-'));
  const root = join(repo, 'orchestrator');
  mkdirSync(join(root, 'src', 'plugins'), { recursive: true });
  writeFileSync(join(root, 'src', 'plugins', 'builtin.ts'), '');
  mkdirSync(join(repo, 'examples'), { recursive: true });
  cpSync(FIXTURE, join(repo, 'examples', 'plugin-ok'), { recursive: true });
  writeFileSync(join(root, BUILTIN_LIST), JSON.stringify({ plugins: [{ pkg: PKG, source: source(repo) }] }));
  return { repo, root };
}

test('source tree: the list points at the example package inside the checkout', () => {
  const { repo, root } = checkout(() => '../examples/plugin-ok');
  const [resolved] = resolveBuiltins({ root, release: null });
  assert.equal(resolved?.dir, join(repo, 'examples', 'plugin-ok'));
  assert.deepEqual(resolved?.trust, { ok: true });
  rmSync(repo, { recursive: true, force: true });
});

test('refused: a source tree that is not a checkout (a packaged tree whose manifest went missing)', () => {
  const root = mkdtempSync(join(tmpdir(), 'rooks-builtin-nosrc-'));
  mkdirSync(join(root, BUILTIN_DIR), { recursive: true });
  writeFileSync(join(root, BUILTIN_LIST), JSON.stringify({ plugins: [{ pkg: PKG, source: FIXTURE }] }));
  const [resolved] = resolveBuiltins({ root, release: null });
  assert.equal(resolved?.trust.ok, false);
  assert.match(resolved?.trust.ok === false ? resolved.trust.message : '', /not a source checkout/);
  rmSync(root, { recursive: true, force: true });
});

test('refused: a source outside the checkout', () => {
  const outside = checkout(() => FIXTURE);
  const [out] = resolveBuiltins({ root: outside.root, release: null });
  assert.equal(out?.trust.ok, false);
  assert.match(out?.trust.ok === false ? out.trust.message : '', /outside the source checkout/);
  rmSync(outside.repo, { recursive: true, force: true });
});

test('refused: a source that reaches out of the checkout through a symbolic link', () => {
  const { repo, root } = checkout(() => '../examples/linked');
  symlinkSync(FIXTURE, join(repo, 'examples', 'linked'));
  const [resolved] = resolveBuiltins({ root, release: null });
  assert.equal(resolved?.trust.ok, false);
  rmSync(repo, { recursive: true, force: true });
});

test('refused: an edited builtin-plugins.json in a release selects nothing it can vouch for', () => {
  const { root, release } = packagedRoot();
  writeFileSync(join(root, BUILTIN_LIST), JSON.stringify({ plugins: [{ pkg: PKG, source: 'x', enabledByDefault: false }] }));
  const [resolved] = resolveBuiltins({ root, release });
  assert.equal(resolved?.trust.ok, false);
  assert.match(resolved?.trust.ok === false ? resolved.trust.message : '', /builtin-plugins\.json does not match/);
  const uncovered = { files: Object.fromEntries(Object.entries(release.files).filter(([name]) => name !== BUILTIN_LIST)) };
  const [none] = resolveBuiltins({ root, release: uncovered });
  assert.match(none?.trust.ok === false ? none.trust.message : '', /not covered by the release manifest/);
  rmSync(root, { recursive: true, force: true });
});

test('the shipped list names the quota monitor, and its source exists', () => {
  const list = readBuiltinList();
  const quota = list.find((p) => p.pkg === '@rooks/plugin-quota-monitor');
  assert.ok(quota, 'builtin-plugins.json lists the quota monitor');
  const [resolved] = resolveBuiltins({ release: null }).filter((p) => p.pkg === quota.pkg);
  assert.ok(resolved && existsSync(join(resolved.dir, 'package.json')), 'the source tree resolves to the example package');
});

test('an invalid list, or a name that would escape the folder, yields no built-in', () => {
  const root = mkdtempSync(join(tmpdir(), 'rooks-builtin-bad-'));
  writeFileSync(join(root, BUILTIN_LIST), JSON.stringify({ plugins: [{ pkg: '../../evil', source: '.' }] }));
  assert.deepEqual(readBuiltinList(root), []);
  rmSync(root, { recursive: true, force: true });
});
