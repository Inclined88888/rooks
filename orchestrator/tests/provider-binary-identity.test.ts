/**
 * A provider's binary identity lives twice: in its code (`declares.binary.identity`, checked before every launch) and
 * in its manifest (`provider.binaries[].identity`, checked on the authorization click, when the code is not loaded
 * yet). Two copies that disagree make the click and the launch judge different programs, so every provider shipped
 * in this repository (the official ones and the Cursor template) is held to an identical mirror here.
 *
 * Then Cursor's `agent` alias, through the real grant and the real registration: grok installs an `agent` too
 * (`grok 1.0.13 (5e9a58528b76) [stable]` is what the real one prints for `--version`), and only Cursor's may be
 * authorized and launched.
 */
import '../src/test-home.js';
import './helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
const posix = process.platform !== 'win32';
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CURSOR_DIR = join(ROOT, 'examples', 'plugin-provider-cursor');

// Only an `agent` on the PATH, no `cursor-agent`: the install that has nothing but the alias.
const bin = realpathSync(mkdtempSync(join(tmpdir(), 'rooks-agent-alias-')));
const AGENT = join(bin, 'agent');
const GROK_AGENT = '#!/bin/sh\necho "grok 1.0.13 (5e9a58528b76) [stable]"\n';
const CURSOR_AGENT = '#!/bin/sh\n# Cursor\'s agent CLI\necho "2026.10.16-0a1b2c3"\n';
const previousPath = process.env.PATH;
process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`;
process.on('exit', () => rmSync(bin, { recursive: true, force: true }));

function installAgent(body: string): void {
  writeFileSync(AGENT, body);
  chmodSync(AGENT, 0o755);
}

const { readManifest } = await import('../src/plugins/manifest.js');
const { createPluginContext, daemonHost } = await import('../src/plugins/context.js');
const { providerBinaryRequests, grantProviderBinaries, ExecGrantError } = await import('../src/plugins/exec-grants.js');
const { resetPluginPolicyState } = await import('../src/plugins/policy.js');
const { config } = await import('../src/config/load.js');
const { declaredBinary } = await import('../src/host/declared-binaries.js');
const { assertLaunchIdentity, BinaryIdentityError } = await import('../src/backends/binary-identity.js');
const { getDialect, installedProfiles } = await import('../src/backends/registry.js');
const { mountOfficialProviders } = await import('./helpers/official-providers.js');
const { CURSOR } = await import(pathToFileURL(join(CURSOR_DIR, 'lib', 'cursor.js')).href) as {
  CURSOR: { binary: { names: string[]; identity?: Identity } };
};

type Identity = { args?: string[]; pattern: string; expected?: string };
type ManifestBinary = { name: string; aliases?: string[]; identity?: Identity };
type Declared = { names: readonly string[]; identity?: Identity };
type ProviderPackage = { where: string; json: Record<string, unknown>; binaries: ManifestBinary[]; declared: Declared[] };

const readJson = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

/** The official providers: their code builds `declares.binary` from the manifest's own `backends[].binary` (`lib/manifest.js`). */
function officialPackages(): ProviderPackage[] {
  const dir = join(ROOT, 'orchestrator', 'official-providers');
  return readdirSync(dir).map((name) => {
    const json = readJson(join(dir, name, 'package.json'));
    const provider = (json.rooks as { provider?: { binaries?: ManifestBinary[]; backends?: Array<{ binary?: Declared }> } }).provider;
    return {
      where: `official-providers/${name}`,
      json,
      binaries: provider?.binaries ?? [],
      declared: (provider?.backends ?? []).flatMap((backend) => (backend.binary ? [backend.binary] : [])),
    };
  });
}

function cursorPackage(): ProviderPackage {
  const json = readJson(join(CURSOR_DIR, 'package.json'));
  return {
    where: 'examples/plugin-provider-cursor',
    json,
    binaries: (json.rooks as { provider: { binaries: ManifestBinary[] } }).provider.binaries,
    declared: [CURSOR.binary],
  };
}

/** What makes the manifest and the code disagree on a program's identity; empty = a faithful mirror. */
function mirrorProblems({ where, binaries, declared }: ProviderPackage): string[] {
  const problems: string[] = [];
  for (const entry of binaries) {
    const names = [entry.name, ...(entry.aliases ?? [])];
    const owners = declared.filter((d) => names.some((n) => d.names.includes(n)));
    if (owners.length === 0) {
      if (entry.identity) problems.push(`${where}: \`${entry.name}\` carries an identity no \`declares.binary\` declares`);
      continue;
    }
    for (const owner of owners) {
      if (!isDeepStrictEqual(entry.identity ?? null, owner.identity ?? null)) {
        problems.push(`${where}: \`${entry.name}\` — manifest ${JSON.stringify(entry.identity ?? null)}, declares ${JSON.stringify(owner.identity ?? null)}`);
      }
    }
  }
  for (const owner of declared) {
    if (owner.identity && !binaries.some((entry) => [entry.name, ...(entry.aliases ?? [])].some((name) => owner.names.includes(name)))) {
      problems.push(`${where}: \`${owner.names.join(', ')}\` declares an identity without a manifest binary`);
    }
  }
  return problems;
}

test('every provider shipped here mirrors its declared identity in its manifest, exactly', () => {
  const packages = [...officialPackages(), cursorPackage()];
  assert.ok(packages.length >= 9, 'the official providers and the Cursor template are all read');
  for (const pkg of packages) {
    assert.deepEqual(mirrorProblems(pkg), [], pkg.where);
    // The manifest is what the daemon reads before the code: it must parse with the identity it carries.
    const parsed = readManifest(pkg.json);
    assert.ok(parsed.ok, `${pkg.where}: ${parsed.ok ? '' : parsed.message}`);
  }
});

