/**
 * What a plugin may read from the vault (SECRETS-VAULT.md §9.4).
 *
 * The failure these tests exist for is silent in both directions: a plugin that
 * reads a secret nobody granted it, and a grant written for one plugin that
 * answers for another.
 */
// Isolates TIMON_HOME BEFORE any module touching Timon state (see test-home.ts).
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbApi } from '../db.js';
import { isSealed } from './box.js';
import { createSecret, grantSecret, rekeyVault, revokeSecret } from './store.js';
import { closePluginSecretCards, openPluginKvValue, pluginSecretTarget, readPluginSecret, resetPluginSecretCards, revokePluginSecretGrants, sealPluginKvValue } from './plugins.js';
import { createNotification, resolveAnchorPrefix } from '../notifications.js';
import { resolveSecretsFor } from './resolve.js';

test('a plugin is addressed as an agent that no mission can be', () => {
  assert.deepEqual(pluginSecretTarget('acme-plugin'), { agent: 'plugin:acme-plugin', project: null });
});

test('a plugin only reads what its own scope grants', () => {
  createSecret({ name: 'MINE_TOKEN', value: 'v-mine', grants: ['agent:plugin:acme-plugin'] });
  createSecret({ name: 'THEIRS_TOKEN', value: 'v-theirs', grants: ['agent:plugin:other-plugin'] });
  createSecret({ name: 'DAEMON_TOKEN', value: 'v-daemon' });
  createSecret({ name: 'PROJECT_TOKEN', value: 'v-project', grants: ['project:initech'] });
  createSecret({ name: 'EVERYONE_TOKEN', value: 'v-everyone', grants: ['global'] });

  assert.equal(readPluginSecret('acme-plugin', 'MINE_TOKEN'), 'v-mine');
  // Another plugin's grant, an ungranted secret, a project grant and a
  // `global` one are all invisible: a plugin carries no project, and `global`
  // means "every agent", not "every plugin" (TODO #531, 1-B).
  assert.equal(readPluginSecret('acme-plugin', 'EVERYONE_TOKEN'), undefined);
  assert.equal(readPluginSecret('acme-plugin', 'THEIRS_TOKEN'), undefined);
  assert.equal(readPluginSecret('acme-plugin', 'DAEMON_TOKEN'), undefined);
  assert.equal(readPluginSecret('acme-plugin', 'PROJECT_TOKEN'), undefined);
  assert.equal(readPluginSecret('other-plugin', 'MINE_TOKEN'), undefined);
});

test('a global grant alone gives a plugin nothing, while agents keep receiving it', () => {
  createSecret({ name: 'GLOBAL_ONLY_TOKEN', value: 'v-global', grants: ['global'] });
  assert.equal(readPluginSecret('acme-plugin', 'GLOBAL_ONLY_TOKEN'), undefined);
  // The same row still reaches a mission: only the plugin address lost it.
  const forAgent = resolveSecretsFor({ agent: 'coder', project: 'demo', secrets: dbApi.listSecrets() });
  assert.ok(forAgent.some((s) => s.name === 'GLOBAL_ONLY_TOKEN' && s.scope === 'global'));
  // A grant that names the plugin is what opens it — and only for that plugin.
  const row = dbApi.getSecretsByName('GLOBAL_ONLY_TOKEN')[0]!;
  grantSecret(row.id, 'agent:plugin:acme-plugin');
  assert.equal(readPluginSecret('acme-plugin', 'GLOBAL_ONLY_TOKEN'), 'v-global');
  assert.equal(readPluginSecret('other-plugin', 'GLOBAL_ONLY_TOKEN'), undefined);
});

test('a revoked grant answers like no grant', () => {
  const secret = createSecret({ name: 'REVOKED_TOKEN', value: 'v-revoked', grants: ['agent:plugin:acme-plugin'] });
  assert.equal(readPluginSecret('acme-plugin', 'REVOKED_TOKEN'), 'v-revoked');
  revokeSecret(secret.id, 'agent:plugin:acme-plugin');
  assert.equal(readPluginSecret('acme-plugin', 'REVOKED_TOKEN'), undefined);
});

/**
 * TODO #659: a grant names the id, not the package. Withdrawing it on removal
 * takes only that address off every row — the rows, the other scopes on them
 * and every other plugin's grants stay.
 */
