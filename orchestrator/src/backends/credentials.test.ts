/**
 * Credentials are resolved at each spawn (docs/BACKENDS-OUVERTS.md, D1).
 *
 * The regression these tests guard is invisible from the outside: everything
 * works on the first mission, and the frozen value only bites when a key is
 * rotated or a thirty-minute token expires — half an hour later, with nothing
 * pointing here.
 */
// Isolates ROOKS_HOME BEFORE any module touching Rooks state (see test-home.ts).
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSecret, deleteSecret, updateSecret } from '../secrets/store.js';
import { dbApi } from '../db.js';
import {
  activeProfiles, inactiveProfiles, installedProfiles, onBackendsChanged, recheckCredentials, registerDialect, registerProfile,
  registerTrustedProfile,
  type RegisteredProfile,
} from './registry.js';
import { backendCatalog, backendNames, getBackend, isBackendName } from './index.js';
import { RESOLVER_FAILED, daemonCredential, probeResolver, resolveProfileEnv } from './credentials.js';
import type { BuildSpawnOpts, Dialect } from './types.js';

/** Hands the resolved env straight back, so a test reads what a CLI would get. */
const probeDialect: Dialect = {
  defaultCmd: 'probe',
  persistentProcess: false,
  finishMissionOnExit: false,
  sessionResumable: false,
  sessionStore: 'global',
  permissionModel: 'none',
  rateLimitReporting: 'none',
  hostedConnectors: false,
  async buildSpawn(opts, profile) {
    return { cmd: profile.cmd, args: [], env: profile.env, cwd: opts.cfg.cwd, initialStdin: null };
  },
  writeUserInput() { /* one-shot */ },
  parseLine: () => [],
  extractSessionId: () => null,
};
registerDialect('test', 'probe', probeDialect);

function spawnOpts(missionId: string, project: string | null = null): BuildSpawnOpts {
  return {
    agentName: 'acme.coder',
    systemPrompt: '',
    message: 'hi',
    cfg: { cwd: process.cwd(), project },
    missionId,
  } as unknown as BuildSpawnOpts;
}

const shape = { dialect: 'probe', label: 'Probe', models: [], defaultModel: null } as const;

