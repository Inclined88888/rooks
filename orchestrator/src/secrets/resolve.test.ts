/**
 * Scope resolution of the vault (SECRETS-VAULT.md §5.2/§5.3) — the part that
 * silently hands a token to the wrong agent when it is wrong.
 *
 * Two levels are exercised on purpose: the pure function (precedence, absence of
 * grant, broker exclusion), and the same rules through `dbApi`, because the
 * schema carries its own traps — a NULL inside a PRIMARY KEY constrains nothing
 * in SQLite, and a name is only validated at the write.
 */
// Isolates TIMON_HOME BEFORE any module touching Timon state (see test-home.ts).
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidSecretName,
  resolveBrokerSecret,
  resolveSecretsFor,
  secretScopeFor,
  type SecretIdentity,
} from './resolve.js';
import { dbApi } from '../db.js';

const sealed = (label: string) => `enc:1:iv:tag:${label}`;

function secret(over: Partial<SecretIdentity> & Pick<SecretIdentity, 'id' | 'name'>): SecretIdentity {
  return { mode: 'inject', grants: [], updated_at: 0, ...over };
}

test('agent > project > global on a name colliding at all three scopes', () => {
  const secrets: SecretIdentity[] = [
    secret({ id: 'g', name: 'GITHUB_TOKEN', grants: [{ scope_kind: 'global', scope_ref: null }] }),
    secret({ id: 'p', name: 'GITHUB_TOKEN', grants: [{ scope_kind: 'project', scope_ref: 'initech' }] }),
    secret({ id: 'a', name: 'GITHUB_TOKEN', grants: [{ scope_kind: 'agent', scope_ref: 'initech.coder' }] }),
  ];

  const forAgent = resolveSecretsFor({ agent: 'initech.coder', project: 'initech', secrets });
  assert.deepEqual(forAgent, [{ id: 'a', name: 'GITHUB_TOKEN', mode: 'inject', scope: 'agent' }]);

  const forProject = resolveSecretsFor({ agent: 'other.coder', project: 'initech', secrets });
  assert.equal(forProject[0].id, 'p');

  const forStranger = resolveSecretsFor({ agent: 'other.coder', project: 'umbrella', secrets });
  assert.equal(forStranger[0].id, 'g');

  // One name in, one secret out: never two variables of the same name.
  assert.equal(forAgent.length, 1);
  assert.equal(forProject.length, 1);
  assert.equal(forStranger.length, 1);
});

test('a secret without a grant is never resolved, whoever asks', () => {
  const secrets = [secret({ id: 'v', name: 'TIMON_VAPID_PRIVATE_KEY' })];
  for (const target of [
    { agent: 'initech.coder', project: 'initech' },
    { agent: null, project: null },
    { agent: 'anyone', project: 'anything' },
  ]) {
    assert.deepEqual(resolveSecretsFor({ ...target, secrets }), []);
    assert.equal(secretScopeFor(secrets[0], target), null);
  }
});

test('global reaches every agent but no plugin address, for injection and for the broker alike', () => {
  const global = [{ scope_kind: 'global' as const, scope_ref: null }];
  const inject = secret({ id: 'i', name: 'SHARED_TOKEN', grants: global });
  const brokered = secret({ id: 'b', name: 'SHARED_API', mode: 'broker', grants: global });
  const plugin = { agent: 'plugin:acme', project: null };
  assert.equal(secretScopeFor(inject, { agent: 'any.coder', project: null }), 'global');
  assert.equal(secretScopeFor(inject, { agent: null, project: null }), 'global');
  assert.equal(secretScopeFor(inject, plugin), null);
  assert.deepEqual(resolveSecretsFor({ ...plugin, secrets: [inject] }), []);
  assert.equal(resolveBrokerSecret({ ...plugin, name: 'SHARED_API', secrets: [brokered] }), null);
  assert.equal(resolveBrokerSecret({ agent: 'any.coder', project: null, name: 'SHARED_API', secrets: [brokered] })?.scope, 'global');
  // Its own grant still opens it, even next to the global one.
  const named = secret({ id: 'n', name: 'SHARED_TOKEN', grants: [...global, { scope_kind: 'agent', scope_ref: 'plugin:acme' }] });
  assert.equal(secretScopeFor(named, plugin), 'agent');
});

