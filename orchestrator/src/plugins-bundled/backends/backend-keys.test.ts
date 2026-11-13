/**
 * TODO #531, decision 5-B — the keys of "Add a provider" backends move from
 * `global` to their reservation, and only when the backend's ownership is
 * certain. What must never happen: a key shared by hand narrowed behind the
 * operator's back, a manual secret of the same name touched, a second boot
 * changing anything.
 */
// Isolates ROOKS_HOME BEFORE any module touching Rooks state (see test-home.ts).
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbApi } from '../../db.js';
import { createSecret, deleteSecret } from '../../secrets/store.js';
import type { LocalBackend } from '../../backends/local-profiles.js';
import type { BackendProfile } from '../../backends/types.js';
import { classifyBackendKey, migrateBackendKeys, ownerNote, resetBackendKeyCards, secretNameFor } from './backend-keys.js';

/** A loaded "Add a provider" backend whose file references its own key. */
function backend(id: string, refName = secretNameFor(id)): LocalBackend {
  const profile = {
    id, dialect: 'probe', label: id, models: [], defaultModel: null,
    env: { [refName]: { secret: refName } },
  } as unknown as BackendProfile;
  return { id, file: `${id}.json`, profile, issue: null, warnings: [] };
}

const grantsOf = (id: string) => dbApi.getSecret(id)!.grants;