test('the mirror check sees a divergence: another pattern, an extra argument, an identity only on one side', () => {
  const declared = [{ names: ['acme', 'acme-agent'], identity: { args: ['--version'], pattern: '^acme ', expected: 'Acme' } }];
  const pkg = (binaries: ManifestBinary[]): ProviderPackage => ({ where: 'acme', json: {}, binaries, declared });
  assert.deepEqual(mirrorProblems(pkg([{ name: 'acme', aliases: ['acme-agent'], identity: { args: ['--version'], pattern: '^acme ', expected: 'Acme' } }])), []);
  assert.equal(mirrorProblems(pkg([{ name: 'acme', identity: { args: ['--version'], pattern: '^acme', expected: 'Acme' } }])).length, 1);
  assert.equal(mirrorProblems(pkg([{ name: 'acme', identity: { args: ['--version', '--json'], pattern: '^acme ', expected: 'Acme' } }])).length, 1);
  assert.equal(mirrorProblems(pkg([{ name: 'acme' }])).length, 1, 'the manifest forgot it: the click would let a namesake through');
  assert.equal(mirrorProblems(pkg([])).length, 1, 'removing the whole entry also removes the identity check on the click');
  assert.equal(mirrorProblems(pkg([{ name: 'acme', identity: { args: ['--version'], pattern: '^acme ', expected: 'Other program' } }])).length, 1);
  assert.deepEqual(mirrorProblems(pkg([{ name: 'acme', identity: { expected: 'Acme', pattern: '^acme ', args: ['--version'] } }])), [], 'object key order does not change the identity');
  assert.equal(mirrorProblems(pkg([{ name: 'acme-agent', identity: declared[0]!.identity }, { name: 'acme' }])).length, 1, 'each entry naming the program carries it');
  assert.equal(mirrorProblems({ ...pkg([{ name: 'other', identity: { pattern: 'x' } }]), declared: [] }).length, 1, 'an identity no code declares');
});

test('mounted, the official providers declare to the host what their manifest says', async () => {
  await mountOfficialProviders();
  for (const { where, binaries } of officialPackages()) {
    for (const entry of binaries) {
      for (const name of [entry.name, ...(entry.aliases ?? [])]) {
        assert.deepEqual(declaredBinary(name)?.identity ?? null, entry.identity ?? null, `${where}: \`${name}\``);
      }
    }
  }
});

test('Cursor declares `agent` as an alias of `cursor-agent`, with the same identity in its code and its manifest', () => {
  const [entry] = cursorPackage().binaries;
  assert.equal(entry?.name, 'cursor-agent');
  assert.deepEqual(entry?.aliases, ['agent']);
  assert.deepEqual(CURSOR.binary.names, ['cursor-agent', 'agent']);
  assert.deepEqual(entry?.identity, CURSOR.binary.identity);
  const pattern = new RegExp(CURSOR.binary.identity!.pattern, 'm');
  assert.match('2026.10.16-0a1b2c3', pattern);
  assert.doesNotMatch('grok 1.0.13 (5e9a58528b76) [stable]', pattern, 'the real grok `agent`');
  assert.doesNotMatch('grok-cli 0.9.1', pattern);
});

const json = readJson(join(CURSOR_DIR, 'package.json'));
const parsed = readManifest(json);
if (!parsed.ok) throw new Error(parsed.message);
const { manifest } = parsed;
const entry = await import(pathToFileURL(join(CURSOR_DIR, 'lib', 'index.js')).href) as { apply(ctx: unknown): void | Promise<void> };
const context = () => {
  const root = new Context();
  return createPluginContext(root, { manifest, version: '0.1.0' }, daemonHost(root));
};

test.after(() => { process.env.PATH = previousPath; resetPluginPolicyState(); });

test('REFUSAL: grok\'s `agent` answers to the alias, and the authorization click refuses it — nothing is allowed', { skip: !posix }, async () => {
  installAgent(GROK_AGENT);
  assert.deepEqual(providerBinaryRequests(manifest), [{ name: 'cursor-agent', found: 'agent', resolved: AGENT, allowed: false, refused: null }]);
  await assert.rejects(grantProviderBinaries(manifest, [AGENT]), (error: Error) =>
    error instanceof ExecGrantError && error.code === 'binary-identity' && error.status === 409
    && error.message.includes('"grok 1.0.13 (5e9a58528b76) [stable]"') && error.message.includes("Cursor's agent CLI"));
  assert.deepEqual(config().pluginPolicy.exec.allow, []);
  await assert.rejects(async () => entry.apply(context()), 'without an authorization the plugin does not register');
  assert.equal(getDialect('cursor'), undefined);
});

test('Cursor\'s own `agent` is authorized on the click, and the plugin launches that name', { skip: !posix }, async () => {
  installAgent(CURSOR_AGENT);
  const granted = await grantProviderBinaries(manifest, [AGENT]);
  assert.deepEqual(granted.added, [AGENT]);
  await entry.apply(context());
  assert.ok(getDialect('cursor'), 'the provider registered with the alias first');
  const profile = installedProfiles().find((p) => p.id === 'cursor');
  assert.equal(profile?.cmd, 'agent', 'the profile launches the name that resolved');
  assert.equal(profile?.requiredBinary, 'agent');
  await assertLaunchIdentity('cursor', 'agent');
});

test('REFUSAL: grok\'s installer writes its `agent` over the authorized one — the launch is refused', { skip: !posix }, async () => {
  installAgent(`${GROK_AGENT}# another size, so the answer kept for the previous file is not reused\n`);
  await assert.rejects(assertLaunchIdentity('cursor', 'agent'), (error: Error) =>
    error instanceof BinaryIdentityError && /printed "grok 1\.0\.13/.test(error.message));
});