test('revoking a plugin withdraws its grants on every row and nothing else', () => {
  const both = createSecret({ name: 'UNINSTALL_SHARED', value: 'v-shared', grants: ['agent:plugin:gone-plugin', 'agent:plugin:kept-plugin', 'project:demo'] });
  const twin = createSecret({ name: 'UNINSTALL_TWIN', value: 'v-twin-a', grants: ['agent:plugin:gone-plugin'] });
  // Same name, another scope (§5.1): not the plugin's row, left exactly as it was.
  createSecret({ name: 'UNINSTALL_TWIN', value: 'v-twin-b', grants: ['agent:coder'] });
  createSecret({ name: 'UNINSTALL_PREFIX', value: 'v-prefix', grants: ['agent:plugin:gone-plugin-2'] });
  assert.equal(readPluginSecret('gone-plugin', 'UNINSTALL_SHARED'), 'v-shared');

  assert.deepEqual(revokePluginSecretGrants('gone-plugin'), ['UNINSTALL_SHARED', 'UNINSTALL_TWIN']);
  for (const name of ['UNINSTALL_SHARED', 'UNINSTALL_TWIN']) assert.equal(readPluginSecret('gone-plugin', name), undefined);
  assert.equal(readPluginSecret('kept-plugin', 'UNINSTALL_SHARED'), 'v-shared', 'another plugin keeps its grant');
  assert.equal(readPluginSecret('gone-plugin-2', 'UNINSTALL_PREFIX'), 'v-prefix', 'an id sharing the prefix is someone else');
  assert.deepEqual(dbApi.getSecret(both.id)!.grants, [{ scope_kind: 'agent', scope_ref: 'plugin:kept-plugin' }, { scope_kind: 'project', scope_ref: 'demo' }]);
  assert.ok(dbApi.getSecret(twin.id), 'the row itself stays');
  assert.deepEqual(dbApi.getSecretsByName('UNINSTALL_TWIN').map((r) => r.grants).sort((a, b) => a.length - b.length), [[], [{ scope_kind: 'agent', scope_ref: 'coder' }]]);
  assert.deepEqual(revokePluginSecretGrants('gone-plugin'), [], 'idempotent');
});

/** The cards are fire-and-forget (lazy import): wait for them, bounded. */
async function settled<T>(read: () => T, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return read();
}

const CARD = 'plugin-secret:consent-plugin:CONSENT_TOKEN';

test('an install that relied on a global grant gets one consent card per name, closed once granted', async () => {
  resetPluginSecretCards();
  createSecret({ name: 'CONSENT_TOKEN', value: 'v-consent', grants: ['global'] });
  createSecret({ name: 'UNSHARED_TOKEN', value: 'v-unshared' });
  readPluginSecret('consent-plugin', 'CONSENT_TOKEN');
  readPluginSecret('consent-plugin', 'CONSENT_TOKEN');
  readPluginSecret('consent-plugin', 'UNSHARED_TOKEN');
  readPluginSecret('consent-plugin', 'NEVER_STORED_TOKEN');
  const cards = await settled(() => dbApi.listNotifications({ limit: 200 }), (rows) => rows.some((n) => n.anchor === CARD));
  const mine = cards.filter((n) => n.anchor === CARD);
  assert.equal(mine.length, 1, 'one card, however often the plugin asks');
  assert.equal(mine[0]!.type, 'action_required');
  assert.match(mine[0]!.body ?? '', /timon secret grant CONSENT_TOKEN --scope agent:plugin:consent-plugin/);
  assert.ok(!(mine[0]!.body ?? '').includes('v-consent'), 'the card never carries the value');
  // A name nobody shared with every agent is not a lost consent: no card.
  assert.equal(cards.filter((n) => n.anchor?.startsWith('plugin-secret:consent-plugin:') && n.anchor !== CARD).length, 0);
  // Nothing was granted on the plugin's behalf.
  assert.deepEqual(dbApi.getSecretsByName('CONSENT_TOKEN')[0]!.grants.map((g) => g.scope_kind), ['global']);

  grantSecret(dbApi.getSecretsByName('CONSENT_TOKEN')[0]!.id, 'agent:plugin:consent-plugin');
  assert.equal(readPluginSecret('consent-plugin', 'CONSENT_TOKEN'), 'v-consent');
  const open = await settled(() => dbApi.listNotifications({ limit: 200 }), (rows) => !rows.some((n) => n.anchor === CARD));
  assert.ok(!open.some((n) => n.anchor === CARD), 'the answered card leaves the open list');
});

/**
 * TODO #661: a removed plugin's consent cards close with it. Their Grant button
 * names the id, and the next package published under that id would read what
 * was granted from them. Only its own cards: another plugin's (an id sharing
 * the prefix included) stay open.
 */