{
  const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

test('an envFrom value changed between two missions is seen by the second', async () => {
  process.env.PROBE_A_KEY = 'first';
  const off = registerTrustedProfile('test', {
    ...shape, id: 'probe-a', requiredEnv: ['PROBE_A_KEY'], envFrom: { CHILD_TOKEN: 'PROBE_A_KEY' },
  });
  try {
    const backend = getBackend('probe-a');
    assert.equal((await backend.buildSpawn(spawnOpts('m1'))).env?.CHILD_TOKEN, 'first');
    // No registry mutation, no restart — and the SAME Backend object, as a
    // mission that holds on to it would have.
    process.env.PROBE_A_KEY = 'second';
    assert.equal((await backend.buildSpawn(spawnOpts('m2'))).env?.CHILD_TOKEN, 'second');
  } finally {
    off();
    delete process.env.PROBE_A_KEY;
  }
});

test('a vault reference is opened at each spawn, not at registration', async () => {
  const secret = createSecret({ name: 'PROBE_B_KEY', value: 'vault-1', grants: ['global'] });
  const off = registerTrustedProfile('test', {
    ...shape, id: 'probe-b', env: { CHILD_TOKEN: { secret: 'PROBE_B_KEY' }, BASE_URL: 'https://example.test' },
  });
  try {
    const backend = getBackend('probe-b');
    const first = await backend.buildSpawn(spawnOpts('m1'));
    assert.deepEqual(first.env, { CHILD_TOKEN: 'vault-1', BASE_URL: 'https://example.test' });
    updateSecret(secret.id, { value: 'vault-2' });
    assert.equal((await backend.buildSpawn(spawnOpts('m2'))).env?.CHILD_TOKEN, 'vault-2');
    // The injection is journalled against the mission, by NAME.
    const journal = dbApi.listSecretAccess(secret.id);
    assert.deepEqual(journal.map((row) => row.mission_id).sort(), ['m1', 'm2']);
  } finally {
    off();
    deleteSecret(secret.id);
  }
});

test('a reference does not reach around a scope', async () => {
  const secret = createSecret({ name: 'PROBE_C_KEY', value: 'only-acme', grants: ['project:acme'] });
  const off = registerTrustedProfile('test', { ...shape, id: 'probe-c', env: { CHILD_TOKEN: { secret: 'PROBE_C_KEY' } } });
  try {
    const backend = getBackend('probe-c');
    assert.equal((await backend.buildSpawn(spawnOpts('m1', 'acme'))).env?.CHILD_TOKEN, 'only-acme');
    await assert.rejects(backend.buildSpawn(spawnOpts('m2', 'other')), (err: Error) => {
      assert.match(err.message, /probe-c.*PROBE_C_KEY.*not granted/);
      assert.ok(!err.message.includes('only-acme'));
      return true;
    });
  } finally {
    off();
    deleteSecret(secret.id);
  }
});

test('visibility follows the credential, without any registry mutation', () => {
  const off = registerTrustedProfile('test', { ...shape, id: 'probe-d', env: { CHILD_TOKEN: { secret: 'PROBE_D_KEY' } } });
  let changes = 0;
  const unsubscribe = onBackendsChanged(() => { changes += 1; });
  try {
    assert.equal(isBackendName('probe-d'), false);
    assert.equal(backendCatalog().some((b) => b.id === 'probe-d'), false);
    assert.deepEqual(
      inactiveProfiles().find((p) => p.id === 'probe-d'),
      { id: 'probe-d', reason: 'vault entry PROBE_D_KEY does not exist (add it to the Secret Vault and grant it to `global`)' },
    );

    const secret = createSecret({ name: 'PROBE_D_KEY', value: 'late', grants: ['global'] });
    assert.equal(isBackendName('probe-d'), true);
    assert.equal(backendCatalog().some((b) => b.id === 'probe-d'), true);
    assert.equal(changes, 1, 'the UI is told once');

    deleteSecret(secret.id);
    assert.equal(isBackendName('probe-d'), false);
    assert.equal(changes, 2);
  } finally {
    unsubscribe();
    off();
  }
});

test('requiredEnv is re-evaluated, not frozen at boot', () => {
  const off = registerTrustedProfile('test', { ...shape, id: 'probe-e', requiredEnv: ['PROBE_E_KEY'] });
  try {
    assert.equal(backendNames().includes('probe-e'), false);
    assert.match(inactiveProfiles().find((p) => p.id === 'probe-e')?.reason ?? '', /PROBE_E_KEY is not set/);
    process.env.PROBE_E_KEY = 'x';
    assert.equal(backendNames().includes('probe-e'), true);
    delete process.env.PROBE_E_KEY;
    assert.equal(backendNames().includes('probe-e'), false);
  } finally {
    off();
    delete process.env.PROBE_E_KEY;
  }
});

test('the registry array keeps its identity while nothing moved', () => {
  assert.equal(activeProfiles(), activeProfiles());
});

test("a plugin's env function is called at each spawn — nothing is captured", async () => {
  let token = 'short-lived-1';
  let calls = 0;
  const off = registerProfile('acme-plugin', {
    ...shape, id: 'probe-f', env: async () => { calls += 1; return { CHILD_TOKEN: token }; },
  });
  try {
    // Registration PROBES it (can it answer?) and drops what it returned.
    await recheckCredentials();
    const probes = calls;
    const backend = getBackend('probe-f');
    assert.equal(backend.name, 'probe-f');
    assert.equal((await backend.buildSpawn(spawnOpts('m1'))).env?.CHILD_TOKEN, 'short-lived-1');
    token = 'short-lived-2';
    assert.equal((await backend.buildSpawn(spawnOpts('m2'))).env?.CHILD_TOKEN, 'short-lived-2');
    assert.equal(calls - probes, 2, 'one call per spawn');
  } finally {
    off();
  }
});

test("a plugin profile without its key is inactive, and comes back once the key exists", async () => {
  let key: string | undefined;
  const off = registerProfile('acme-plugin', {
    ...shape,
    id: 'probe-g',
    env: () => {
      if (!key) throw new Error('token sk-LEAK rejected');
      return { CHILD_TOKEN: key };
    },
  });
  let changes = 0;
  const unsubscribe = onBackendsChanged(() => { changes += 1; });
  try {
    // Out of the dispatch from the very first read: no mission is launched on it.
    assert.equal(isBackendName('probe-g'), false);
    assert.equal(backendCatalog().some((b) => b.id === 'probe-g'), false);
    assert.deepEqual(
      inactiveProfiles().find((p) => p.id === 'probe-g'),
      { id: 'probe-g', reason: RESOLVER_FAILED },
    );

    key = 'late';
    await recheckCredentials();
    assert.equal(isBackendName('probe-g'), true);
    assert.equal(changes, 1, 'the UI is told once');
    assert.equal((await getBackend('probe-g').buildSpawn(spawnOpts('m1'))).env?.CHILD_TOKEN, 'late');
  } finally {
    unsubscribe();
    off();
  }
});

test('an async env function keeps its profile out until it has answered', async () => {
  let token: string | null = 'short-lived';
  const off = registerProfile('acme-plugin', {
    ...shape,
    id: 'probe-j',
    env: async () => {
      if (!token) throw new Error('refresh denied');
      return { CHILD_TOKEN: token };
    },
  });
  try {
    assert.equal(isBackendName('probe-j'), false);
    assert.equal(inactiveProfiles().find((p) => p.id === 'probe-j')?.reason, 'credential resolver has not answered yet');
    await recheckCredentials();
    assert.equal(isBackendName('probe-j'), true);

    token = null;
    await recheckCredentials();
    assert.equal(isBackendName('probe-j'), false);
  } finally {
    off();
  }
});

test('a credential lost between the probe and the spawn takes the profile out, readably', async () => {
  let key: string | undefined = 'ok';
  const off = registerProfile('acme-plugin', {
    ...shape,
    id: 'probe-k',
    env: () => {
      if (!key) throw new Error('token sk-LEAK rejected');
      return { CHILD_TOKEN: key };
    },
  });
  try {
    const backend = getBackend('probe-k');
    assert.equal(backend.name, 'probe-k');
    key = undefined;
    await assert.rejects(backend.buildSpawn(spawnOpts('m1')), (err: Error) => {
      assert.match(err.message, /probe-k.*credential resolver failed/);
      assert.ok(!err.message.includes('sk-LEAK'));
      return true;
    });
    // The next mission is not sent there.
    assert.equal(isBackendName('probe-k'), false);
  } finally {
    off();
  }
});

test("nothing of a resolver's error is disclosed — neither its name nor its message", async () => {
  const MARKER = 'sk-MARKER-9f3a';
  const leaky = (): Error => {
    const err = new Error(`token ${MARKER} rejected`);
    err.name = MARKER;
    return err;
  };
  let key: string | undefined;
  const offSync = registerProfile('acme-plugin', {
    ...shape, id: 'probe-p', env: () => { if (!key) throw leaky(); return { CHILD_TOKEN: key }; },
  });
  const offAsync = registerProfile('acme-plugin', {
    ...shape, id: 'probe-q', env: async () => { if (!key) throw leaky(); return { CHILD_TOKEN: key }; },
  });
  // Everything the API serialises about backends.
  const exposed = (): string => JSON.stringify([inactiveProfiles(), backendCatalog()]);
  try {
    // The probe, synchronous then asynchronous.
    assert.equal(inactiveProfiles().find((p) => p.id === 'probe-p')?.reason, RESOLVER_FAILED);
    assert.ok(!exposed().includes(MARKER));
    await recheckCredentials();
    assert.equal(inactiveProfiles().find((p) => p.id === 'probe-q')?.reason, RESOLVER_FAILED);
    assert.ok(!exposed().includes(MARKER));

    // The spawn path: active, then the credential goes away under a mission.
    key = 'ok';
    await recheckCredentials();
    const backends = [getBackend('probe-p'), getBackend('probe-q')];
    key = undefined;
    for (const backend of backends) {
      await assert.rejects(backend.buildSpawn(spawnOpts('m1')), (err: Error) => {
        assert.match(err.message, /credential resolver failed: check that this account has a connection to the backend \(Settings › Secrets › Connections\)$/);
        assert.ok(!`${err.name} ${err.message} ${err.stack}`.includes(MARKER));
        return true;
      });
    }
    assert.equal(inactiveProfiles().find((p) => p.id === 'probe-p')?.reason, RESOLVER_FAILED);
    assert.ok(!exposed().includes(MARKER));
  } finally {
    offSync();
    offAsync();
  }
});

test("a getter that throws on the resolver's object discloses nothing, and takes the profile out", async () => {
  const MARKER = 'sk-GETTER-7c1e';
  let broken = false;
  const provided = (): Record<string, string> => ({
    get CHILD_TOKEN(): string {
      if (broken) throw new Error(`token ${MARKER} rejected`);
      return 'ok';
    },
  });
  const offSync = registerProfile('acme-plugin', { ...shape, id: 'probe-r', env: () => provided() });
  const offAsync = registerProfile('acme-plugin', { ...shape, id: 'probe-s', env: async () => provided() });
  const exposed = (): string => JSON.stringify([inactiveProfiles(), backendCatalog()]);
  const ids = ['probe-r', 'probe-s'];
  try {
    await recheckCredentials();
    const backends = ids.map((id) => getBackend(id));
    assert.deepEqual(backends.map((b) => b.name), ids);

    // The spawn path: registered healthy, the getter breaks under a mission.
    broken = true;
    for (const backend of backends) {
      await assert.rejects(backend.buildSpawn(spawnOpts('m1')), (err: Error) => {
        assert.match(err.message, /credential resolver failed: check that this account has a connection to the backend \(Settings › Secrets › Connections\)$/);
        assert.ok(!`${err.name} ${err.message} ${err.stack}`.includes(MARKER));
        return true;
      });
    }
    for (const id of ids) {
      assert.equal(isBackendName(id), false, `${id} must not stay active`);
      assert.equal(inactiveProfiles().find((p) => p.id === id)?.reason, RESOLVER_FAILED);
    }
    assert.ok(!exposed().includes(MARKER));

    // The probe path: back to healthy, then broken again with no spawn involved.
    broken = false;
    await recheckCredentials();
    for (const id of ids) assert.equal(isBackendName(id), true);
    broken = true;
    await recheckCredentials();
    for (const id of ids) {
      assert.equal(isBackendName(id), false);
      assert.equal(inactiveProfiles().find((p) => p.id === id)?.reason, RESOLVER_FAILED);
    }
    assert.ok(!exposed().includes(MARKER));
  } finally {
    offSync();
    offAsync();
  }
});

test('a resolver value is read once: what was checked is what the mission gets', async () => {
  let lastReads = 0;
  const off = registerProfile('acme-plugin', {
    ...shape,
    id: 'probe-t',
    env: () => {
      let reads = 0;
      return {
        // A string on the first read of each object, something else afterwards.
        get CHILD_TOKEN(): string {
          reads += 1;
          lastReads = reads;
          return reads === 1 ? 'checked' : (42 as unknown as string);
        },
      };
    },
  });
  try {
    assert.equal((await getBackend('probe-t').buildSpawn(spawnOpts('m1'))).env?.CHILD_TOKEN, 'checked');
    assert.equal(lastReads, 1);
  } finally {
    off();
  }
});

test('an unreadable duplicate does not hide a valid entry — for the probe and the spawn alike', async () => {
  const valid = createSecret({ name: 'PROBE_L_KEY', value: 'good', grants: ['global'] });
  // Agent scope: it OUTRANKS the global one, so it is the entry the resolver picks.
  const broken = createSecret({ name: 'PROBE_L_KEY', value: 'lost', grants: ['agent:acme.coder'] });
  // Same envelope, unreadable: what a row sealed under a lost master key looks like.
  const sealed = dbApi.getSecret(broken.id)!.value_enc;
  dbApi.updateSecret(broken.id, { value_enc: `${sealed.slice(0, -4)}AAAA` });
  const off = registerTrustedProfile('test', { ...shape, id: 'probe-l', env: { CHILD_TOKEN: { secret: 'PROBE_L_KEY' } } });
  try {
    assert.equal(isBackendName('probe-l'), true);
    // The agent-scoped entry wins the selection; unreadable, the global one serves.
    assert.equal((await getBackend('probe-l').buildSpawn(spawnOpts('m1'))).env?.CHILD_TOKEN, 'good');

    deleteSecret(valid.id);
    assert.equal(isBackendName('probe-l'), false);
    assert.match(inactiveProfiles().find((p) => p.id === 'probe-l')!.reason, /^vault entry PROBE_L_KEY cannot be read \(/);
  } finally {
    off();
    deleteSecret(broken.id);
    if (dbApi.getSecret(valid.id)) deleteSecret(valid.id);
  }
});

test('an entry made readable again reactivates its profile, with no write to the vault index', () => {
  const secret = createSecret({ name: 'PROBE_M_KEY', value: 'back', grants: ['global'] });
  const row = dbApi.getSecret(secret.id)!;
  const off = registerTrustedProfile('test', { ...shape, id: 'probe-m', env: { CHILD_TOKEN: { secret: 'PROBE_M_KEY' } } });
  try {
    assert.equal(isBackendName('probe-m'), true);
    dbApi.updateSecret(secret.id, { value_enc: `${row.value_enc.slice(0, -4)}AAAA` }, row.updated_at);
    assert.equal(isBackendName('probe-m'), false);
    // Same id, same updated_at as when it was unreadable: only the ANSWER of
    // the probe moved, which is all the cache may depend on.
    dbApi.updateSecret(secret.id, { value_enc: row.value_enc }, row.updated_at);
    assert.equal(isBackendName('probe-m'), true);
  } finally {
    off();
    deleteSecret(secret.id);
  }
});

test('an entry with no grant serves no profile, and the grant activates it live', async () => {
  // No grant = the daemon's own (SECRETS-VAULT.md §5.2). A profile's env lands
  // in the mission process, where the agent can read it, so a reference must
  // NOT be the door around that rule.
  const secret = createSecret({ name: 'PROBE_N_KEY', value: 'ungranted' });
  const off = registerTrustedProfile('test', { ...shape, id: 'probe-n', env: { CHILD_TOKEN: { secret: 'PROBE_N_KEY' } } });
  try {
    assert.equal(isBackendName('probe-n'), false);
    // The reason says what to DO: this is the mistake a form makes silently.
    assert.equal(
      inactiveProfiles().find((p) => p.id === 'probe-n')?.reason,
      'vault entry PROBE_N_KEY has no grant: no mission can receive it (grant it to `global`, or reserve it to this backend with `backend:<id>`)',
    );

    // Granted after the fact: no registry mutation, no restart.
    dbApi.addSecretGrant(secret.id, 'global', null);
    assert.equal(isBackendName('probe-n'), true);
    assert.equal((await getBackend('probe-n').buildSpawn(spawnOpts('m1'))).env?.CHILD_TOKEN, 'ungranted');
  } finally {
    off();
    deleteSecret(secret.id);
  }
});

test('a grant naming another agent does not serve this mission', async () => {
  const secret = createSecret({ name: 'PROBE_O_KEY', value: 'other-agent', grants: ['agent:acme.reviewer'] });
  const off = registerTrustedProfile('test', { ...shape, id: 'probe-o', env: { CHILD_TOKEN: { secret: 'PROBE_O_KEY' } } });
  try {
    // Visible: SOME mission could be served — `acme.reviewer`'s.
    assert.equal(isBackendName('probe-o'), true);
    await assert.rejects(getBackend('probe-o').buildSpawn(spawnOpts('m1')), (err: Error) => {
      assert.match(err.message, /probe-o.*PROBE_O_KEY is not granted to this mission/);
      assert.ok(!err.message.includes('other-agent'));
      return true;
    });
  } finally {
    off();
    deleteSecret(secret.id);
  }
});

test('a plugin cannot name a vault entry', () => {
  const sneaky = { ...shape, id: 'probe-h', env: { CHILD_TOKEN: { secret: 'GITHUB_TOKEN' } } } as unknown as RegisteredProfile;
  assert.throws(() => registerProfile('acme-plugin', sneaky), /strings only/);
  assert.equal(isBackendName('probe-h'), false);
});

test('literal env values still work for a plugin', async () => {
  const off = registerProfile('acme-plugin', { ...shape, id: 'probe-i', env: { BASE_URL: 'https://example.test' } });
  try {
    assert.deepEqual((await getBackend('probe-i').buildSpawn(spawnOpts('m1'))).env, { BASE_URL: 'https://example.test' });
  } finally {
    off();
  }
});

/* ── Non-regression on the profiles of the repo ─────────────────────────── */

test('first-party profiles declare no credential and resolve an empty env', async () => {
  for (const id of ['claude', 'codex', 'grok']) {
    const profile = installedProfiles().find((p) => p.id === id)!;
    assert.equal(profile.requiredEnv, undefined);
    assert.equal(profile.env, undefined);
    assert.equal(profile.envFrom, undefined);
  }
  const claude = activeProfiles().find((p) => p.profile.id === 'claude')!;
  assert.deepEqual((await claude.runtimeFor()).runtime, {
    id: 'claude', cmd: 'claude', env: {}, providerConfig: undefined, minCliVersion: undefined,
  });
});

test('kimi: absent without its key, default base URL, override wins', async () => {
  delete process.env.KIMI_API_KEY;
  delete process.env.KIMI_BASE_URL;
  assert.equal(isBackendName('kimi'), false);

  process.env.KIMI_API_KEY = 'k-1';
  try {
    const kimi = activeProfiles().find((p) => p.profile.id === 'kimi')!;
    assert.deepEqual((await kimi.runtimeFor()).runtime.env, {
      ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'k-1',
    });
    process.env.KIMI_BASE_URL = 'https://proxy.test';
    assert.equal((await kimi.runtimeFor()).runtime.env.ANTHROPIC_BASE_URL, 'https://proxy.test');
  } finally {
    delete process.env.KIMI_API_KEY;
    delete process.env.KIMI_BASE_URL;
  }
  assert.equal(isBackendName('kimi'), false);
});

test('ollama-cloud: key forwarded under its own name, provider config intact', async () => {
  delete process.env.OLLAMA_API_KEY;
  assert.equal(isBackendName('ollama-cloud'), false);
  process.env.OLLAMA_API_KEY = 'o-1';
  try {
    const ollama = activeProfiles().find((p) => p.profile.id === 'ollama-cloud')!;
    const { runtime } = await ollama.runtimeFor();
    assert.deepEqual(runtime.env, { OLLAMA_API_KEY: 'o-1' });
    assert.equal(runtime.cmd, 'codex');
    assert.equal(runtime.providerConfig?.envKey, 'OLLAMA_API_KEY');
  } finally {
    delete process.env.OLLAMA_API_KEY;
  }
});

test('ollama-cloud: a key held only in the vault activates it and reaches the CLI', async () => {
  delete process.env.OLLAMA_API_KEY;
  const profile = installedProfiles().find((p) => p.id === 'ollama-cloud')!;
  assert.equal(isBackendName('ollama-cloud'), false);
  assert.match(
    inactiveProfiles().find((p) => p.id === 'ollama-cloud')?.reason ?? '',
    /vault entry OLLAMA_API_KEY does not exist \(add it to the Secret Vault and grant it to `global`\)/,
  );
  assert.equal(daemonCredential(profile, 'OLLAMA_API_KEY'), null);

  const secret = createSecret({ name: 'OLLAMA_API_KEY', value: 'o-vault', grants: ['global'] });
  try {
    assert.equal(isBackendName('ollama-cloud'), true);
    const ollama = activeProfiles().find((p) => p.profile.id === 'ollama-cloud')!;
    assert.deepEqual((await ollama.runtimeFor()).runtime.env, { OLLAMA_API_KEY: 'o-vault' });
    assert.equal(daemonCredential(profile, 'OLLAMA_API_KEY'), 'o-vault');
    // An install that still sets it in `secrets.env` keeps its own key.
    process.env.OLLAMA_API_KEY = 'o-env';
    assert.deepEqual((await ollama.runtimeFor()).runtime.env, { OLLAMA_API_KEY: 'o-env' });
    assert.equal(daemonCredential(profile, 'OLLAMA_API_KEY'), 'o-env');
  } finally {
    delete process.env.OLLAMA_API_KEY;
    deleteSecret(secret.id);
  }
  assert.equal(isBackendName('ollama-cloud'), false);
});

test('kimi: its key may live in the vault too', async () => {
  delete process.env.KIMI_API_KEY;
  const secret = createSecret({ name: 'KIMI_API_KEY', value: 'k-vault', grants: ['global'] });
  try {
    const kimi = activeProfiles().find((p) => p.profile.id === 'kimi')!;
    assert.equal((await kimi.runtimeFor()).runtime.env.ANTHROPIC_AUTH_TOKEN, 'k-vault');
  } finally {
    deleteSecret(secret.id);
  }
  assert.equal(isBackendName('kimi'), false);
});

test('the probe recognises a promise the way the spawn does, so both agree on the same object', async () => {
  const MARKER = 'sk-PROBE-SPAWN-4b2d';
  const fail = (): never => { throw new Error(MARKER); };
  // A trap `instanceof` would run but `await` never does: the spawn accepts
  // this object, so the probe must too.
  const prototypeTrap = (): Record<string, string> => new Proxy({ TOKEN: 'ok' }, { getPrototypeOf: fail });
  // A `then` getter that throws: `await` rejects, so the probe must refuse.
  const thenTrap = (): Record<string, string> => Object.defineProperty({ TOKEN: 'ok' }, 'then', { get: fail });
  for (const resolver of [prototypeTrap, async () => prototypeTrap()]) {
    assert.equal(await probeResolver(resolver), null);
    assert.deepEqual((await resolveProfileEnv({ ...shape, id: 'probe-t' }, resolver)).env, { TOKEN: 'ok' });
  }
  const sync = probeResolver(thenTrap);
  assert.equal(sync, RESOLVER_FAILED);
  await assert.rejects(resolveProfileEnv({ ...shape, id: 'probe-u' }, thenTrap), (err: Error) => {
    assert.match(err.message, /credential resolver failed: check that this account has a connection to the backend \(Settings › Secrets › Connections\)$/);
    assert.ok(!`${err.message} ${err.stack}`.includes(MARKER));
    return true;
  });
});

test('the probe reads a thenable\'s then once, like the spawn\'s await', async () => {
  // A stateful `then`: the first read settles well, every later read would
  // settle on a non-string. Reading twice would make probe and spawn disagree.
  const statefulThen = (reads: { count: number }) => (): Record<string, string> => Object.defineProperty({}, 'then', {
    get() {
      reads.count += 1;
      return reads.count === 1
        ? (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
          resolve({ TOKEN: 'ok' });
          resolve({ TOKEN: 1 });
          reject(new Error('late'));
          throw new Error('after settling');
        }
        : (resolve: (v: unknown) => void) => resolve({ TOKEN: 2 });
    },
  });
  const probeReads = { count: 0 };
  assert.equal(await probeResolver(statefulThen(probeReads)), null);
  assert.equal(probeReads.count, 1);
  const spawnReads = { count: 0 };
  assert.deepEqual((await resolveProfileEnv({ ...shape, id: 'probe-v' }, statefulThen(spawnReads))).env, { TOKEN: 'ok' });
  assert.equal(spawnReads.count, 1);

  // Called with the object as receiver, as `await` does.
  let receiver: unknown;
  const own = { then(resolve: (v: unknown) => void) { receiver = this; resolve({ TOKEN: 'ok' }); } };
  assert.equal(await probeResolver(() => own as unknown as Record<string, string>), null);
  assert.equal(receiver, own);

  // A throw before settling rejects, without relaying the error.
  const throwing = (): Record<string, string> => ({ then() { throw new Error('sk-THEN-9f1a'); } }) as unknown as Record<string, string>;
  assert.equal(await probeResolver(throwing), RESOLVER_FAILED);
});

// ── TODO #531, decision 5-B: keys reserved to a backend ───────────────────

test('5-B: a reserved key reaches its backend\'s process and nothing else', async () => {
  const { secretsEnvFor } = await import('../secrets/env.js');
  const { readPluginSecret } = await import('../secrets/plugins.js');
  const key = createSecret({ name: 'PROBE_R_KEY', value: 'reserved-value', grants: ['backend:probe-r'] });
  const offMine = registerTrustedProfile('test', { ...shape, id: 'probe-r', env: { CHILD_TOKEN: { secret: 'PROBE_R_KEY' } } });
  // Another backend naming the same entry: the collision a hand-written file can make.
  const offOther = registerTrustedProfile('test', { ...shape, id: 'probe-r2', env: { CHILD_TOKEN: { secret: 'PROBE_R_KEY' } } });
  try {
    assert.equal((await getBackend('probe-r').buildSpawn(spawnOpts('m1'))).env?.CHILD_TOKEN, 'reserved-value');
    // The other backend is not even offered, and says why without the value.
    assert.equal(isBackendName('probe-r2'), false);
    const reason = inactiveProfiles().find((p) => p.id === 'probe-r2')?.reason ?? '';
    assert.equal(reason, 'vault entry PROBE_R_KEY is reserved for another backend');
    // The vault slice of any trusted mission, whatever its backend.
    assert.equal(secretsEnvFor({ agent: 'acme.coder', project: 'acme' }).PROBE_R_KEY, undefined);
    assert.equal(secretsEnvFor({ agent: 'acme.coder', project: null }).PROBE_R_KEY, undefined);
    // A plugin, even one granted by name — the reservation is an intersection.
    dbApi.addSecretGrant(key.id, 'agent', 'plugin:acme-provider');
    assert.equal(readPluginSecret('acme-provider', 'PROBE_R_KEY'), undefined);
    // The daemon's own copy for the backend it belongs to only.
    assert.equal(daemonCredential(installedProfiles().find((p) => p.id === 'probe-r')!, 'CHILD_TOKEN'), 'reserved-value');
    assert.equal(daemonCredential(installedProfiles().find((p) => p.id === 'probe-r2')!, 'CHILD_TOKEN'), null);
  } finally {
    offMine();
    offOther();
    deleteSecret(key.id);
  }
});

test('5-B: reserved and granted to one project — absent from another project, refused at spawn after a valid cache', async () => {
  const { profileServes } = await import('./registry.js');
  const key = createSecret({ name: 'PROBE_S_KEY', value: 'p1-only', grants: ['backend:probe-s', 'project:p1'] });
  const off = registerTrustedProfile('test', { ...shape, id: 'probe-s', env: { CHILD_TOKEN: { secret: 'PROBE_S_KEY' } } });
  try {
    // The inventory (no target) offers it: SOME mission can be served.
    assert.equal(isBackendName('probe-s'), true);
    assert.ok(backendCatalog().some((b) => b.id === 'probe-s'));
    // The contextualised catalogue: only for the project it is granted to.
    assert.equal(profileServes('probe-s', { agent: 'acme.coder', project: 'p1' }), true);
    assert.equal(profileServes('probe-s', { agent: 'acme.coder', project: 'p2' }), false);
    assert.equal(profileServes('probe-s', { agent: 'acme.coder', project: null }), false);

    assert.equal((await getBackend('probe-s').buildSpawn(spawnOpts('m1', 'p1'))).env?.CHILD_TOKEN, 'p1-only');
    // The registry cached "active" a line above; the spawn decides again.
    await assert.rejects(getBackend('probe-s').buildSpawn(spawnOpts('m2', 'p2')), (err: Error) => {
      assert.match(err.message, /PROBE_S_KEY is not granted to this mission/);
      assert.ok(!err.message.includes('p1-only'));
      return true;
    });
    // Revoked while the registry still holds the profile as active.
    const held = getBackend('probe-s');
    dbApi.removeSecretGrant(key.id, 'project', 'p1');
    dbApi.addSecretGrant(key.id, 'project', 'p3');
    await assert.rejects(held.buildSpawn(spawnOpts('m3', 'p1')), /not granted to this mission/);
  } finally {
    off();
    deleteSecret(key.id);
  }
});

test('5-B: rotation in place reaches the next spawn, reservation kept', async () => {
  const key = createSecret({ name: 'PROBE_T_KEY', value: 'old', grants: ['backend:probe-t'] });
  const off = registerTrustedProfile('test', { ...shape, id: 'probe-t', env: { CHILD_TOKEN: { secret: 'PROBE_T_KEY' } } });
  try {
    assert.equal((await getBackend('probe-t').buildSpawn(spawnOpts('m1'))).env?.CHILD_TOKEN, 'old');
    updateSecret(key.id, { value: 'new' });
    assert.equal((await getBackend('probe-t').buildSpawn(spawnOpts('m2'))).env?.CHILD_TOKEN, 'new');
    assert.deepEqual(dbApi.getSecret(key.id)?.grants, [{ scope_kind: 'backend', scope_ref: 'probe-t' }]);
  } finally {
    off();
    deleteSecret(key.id);
  }
});

test('5-B: the identity is the launch\'s own — a delegated agent and a one-shot answer for their agent and project', async () => {
  const { secretTargetFor } = await import('./index.js');
  const key = createSecret({ name: 'PROBE_U_KEY', value: 'coder-only', grants: ['backend:probe-u', 'agent:acme.coder'] });
  const off = registerTrustedProfile('test', { ...shape, id: 'probe-u', env: { CHILD_TOKEN: { secret: 'PROBE_U_KEY' } } });
  try {
    assert.equal((await getBackend('probe-u').buildSpawn(spawnOpts('m1'))).env?.CHILD_TOKEN, 'coder-only');
    // A mission delegated to another agent carries THAT agent, not its parent's.
    const delegated = { ...spawnOpts('m2'), agentName: 'acme.reviewer' } as BuildSpawnOpts;
    await assert.rejects(getBackend('probe-u').buildSpawn(delegated), /not granted to this mission/);
    // The project follows the mission's vault slice: declared, else the cwd's.
    assert.deepEqual(secretTargetFor({ agentName: 'a', cfg: { project: 'p1' } as BuildSpawnOpts['cfg'] }), { agent: 'a', project: 'p1' });
    const cwd = ['', 'home', 'u', 'projects', 'p9', 'src'].join('/'); // portability: a POSIX path parsed, not opened
    assert.deepEqual(secretTargetFor({ agentName: 'a', cfg: { cwd } as BuildSpawnOpts['cfg'] }), { agent: 'a', project: 'p9' });
  } finally {
    off();
    deleteSecret(key.id);
  }
});