test('grants add up: project:X and agent:Y both open access', () => {
  const secrets = [secret({
    id: 's',
    name: 'OPENAI_KEY',
    grants: [{ scope_kind: 'project', scope_ref: 'X' }, { scope_kind: 'agent', scope_ref: 'Y' }],
  })];

  assert.equal(resolveSecretsFor({ agent: 'nobody', project: 'X', secrets })[0]?.scope, 'project');
  assert.equal(resolveSecretsFor({ agent: 'Y', project: 'other', secrets })[0]?.scope, 'agent');
  // Both satisfied at once: the most specific one is recorded, for the journal (§8).
  assert.equal(resolveSecretsFor({ agent: 'Y', project: 'X', secrets })[0]?.scope, 'agent');
  assert.deepEqual(resolveSecretsFor({ agent: 'nobody', project: 'other', secrets }), []);
});

test('a broker secret is never returned by injection resolution, grant or not', () => {
  const secrets = [
    secret({ id: 'b', name: 'GITHUB_TOKEN', mode: 'broker', grants: [{ scope_kind: 'agent', scope_ref: 'a' }] }),
    secret({ id: 'b2', name: 'STRIPE_KEY', mode: 'broker', grants: [{ scope_kind: 'global', scope_ref: null }] }),
  ];
  assert.deepEqual(resolveSecretsFor({ agent: 'a', project: 'p', secrets }), []);
  // The grant itself remains satisfied — only injection is closed to it, which is
  // what the broker (§6.2) will read to authorise a call.
  assert.equal(secretScopeFor(secrets[0], { agent: 'a', project: 'p' }), 'agent');
});

test('a broker secret does not mask the inject secret of the same name', () => {
  const secrets = [
    secret({ id: 'b', name: 'GITHUB_TOKEN', mode: 'broker', grants: [{ scope_kind: 'agent', scope_ref: 'a' }] }),
    secret({ id: 'i', name: 'GITHUB_TOKEN', grants: [{ scope_kind: 'global', scope_ref: null }] }),
  ];
  assert.deepEqual(resolveSecretsFor({ agent: 'a', project: 'p', secrets }).map((s) => s.id), ['i']);
});

test('a name outside ^[A-Z][A-Z0-9_]*$ is refused at the write', () => {
  for (const bad of ['github_token', '1TOKEN', 'GITHUB-TOKEN', '', 'GITHUB TOKEN', '_TOKEN', 'Token']) {
    assert.equal(isValidSecretName(bad), false, bad);
    assert.throws(
      () => dbApi.createSecret({ name: bad, value_enc: sealed('x'), mode: 'inject' }),
      /invalid secret name/,
      bad,
    );
  }
  for (const ok of ['GITHUB_TOKEN', 'A', 'A1', 'TIMON_VAPID_PRIVATE_KEY']) {
    assert.equal(isValidSecretName(ok), true, ok);
  }
  const created = dbApi.createSecret({ name: 'GOOD_NAME', value_enc: sealed('x'), mode: 'inject' });
  assert.throws(() => dbApi.updateSecret(created.id, { name: 'bad name' }), /invalid secret name/);
  dbApi.deleteSecret(created.id);
});

test('db: same name at three scopes, resolution picks the agent one', () => {
  const at = Date.now();
  const rows = [
    { id: 'db-g', scope: 'global' as const, ref: null },
    { id: 'db-p', scope: 'project' as const, ref: 'initech' },
    { id: 'db-a', scope: 'agent' as const, ref: 'initech.coder' },
  ];
  for (const r of rows) {
    dbApi.createSecret({ id: r.id, name: 'DB_TOKEN', value_enc: sealed(r.id), mode: 'inject', at });
    dbApi.addSecretGrant(r.id, r.scope, r.ref);
  }
  // The name is NOT unique: three rows carry it (§5.1).
  assert.equal(dbApi.getSecretsByName('DB_TOKEN').length, 3);

  const resolved = resolveSecretsFor({
    agent: 'initech.coder',
    project: 'initech',
    secrets: dbApi.listSecrets(),
  });
  assert.deepEqual(resolved.filter((s) => s.name === 'DB_TOKEN').map((s) => s.id), ['db-a']);

  for (const r of rows) dbApi.deleteSecret(r.id);
  assert.equal(dbApi.getSecretsByName('DB_TOKEN').length, 0);
});