test('closing a plugin\'s cards closes every consent card it raised and no one else\'s', async () => {
  resetPluginSecretCards();
  createSecret({ name: 'GONE_CARD_A', value: 'v-a', grants: ['global'] });
  createSecret({ name: 'GONE_CARD_B', value: 'v-b', grants: ['global'] });
  for (const plugin of ['gone-cards', 'gone-cards-2', 'kept-cards']) {
    for (const name of ['GONE_CARD_A', 'GONE_CARD_B']) readPluginSecret(plugin, name);
  }
  const open = () => dbApi.listActiveNotifications('action_required').map((n) => n.anchor ?? '').filter((a) => a.startsWith('plugin-secret:')).sort();
  const all = [
    'plugin-secret:gone-cards-2:GONE_CARD_A', 'plugin-secret:gone-cards-2:GONE_CARD_B',
    'plugin-secret:gone-cards:GONE_CARD_A', 'plugin-secret:gone-cards:GONE_CARD_B',
    'plugin-secret:kept-cards:GONE_CARD_A', 'plugin-secret:kept-cards:GONE_CARD_B',
  ];
  await settled(open, (anchors) => all.every((a) => anchors.includes(a)));

  assert.equal(await closePluginSecretCards('gone-cards'), 2);
  const left = open();
  assert.ok(!left.some((a) => a.startsWith('plugin-secret:gone-cards:')), 'no card left to grant the removed id from');
  for (const a of all.filter((x) => !x.startsWith('plugin-secret:gone-cards:'))) assert.ok(left.includes(a), `${a} stays open`);
  assert.equal(await closePluginSecretCards('gone-cards'), 0, 'idempotent');
  // Nothing was granted by closing them.
  assert.deepEqual(dbApi.getSecretsByName('GONE_CARD_A')[0]!.grants.map((g) => `${g.scope_kind}:${g.scope_ref ?? ''}`), ['global:']);

  // A reinstall is a new consent: it reads nothing, and its first refusal raises a card again.
  assert.equal(readPluginSecret('gone-cards', 'GONE_CARD_B'), undefined);
  await settled(open, (anchors) => anchors.includes('plugin-secret:gone-cards:GONE_CARD_B'));
  assert.ok(open().includes('plugin-secret:gone-cards:GONE_CARD_B'));
});

test('an anchor prefix is compared literally, never as a LIKE pattern', () => {
  createNotification({ type: 'action_required', title: 'x', anchor: 'literal-prefix:axb:NAME' });
  createNotification({ type: 'action_required', title: 'y', anchor: 'literal-prefix:a_b:NAME' });
  createNotification({ type: 'report', title: 'z', anchor: 'literal-prefix:a_b:OTHER' });
  assert.equal(resolveAnchorPrefix('literal-prefix:a_b:'), 1, 'only the action_required card of that exact prefix');
  assert.equal(resolveAnchorPrefix('literal-prefix:a%'), 0);
  const anchors = dbApi.listActiveNotifications().map((n) => n.anchor);
  assert.ok(anchors.includes('literal-prefix:axb:NAME'));
  assert.ok(anchors.includes('literal-prefix:a_b:OTHER'));
  assert.ok(!anchors.includes('literal-prefix:a_b:NAME'));
});

test('a broker secret is never returned by name either', () => {
  createSecret({
    name: 'BROKERED_TOKEN',
    value: 'v-brokered',
    mode: 'broker',
    broker_spec: { type: 'http', hosts: ['api.example.com'], inject: { kind: 'header', name: 'X', template: '{{value}}' } },
    grants: ['agent:plugin:acme-plugin'],
  });
  assert.equal(readPluginSecret('acme-plugin', 'BROKERED_TOKEN'), undefined);
});

test('an agent grant of the same name does not answer for the plugin', () => {
  createSecret({ name: 'AGENT_ONLY_TOKEN', value: 'v-agent', grants: ['agent:acme-plugin'] });
  assert.equal(readPluginSecret('acme-plugin', 'AGENT_ONLY_TOKEN'), undefined);
});

test('a plaintext plugin_kv secret is resealed on first read and still opens', () => {
  const pluginId = 'acme-plugin';
  const kvKey = '@settings/apiToken';
  const json = JSON.stringify('plain-token-value');
  dbApi.pluginKvSet(pluginId, kvKey, json);
  assert.equal(isSealed(dbApi.pluginKvGet(pluginId, kvKey)!), false);

  const first = openPluginKvValue(pluginId, kvKey, dbApi.pluginKvGet(pluginId, kvKey)!, (sealed) => {
    dbApi.pluginKvSet(pluginId, kvKey, sealed);
  });
  assert.equal(JSON.parse(first), 'plain-token-value');
  const stored = dbApi.pluginKvGet(pluginId, kvKey)!;
  assert.equal(isSealed(stored), true);
  assert.notEqual(stored, json);
  assert.ok(!stored.includes('plain-token-value'));
  assert.equal(dbApi.pluginKvHasSealed('enc:1:', '@settings/'), true);

  const second = openPluginKvValue(pluginId, kvKey, stored);
  assert.equal(JSON.parse(second), 'plain-token-value');
  assert.equal(dbApi.pluginKvGet(pluginId, kvKey), stored, 'a sealed value is not rewritten on a later read');
});

test('rekey reseals plugin_kv secret settings too', () => {
  const pluginId = 'acme-plugin';
  const kvKey = '@settings/apiToken';
  dbApi.pluginKvSet(pluginId, kvKey, sealPluginKvValue(pluginId, kvKey, JSON.stringify('keep-me-across-rekey')));
  const before = dbApi.pluginKvGet(pluginId, kvKey)!;
  assert.equal(isSealed(before), true);

  rekeyVault();
  const after = dbApi.pluginKvGet(pluginId, kvKey)!;
  assert.equal(isSealed(after), true);
  assert.notEqual(after, before);
  assert.equal(JSON.parse(openPluginKvValue(pluginId, kvKey, after)), 'keep-me-across-rekey');
});
