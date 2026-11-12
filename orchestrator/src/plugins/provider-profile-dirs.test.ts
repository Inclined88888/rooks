/**
 * C2 for ONE profile (`BackendProfile.credentialDirs`): a profile whose id differs from
 * its dialect's names the folder that is ITS own (`ollama-cloud` on `codex`: `.ollama`),
 * and only that. The refusals come first — a folder reserved for another backend, the
 * user's own key stores, a folder the manifest did not list.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import type { NativeProviderDefinition } from '../backends/engine/definition.js';

const { readManifest } = await import('./manifest.js');
const { createPluginContext, daemonHost } = await import('./context.js');
const { PluginPolicyError } = await import('./policy.js');
const { config, setConfig } = await import('../config/load.js');
const { NovaConfigSchema } = await import('../config/schema.js');
const { resolveIsolation } = await import('../host/isolation.js');
const { credentialDirProblem } = await import('../backends/provider-declarations.js');
const { otherBackendHomeDirProblem } = await import('../backends/credential-home-dirs.js');
const { ownerCredentialDirs } = await import('../backends/registry.js');

function allowExec(...names: string[]): () => void {
  const previous = config();
  setConfig(NovaConfigSchema.parse({ ...previous, pluginPolicy: { ...previous.pluginPolicy, exec: { allow: names } } }));
  return () => setConfig(previous);
}

function pluginContext(pluginId: string, binary: string, credentialDirs: string[], builtin = false) {
  const res = readManifest({ rooks: {
    id: pluginId, apiVersion: 12, kind: 'provider', permissions: ['backends:register'],
    provider: { binaries: [{ name: binary }], credentialDirs },
  } });
  assert.equal(res.ok, true, res.ok ? '' : res.message);
  if (!res.ok) throw new Error('unreachable');
  return createPluginContext(new Context(), { manifest: res.manifest, version: '1.0.0', ...(builtin ? { builtin: true } : {}) }, daemonHost());
}

function dialect(id: string, binary: string, credentialDirs: string[]): NativeProviderDefinition {
  return {
    id,
    transport: { kind: 'process-per-turn' },
    codec: { kind: 'lines', parseLine: () => [], extractSessionId: () => null, writeUserInput: () => { /* a launch carries the turn */ } },
    launch: async (spawn, profile) => ({ cmd: profile.cmd, args: [], cwd: spawn.cfg.cwd, initialStdin: null }),
    session: { store: 'per-mission', resumable: false },
    permission: { model: 'sandbox' },
    limits: { reporting: 'textual' },
    mcp: { rooks: true },
    declares: { binary: { names: [binary] }, credentialDirs },
  };
}

const profileOf = (id: string, dialectId: string, credentialDirs?: string[]) =>
  ({ id, label: id, vendor: 'Acme', dialect: dialectId, models: [], defaultModel: null, ...(credentialDirs ? { credentialDirs } : {}) });

/* ── Refusals first ──────────────────────────────────────────────────────── */

test('REFUSAL: another backend\'s folder is refused to a claimant that is not that backend', () => {
  assert.match(credentialDirProblem('.ollama', ['codex']) ?? '', /credential folder of the `ollama-cloud` backend/);
  assert.match(credentialDirProblem('.codex', ['ollama-cloud']) ?? '', /credential folder of the `codex` backend/);
  assert.match(credentialDirProblem('.claude', ['acme-profile']) ?? '', /`claude` backend/);
  assert.match(credentialDirProblem('.claude') ?? '', /`claude` backend/, 'a claimant that names no id gets no table folder');
  assert.equal(credentialDirProblem('.ollama', ['ollama-cloud']), null, 'the profile that owns the folder may name it');
  assert.equal(otherBackendHomeDirProblem('.ollama', ['ollama-cloud', 'codex']), null);
  assert.match(otherBackendHomeDirProblem('.ollama', ['codex']) ?? '', /ollama-cloud/);
});

test('REFUSAL: a profile cannot name a folder of another backend, a key store, or one its manifest did not list', async () => {
  const restore = allowExec('acme-base-bin');
  try {
    const ctx = pluginContext('acme-profile-plugin-a', 'acme-base-bin', ['.acme-own', '.acme-listed', '.claude', '.ollama']);
    const stranger = pluginContext('acme-profile-plugin-b', 'acme-base-bin', ['.acme-b']);
    // The folder of another backend: refused by the profile's own id, even though a manifest may list anything that is not a key store.
    assert.throws(() => ctx.backends.registerProfile(profileOf('evil-claude', 'claude', ['.claude'])), /credential folder of the `claude` backend/);
    assert.throws(() => ctx.backends.registerProfile(profileOf('evil-ollama', 'codex', ['.ollama'])), /ollama-cloud/);
    // The user's own key stores.
    assert.throws(() => ctx.backends.registerProfile(profileOf('evil-ssh', 'codex', ['.ssh'])), /holds credentials that belong to the user/);
    assert.throws(() => ctx.backends.registerProfile(profileOf('evil-container', 'codex', ['.config'])), /holds credentials that belong to the user/);
    assert.throws(() => ctx.backends.registerProfile(profileOf('evil-path', 'codex', ['../x'])), /\.\./);
    // A folder the manifest did not list: the operator saw `.acme-own` and `.acme-listed`.
    assert.throws(() => ctx.backends.registerProfile(profileOf('acme-unlisted', 'codex', ['.acme-surprise'])), (error: unknown) =>
      error instanceof PluginPolicyError && /manifest declares/.test(error.message));
    assert.throws(() => stranger.backends.registerProfile(profileOf('acme-borrowed', 'codex', ['.acme-own'])), PluginPolicyError, 'listed by ANOTHER plugin is not listed by this one');
  } finally {
    restore();
  }
});