/** The cards are fire-and-forget (lazy import): wait for them, bounded. */
async function cardsFor(anchorPrefix: string, expected: number) {
  for (let i = 0; i < 100; i++) {
    const rows = dbApi.listNotifications({ limit: 500 }).filter((n) => n.anchor?.startsWith(anchorPrefix));
    if (rows.length >= expected) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return dbApi.listNotifications({ limit: 500 }).filter((n) => n.anchor?.startsWith(anchorPrefix));
}

test('classify: only the exact shape the form wrote is migrated', () => {
  const g = (scope_kind: 'global' | 'project' | 'agent' | 'backend', scope_ref: string | null = null) => ({ scope_kind, scope_ref });
  assert.equal(classifyBackendKey({ grants: [g('global')] }, 'acme'), 'migrate');
  assert.equal(classifyBackendKey({ grants: [g('backend', 'acme')] }, 'acme'), 'reserved');
  assert.equal(classifyBackendKey({ grants: [g('backend', 'acme'), g('project', 'p')] }, 'acme'), 'reserved');
  assert.equal(classifyBackendKey({ grants: [] }, 'acme'), 'daemon-only');
  assert.equal(classifyBackendKey({ grants: [g('global'), g('project', 'p')] }, 'acme'), 'ambiguous');
  assert.equal(classifyBackendKey({ grants: [g('project', 'p')] }, 'acme'), 'ambiguous');
  assert.equal(classifyBackendKey({ grants: [g('backend', 'other')] }, 'acme'), 'ambiguous');
});

test('a global key the form stored is reserved, and a second run changes nothing', () => {
  const key = createSecret({ name: secretNameFor('mig-a'), value: 'v-a', note: ownerNote('mig-a'), grants: ['global'] });
  try {
    const first = migrateBackendKeys([backend('mig-a')]);
    assert.deepEqual(first, { migrated: [key.id], ambiguous: [] });
    assert.deepEqual(grantsOf(key.id), [{ scope_kind: 'backend', scope_ref: 'mig-a' }]);
    const updatedAt = dbApi.getSecret(key.id)!.updated_at;

    const second = migrateBackendKeys([backend('mig-a')]);
    assert.deepEqual(second, { migrated: [], ambiguous: [] }, 'idempotent');
    assert.deepEqual(grantsOf(key.id), [{ scope_kind: 'backend', scope_ref: 'mig-a' }]);
    assert.equal(dbApi.getSecret(key.id)!.updated_at, updatedAt, 'a second boot writes nothing');
  } finally {
    deleteSecret(key.id);
  }
});

test('a manual secret of the same name, shared with everyone, is preserved', () => {
  // Same name, global, but filed by the user: no owner mark.
  const manual = createSecret({ name: secretNameFor('mig-b'), value: 'v-manual', note: 'mine', grants: ['global'] });
  const owned = createSecret({ name: secretNameFor('mig-b'), value: 'v-owned', note: ownerNote('mig-b'), grants: ['project:acme'] });
  try {
    resetBackendKeyCards();
    const report = migrateBackendKeys([backend('mig-b')]);
    assert.deepEqual(report.migrated, []);
    assert.deepEqual(grantsOf(manual.id), [{ scope_kind: 'global', scope_ref: null }], 'the manual entry is untouched');
    assert.equal(dbApi.getSecret(manual.id)!.note, 'mine');
    // The owned one is shared by hand with a project: asked, not changed.
    assert.deepEqual(report.ambiguous, [owned.id]);
    assert.deepEqual(grantsOf(owned.id), [{ scope_kind: 'project', scope_ref: 'acme' }]);
  } finally {
    deleteSecret(manual.id);
    deleteSecret(owned.id);
  }
});

test('ownership must be verified three ways: name, owner mark, and the file referencing it', () => {
  // The owner mark and the name, but the backend's file names another entry.
  const unreferenced = createSecret({ name: secretNameFor('mig-c'), value: 'v-c', note: ownerNote('mig-c'), grants: ['global'] });
  // The owner mark of ANOTHER backend under this name.
  const foreignMark = createSecret({ name: secretNameFor('mig-d'), value: 'v-d', note: ownerNote('someone-else'), grants: ['global'] });
  try {
    const report = migrateBackendKeys([backend('mig-c', 'HAND_WRITTEN_KEY'), backend('mig-d')]);
    assert.deepEqual(report, { migrated: [], ambiguous: [] });
    assert.deepEqual(grantsOf(unreferenced.id), [{ scope_kind: 'global', scope_ref: null }]);
    assert.deepEqual(grantsOf(foreignMark.id), [{ scope_kind: 'global', scope_ref: null }]);
    // A backend whose file did not load owns nothing.
    assert.deepEqual(migrateBackendKeys([{ ...backend('mig-c'), profile: null, issue: 'broken' }]), { migrated: [], ambiguous: [] });
    assert.deepEqual(grantsOf(unreferenced.id), [{ scope_kind: 'global', scope_ref: null }]);
  } finally {
    deleteSecret(unreferenced.id);
    deleteSecret(foreignMark.id);
  }
});

test('an ambiguous key raises one card per boot, naming scopes and never the value', async () => {
  const key = createSecret({ name: secretNameFor('mig-e'), value: 'v-secret-e', note: ownerNote('mig-e'), grants: ['global', 'agent:acme.coder'] });
  try {
    resetBackendKeyCards();
    migrateBackendKeys([backend('mig-e')]);
    migrateBackendKeys([backend('mig-e')]);
    const cards = (await cardsFor('backend-key:mig-e:', 1)).filter((n) => !n.dismissed_at);
    assert.equal(cards.length, 1, 'one card, however often the migration runs in a process');
    assert.equal(cards[0]!.type, 'action_required');
    assert.match(cards[0]!.body ?? '', /rooks secret grant BACKEND_MIG_E_API_KEY --scope backend:mig-e/);
    assert.match(cards[0]!.body ?? '', /global, agent:acme\.coder/);
    assert.ok(!(cards[0]!.body ?? '').includes('v-secret-e'));
    assert.deepEqual(grantsOf(key.id), [
      { scope_kind: 'agent', scope_ref: 'acme.coder' },
      { scope_kind: 'global', scope_ref: null },
    ], 'nothing narrowed without the operator');

    // Next boot: the question is asked again, in place of the previous card.
    resetBackendKeyCards();
    migrateBackendKeys([backend('mig-e')]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const open = (await cardsFor('backend-key:mig-e:', 1)).filter((n) => !n.dismissed_at);
    assert.equal(open.length, 1, 'replaced, not stacked');
  } finally {
    deleteSecret(key.id);
  }
});

test('a key no grant reached is left alone and asks nothing', async () => {
  const key = createSecret({ name: secretNameFor('mig-f'), value: 'v-f', note: ownerNote('mig-f') });
  try {
    resetBackendKeyCards();
    assert.deepEqual(migrateBackendKeys([backend('mig-f')]), { migrated: [], ambiguous: [] });
    assert.deepEqual(grantsOf(key.id), []);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(dbApi.listNotifications({ limit: 500 }).filter((n) => n.anchor?.startsWith('backend-key:mig-f:')).length, 0);
  } finally {
    deleteSecret(key.id);
  }
});

test('a name clash at the reservation is asked, not forced', async () => {
  // Someone already reserved an entry of that name to the backend by hand.
  const handReserved = createSecret({ name: secretNameFor('mig-g'), value: 'v-hand', note: 'mine', grants: ['backend:mig-g'] });
  const legacy = createSecret({ name: secretNameFor('mig-g'), value: 'v-legacy', note: ownerNote('mig-g'), grants: ['global'] });
  try {
    resetBackendKeyCards();
    const report = migrateBackendKeys([backend('mig-g')]);
    assert.deepEqual(report, { migrated: [], ambiguous: [legacy.id] });
    assert.deepEqual(grantsOf(legacy.id), [{ scope_kind: 'global', scope_ref: null }]);
    assert.deepEqual(grantsOf(handReserved.id), [{ scope_kind: 'backend', scope_ref: 'mig-g' }]);
    assert.equal((await cardsFor('backend-key:mig-g:', 1)).length, 1);
  } finally {
    deleteSecret(handReserved.id);
    deleteSecret(legacy.id);
  }
});