test('db: a grant is idempotent, including global (NULL scope_ref)', () => {
  const s = dbApi.createSecret({ name: 'IDEM_TOKEN', value_enc: sealed('i'), mode: 'inject' });
  dbApi.addSecretGrant(s.id, 'global');
  dbApi.addSecretGrant(s.id, 'global');
  dbApi.addSecretGrant(s.id, 'agent', 'a');
  dbApi.addSecretGrant(s.id, 'agent', 'a');
  assert.equal(dbApi.listSecretGrants(s.id).length, 2);

  assert.equal(dbApi.removeSecretGrant(s.id, 'global'), true);
  assert.equal(dbApi.removeSecretGrant(s.id, 'global'), false);
  assert.equal(dbApi.removeSecretGrant(s.id, 'agent', 'a'), true);
  assert.deepEqual(dbApi.listSecretGrants(s.id), []);
  dbApi.deleteSecret(s.id);
});

test('db: a project/agent grant without a reference is refused', () => {
  const s = dbApi.createSecret({ name: 'REF_TOKEN', value_enc: sealed('r'), mode: 'inject' });
  assert.throws(() => dbApi.addSecretGrant(s.id, 'project'), /requires a reference/);
  assert.throws(() => dbApi.addSecretGrant(s.id, 'agent', '  '), /requires a reference/);
  assert.deepEqual(dbApi.listSecretGrants(s.id), []);
  dbApi.deleteSecret(s.id);
});

test('db: deleting a secret takes its grants with it', () => {
  const s = dbApi.createSecret({ name: 'GONE_TOKEN', value_enc: sealed('g'), mode: 'inject' });
  dbApi.addSecretGrant(s.id, 'project', 'initech');
  assert.equal(dbApi.deleteSecret(s.id), true);
  assert.equal(dbApi.getSecret(s.id), undefined);
  assert.deepEqual(dbApi.listSecretGrants(s.id), []);
  assert.equal(dbApi.deleteSecret(s.id), false);
});

test('db: an update moves updated_at and never leaks the previous envelope', () => {
  const s = dbApi.createSecret({ name: 'ROT_TOKEN', value_enc: sealed('v1'), mode: 'inject', at: 1000 });
  const updated = dbApi.updateSecret(s.id, { value_enc: sealed('v2'), note: 'rotated' }, 2000)!;
  assert.equal(updated.value_enc, sealed('v2'));
  assert.equal(updated.note, 'rotated');
  assert.equal(updated.created_at, 1000);
  assert.equal(updated.updated_at, 2000);
  assert.equal(dbApi.updateSecret('nope', { note: 'x' }), undefined);
  dbApi.deleteSecret(s.id);
});

// ── TODO #531, decision 5-B: a key reserved to a backend ──────────────────

const reservedTo = (backend: string, ...audience: { scope_kind: 'global' | 'project' | 'agent'; scope_ref: string | null }[]) =>
  [{ scope_kind: 'backend' as const, scope_ref: backend }, ...audience];

test('5-B: a reserved key never enters the vault slice, a plugin or the broker', () => {
  const key = secret({ id: 'k', name: 'BACKEND_ACME_API_KEY', grants: reservedTo('acme') });
  // The vault slice of every trusted mission carries no backend.
  assert.deepEqual(resolveSecretsFor({ agent: 'acme.coder', project: 'acme', secrets: [key] }), []);
  // A plugin is addressed as `plugin:<id>`, without a backend either.
  assert.deepEqual(resolveSecretsFor({ agent: 'plugin:acme-provider', project: null, secrets: [key] }), []);
  // The broker never sees a backend target.
  const broker = secret({ id: 'kb', name: 'BACKEND_ACME_API_KEY', mode: 'broker', grants: reservedTo('acme') });
  assert.equal(resolveBrokerSecret({ agent: 'acme.coder', project: 'acme', name: 'BACKEND_ACME_API_KEY', secrets: [broker] }), null);
});

