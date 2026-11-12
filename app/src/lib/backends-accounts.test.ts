/**
 * Subscription account instances in the selectors (TODO #52, volet 2).
 *
 * The daemon lists an account as a backend of its own (`claude@<id>`), already
 * filtered by the caller's access list. What the UI owes it: a name that
 * tells two Anthropic entries apart, an account to sign in again shown but
 * never offered, and a stored value the catalogue no longer lists kept as is —
 * never replaced on screen by another backend.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountStateHint,
  accountUnavailable,
  backendLabel,
  backendShortName,
  isAccountInstance,
  isPickable,
  vendorLabel,
  type BackendCatalog,
  type CatalogBackend,
} from './backends';

const models = [{ slug: 'opus', label: 'Opus' }];

const claude: CatalogBackend = { id: 'claude', label: 'Claude', vendor: 'Anthropic', defaultModel: 'opus', models };
const perso: CatalogBackend = {
  ...claude,
  id: 'claude@a1',
  label: 'Claude · Perso',
  instanceOf: 'claude',
  account: { id: 'a1', name: 'Perso', state: 'active' },
};
const pro: CatalogBackend = {
  ...claude,
  id: 'claude@b2',
  label: 'Claude · Pro',
  instanceOf: 'claude',
  account: { id: 'b2', name: 'Pro', state: 'reauth' },
};
const team: CatalogBackend = {
  ...claude,
  id: 'claude@c3',
  label: 'Claude · Team',
  instanceOf: 'claude',
  account: { id: 'c3', name: 'Team', state: 'cooldown' },
};

const catalog: BackendCatalog = { defaultBackend: 'claude', backends: [claude, perso, pro, team] };

test('an instance id is recognised by its @, a plain backend is not', () => {
  assert.equal(isAccountInstance('claude@a1'), true);
  assert.equal(isAccountInstance('claude'), false);
  assert.equal(isAccountInstance(''), false);
  assert.equal(isAccountInstance(null), false);
});

test('the vendor column names the account, so two Anthropic entries differ', () => {
  assert.equal(vendorLabel(claude), 'Anthropic');
  assert.equal(vendorLabel(perso), 'Anthropic · Perso');
});

test('an account to sign in again or out of quota is not pickable', () => {
  assert.equal(accountUnavailable(perso), null);
  assert.equal(isPickable(perso), true);
  assert.equal(accountUnavailable(pro), 'reauth');
  assert.equal(isPickable(pro), false);
  assert.equal(accountUnavailable(team), 'cooldown');
  assert.equal(isPickable(team), false);
  // A plain backend has no account state: always offered, as before.
  assert.equal(isPickable(claude), true);
  assert.equal(accountStateHint(claude), null);
  assert.match(accountStateHint(pro) ?? '', /sign in again/);
});

test('a missing instance never reads as a raw id nor as another account', () => {
  assert.equal(backendLabel(catalog, 'claude@a1'), 'Claude · Perso');
  assert.equal(backendLabel(catalog, 'claude@gone'), 'Claude · account unavailable');
  assert.equal(backendLabel(catalog, 'codex@x'), 'codex · account unavailable');
  assert.equal(backendLabel(catalog, 'grok'), 'grok');
  // While the catalogue loads, nothing is unavailable yet.
  const loading: BackendCatalog = { defaultBackend: '', backends: [] };
  assert.equal(backendLabel(loading, 'claude@a1'), 'claude');
  assert.equal(backendLabel(loading, 'claude'), 'claude');
});

test('a chip names an account by its nickname, anything else by its id (TODO #454)', () => {
  assert.equal(backendShortName(catalog, 'claude@a1'), 'Perso');
  assert.equal(backendShortName(catalog, 'claude'), 'claude');
  assert.equal(backendShortName(catalog, 'claude@gone'), 'claude@gone');
  assert.equal(backendShortName({ defaultBackend: '', backends: [] }, 'claude@a1'), 'claude@a1');
});