test('the manifest keeps refusing the user\'s key stores, and leaves "another backend\'s folder" to the claim', () => {
  const read = (dir: string) => readManifest({ rooks: {
    id: 'acme-manifest', apiVersion: 12, kind: 'provider', permissions: ['backends:register'],
    provider: { binaries: [{ name: 'acme' }], credentialDirs: [dir] },
  } });
  assert.equal(read('.ssh').ok, false);
  assert.equal(read('.config').ok, false);
  assert.equal(read('.ollama').ok, true, 'an `ollama-cloud` plugin must be able to list its folder');
  assert.equal(read('.acme').ok, true);
});

/* ── The profile's own folder ────────────────────────────────────────────── */

test('a profile on a dialect of another plugin spares ITS folder, not the dialect\'s, and masks the rest', () => {
  const restore = allowExec('acme-base-bin');
  const base = pluginContext('acme-base-plugin', 'acme-base-bin', ['.acme-base']);
  const sub = pluginContext('acme-sub-plugin', 'acme-base-bin', ['.acme-sub']);
  const home = '/home/tester';
  const cfg = NovaConfigSchema.parse({});
  try {
    const releaseDialect = base.provider.registerProvider(dialect('acme-base', 'acme-base-bin', ['.acme-base']));
    const releaseBase = base.backends.registerProfile(profileOf('acme-base-profile', 'acme-base'));
    const releaseSub = sub.backends.registerProfile(profileOf('acme-sub-profile', 'acme-base', ['.acme-sub']));

    const onBase = resolveIsolation(cfg, { home, backend: 'acme-base-profile' });
    assert.equal(onBase.deny.includes(`${home}/.acme-base`), false, 'the dialect\'s profile keeps the dialect\'s folder');
    assert.ok(onBase.deny.includes(`${home}/.acme-sub`), 'and cannot read the sub-profile\'s');

    const onSub = resolveIsolation(cfg, { home, backend: 'acme-sub-profile' });
    assert.equal(onSub.deny.includes(`${home}/.acme-sub`), false, 'the sub-profile keeps its own folder');
    assert.ok(onSub.deny.includes(`${home}/.acme-base`), 'and does NOT inherit the dialect\'s: it must not read the base sign-in');

    const onClaude = resolveIsolation(cfg, { home, backend: 'claude' });
    assert.ok(onClaude.deny.includes(`${home}/.acme-sub`) && onClaude.deny.includes(`${home}/.acme-base`), 'every other backend has both masked');

    assert.deepEqual(ownerCredentialDirs('acme-sub-plugin'), ['.acme-sub'], 'what scratch.link may read for the profile\'s plugin');
    assert.deepEqual(ownerCredentialDirs('acme-base-plugin'), ['.acme-base']);
    releaseSub();
    releaseBase();
    releaseDialect();
    assert.deepEqual(ownerCredentialDirs('acme-sub-plugin'), [], 'gone with the plugin\'s profile');
  } finally {
    restore();
  }
});

test('REFUSAL: a third party cannot take a product backend\'s folder by registering under its id; one shipped in the release can', () => {
  const restore = allowExec('acme-squat-bin');
  try {
    // `ollama-cloud` and `kimi` are profiles of the product, not dialect ids: the id is free for a dialect.
    for (const [id, dir] of [['ollama-cloud', '.ollama'], ['kimi', '.kimi']] as const) {
      const squatter = pluginContext(`acme-squat-${id}`, 'acme-squat-bin', [dir]);
      assert.throws(() => squatter.provider.registerProvider(dialect(id, 'acme-squat-bin', [dir])), /credential folder of the `.+` backend/, `${id} must not be claimable`);
      assert.throws(() => squatter.backends.registerProfile(profileOf(`${id}-profile`, 'codex', [dir])), /credential folder of the `.+` backend/);
      assert.equal(ownerCredentialDirs(`acme-squat-${id}`).length, 0, 'nothing for scratch.link to read');
      const isolation = resolveIsolation(NovaConfigSchema.parse({}), { home: '/home/tester', backend: `${id}-profile` });
      assert.ok(isolation.deny.includes(`/home/tester/${dir}`), `${dir} stays masked for everyone but its owner`);
    }
    // The same declaration from a provider shipped in the release is accepted.
    const official = pluginContext('acme-official-ollama', 'acme-squat-bin', ['.ollama'], true);
    const release = official.provider.registerProvider(dialect('ollama-cloud', 'acme-squat-bin', ['.ollama']));
    try {
      assert.deepEqual(ownerCredentialDirs('acme-official-ollama'), ['.ollama']);
    } finally {
      release();
    }
  } finally {
    restore();
  }
});
