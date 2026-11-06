/**
 * An official provider writes its program (C1) and its sign-in folders (C2) ONCE, in its manifest's
 * `timon.provider.backends` (SDK-COMPAT § 51): the daemon reads that entry before any plugin runs
 * (doctor, binary search, mission mask, onboarding), and the plugin's definition and profiles read
 * the same entry through `lib/manifest.js` instead of a copy kept equal by hand (TODO #557). Before,
 * the two drifted without a test noticing: Codex's definition declared neither the `searchDirs`
 * nor the `desktopBuilds` its manifest listed.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROVIDERS = join(ROOT, 'official-providers');

const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();
const { dialectDeclarations, installedProfiles } = await import('../backends/registry.js');
const { readManifest } = await import('../plugins/manifest.js');

type BackendEntry = { id: string; binary?: { names: string[] }; credentialDirs?: string[] };
type ProviderPackage = { dir: string; json: { timon: { provider: { binaries?: Array<{ name: string }>; backends?: BackendEntry[] } } } };

const packages: ProviderPackage[] = readdirSync(PROVIDERS).flatMap((name) => {
  const dir = join(PROVIDERS, name);
  const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as ProviderPackage['json'];
  return json.timon.provider.backends?.length ? [{ dir, json }] : [];
});

/** The manifest's own narrowing, which a plugin's declaration never carries (`lib/manifest.js`). */
const productOnly = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (key, inner: unknown) => (key === 'standaloneInstaller' || key === 'folderPattern' ? undefined : inner)));

test('every official provider declares exactly its manifest entry, product-only fields aside', () => {
  assert.ok(packages.length >= 8, 'the official providers are all found');
  for (const { json } of packages) {
    for (const entry of json.timon.provider.backends!) {
      const profile = installedProfiles().find((p) => p.id === entry.id);
      assert.ok(profile, `${entry.id}: a profile is registered`);
      const declares = dialectDeclarations(profile.dialect);
      if (profile.credentialDirs) {
        // A profile on another provider's dialect (kimi on claude, ollama-cloud on codex) names its own folder.
        assert.deepEqual([...profile.credentialDirs], entry.credentialDirs, `${entry.id}: the profile's credentialDirs (C2)`);
      } else {
        assert.deepEqual([...(declares?.credentialDirs ?? [])], entry.credentialDirs, `${entry.id}: credentialDirs (C2)`);
      }
      if (!entry.binary) continue;
      assert.deepEqual(productOnly(declares?.binary), productOnly(entry.binary), `${entry.id}: binary (C1)`);
      if (profile.requiredBinary !== undefined) assert.equal(profile.requiredBinary, entry.binary.names[0], `${entry.id}: requiredBinary`);
    }
  }
});

test('no official provider writes a program name, a sign-in folder or a required binary in its code', () => {
  // `names: []` stays legal: it is `localEnv`, an empty list of variables, not a program.
  const literal = /\b(?:credentialDirs\s*:\s*(?:Object\.freeze\(\s*)?\[|names\s*:\s*(?:Object\.freeze\(\s*)?\[\s*['"`]|requiredBinary\s*:\s*['"`])/;
  const offenders: string[] = [];
  for (const { dir } of packages) {
    const lib = join(dir, 'lib');
    for (const file of readdirSync(lib).filter((name) => name.endsWith('.js') && name !== 'manifest.js')) {
      // Comments go, their line breaks stay: the line an offender is reported at is the file's.
      const code = readFileSync(join(lib, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, '')).replace(/^\s*\/\/.*$/gm, '');
      code.split('\n').forEach((line, i) => { if (literal.test(line)) offenders.push(`${relative(ROOT, join(lib, file))}:${i + 1}: ${line.trim()}`); });
    }
  }
  assert.deepEqual(offenders, [], 'read it from the manifest (`manifestBackend(id)` of `lib/manifest.js`)');
  assert.equal(literal.test("names: Object.freeze(['grok']),"), true, 'the guard catches the copy this TODO removed');
  assert.equal(literal.test("credentialDirs: ['.kimi'],"), true);
  assert.equal(literal.test("requiredBinary: 'grok',"), true);
});

test('the helper is the same file in every provider, refuses a backend its manifest does not list, and hands out frozen values', async () => {
  const sources = packages.map(({ dir }) => readFileSync(join(dir, 'lib', 'manifest.js'), 'utf8'));
  assert.ok(sources.every((source) => source === sources[0]), 'one helper, copied verbatim (a plugin imports nothing outside its package)');
  const grok = packages.find(({ json }) => json.timon.provider.backends!.some((b) => b.id === 'grok'))!;
  const { manifestBackend } = await import(pathToFileURL(join(grok.dir, 'lib', 'manifest.js')).href) as {
    manifestBackend(id: string): { binary?: { names: string[] }; credentialDirs: string[] };
  };
  assert.throws(() => manifestBackend('codex'), /lists no backend `codex`/, 'a backend of another package is not this plugin\'s to declare');
  const declared = manifestBackend('grok');
  assert.throws(() => { declared.credentialDirs.push('.ssh'); }, TypeError, 'what the operator saw cannot grow at run time');
  assert.throws(() => { declared.binary!.names.push('sh'); }, TypeError);
  assert.equal('standaloneInstaller' in declared.binary!, false, 'the product-only installer stays out of the declaration');
});

test('the single source cannot smuggle a program or a folder the operator was not shown', () => {
  for (const { json } of packages) {
    const entry = json.timon.provider.backends!.find((b) => b.binary);
    if (!entry) continue;
    const unlistedBinary = structuredClone(json);
    unlistedBinary.timon.provider.backends!.find((b) => b.id === entry.id)!.binary!.names.push('sh');
    const refused = readManifest(unlistedBinary);
    assert.equal(refused.ok, false, `${entry.id}: a program missing from \`provider.binaries\` is refused`);
    assert.match(refused.ok ? '' : refused.message, /not among the manifest's `provider.binaries`/);
    const unlistedDir = structuredClone(json);
    unlistedDir.timon.provider.backends!.find((b) => b.id === entry.id)!.credentialDirs!.push('.ssh');
    const refusedDir = readManifest(unlistedDir);
    assert.equal(refusedDir.ok, false, `${entry.id}: a folder missing from \`provider.credentialDirs\` is refused`);
  }
});