test('5-B: present only for the backend it is reserved to', () => {
  const key = secret({ id: 'k', name: 'BACKEND_ACME_API_KEY', grants: reservedTo('acme') });
  assert.deepEqual(
    resolveSecretsFor({ agent: 'a', project: 'p', backend: 'acme', secrets: [key] }),
    [{ id: 'k', name: 'BACKEND_ACME_API_KEY', mode: 'inject', scope: 'backend' }],
  );
  assert.deepEqual(resolveSecretsFor({ agent: 'a', project: 'p', backend: 'other', secrets: [key] }), []);
});

test('5-B: backend and project are an intersection, never an OR', () => {
  const key = secret({ id: 'k', name: 'BACKEND_ACME_API_KEY', grants: reservedTo('acme', { scope_kind: 'project', scope_ref: 'p1' }) });
  // Right backend, right project.
  assert.equal(secretScopeFor(key, { agent: 'a', project: 'p1', backend: 'acme' }), 'project');
  // Right project, other backend: the project grant does not open it.
  assert.equal(secretScopeFor(key, { agent: 'a', project: 'p1', backend: 'other' }), null);
  assert.equal(secretScopeFor(key, { agent: 'a', project: 'p1' }), null);
  // Right backend, other project: the reservation does not open it either.
  assert.equal(secretScopeFor(key, { agent: 'a', project: 'p2', backend: 'acme' }), null);
  // Same with an agent audience.
  const agentKey = secret({ id: 'ka', name: 'BACKEND_ACME_API_KEY', grants: reservedTo('acme', { scope_kind: 'agent', scope_ref: 'acme.coder' }) });
  assert.equal(secretScopeFor(agentKey, { agent: 'acme.reviewer', project: 'p1', backend: 'acme' }), null);
  assert.equal(secretScopeFor(agentKey, { agent: 'acme.coder', project: 'p1', backend: 'acme' }), 'agent');
});

test('5-B: a reserved key with a global audience still stays on its backend', () => {
  const key = secret({ id: 'k', name: 'BACKEND_ACME_API_KEY', grants: reservedTo('acme', { scope_kind: 'global', scope_ref: null }) });
  assert.equal(secretScopeFor(key, { agent: 'a', project: 'p' }), null);
  assert.equal(secretScopeFor(key, { agent: 'a', project: 'p', backend: 'acme' }), 'backend');
});

test('5-B: name collision — the reserved key wins on its backend, the manual one everywhere else', () => {
  const manual = secret({ id: 'm', name: 'BACKEND_ACME_API_KEY', grants: [{ scope_kind: 'global', scope_ref: null }], updated_at: 50 });
  const reserved = secret({ id: 'r', name: 'BACKEND_ACME_API_KEY', grants: reservedTo('acme'), updated_at: 10 });
  assert.equal(resolveSecretsFor({ agent: 'a', project: 'p', backend: 'acme', secrets: [manual, reserved] })[0].id, 'r');
  assert.equal(resolveSecretsFor({ agent: 'a', project: 'p', backend: 'other', secrets: [manual, reserved] })[0].id, 'm');
  assert.equal(resolveSecretsFor({ agent: 'a', project: 'p', secrets: [manual, reserved] })[0].id, 'm');
  // Same audience on both: the reservation is the more specific, whatever the dates.
  const manualP = secret({ id: 'mp', name: 'X_KEY', grants: [{ scope_kind: 'project', scope_ref: 'p' }], updated_at: 99 });
  const reservedP = secret({ id: 'rp', name: 'X_KEY', grants: reservedTo('acme', { scope_kind: 'project', scope_ref: 'p' }), updated_at: 1 });
  assert.equal(resolveSecretsFor({ agent: 'a', project: 'p', backend: 'acme', secrets: [manualP, reservedP] })[0].id, 'rp');
});

test('5-B: secretReachesBackend answers the target-less visibility question', async () => {
  const { secretReachesBackend } = await import('./resolve.js');
  assert.equal(secretReachesBackend({ grants: reservedTo('acme') }, 'acme'), true);
  assert.equal(secretReachesBackend({ grants: reservedTo('acme') }, 'other'), false);
  assert.equal(secretReachesBackend({ grants: [{ scope_kind: 'global', scope_ref: null }] }, 'other'), true);
  assert.equal(secretReachesBackend({ grants: [] }, 'acme'), false);
});
