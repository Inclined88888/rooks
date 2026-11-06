/**
 * Who this browser acts as on the active machine, and the owner the layout
 * scopes are hashed with (TODO #646).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseActingAccount, parseActingUser, previousLayoutOwner, previousLayoutOwnerOf, schemeOfMe, workspaceOwnerOf } from './acting-account';

test('local machine: the layout owner is the local session\'s account', () => {
  assert.equal(workspaceOwnerOf({ user: { id: 'u-local' } }), 'u-local');
  assert.equal(workspaceOwnerOf({ user: { id: 'u-local' }, acting: null }), 'u-local');
});

test('remote machine: the layout owner is the account acting there, never the local one', () => {
  const body = { user: { id: 'u-local' }, acting: { machine: 'vps', user: { id: 'u-remote', email: 'a@vps', name: 'A' }, can: null } };
  assert.equal(workspaceOwnerOf(body), 'u-remote');
});

test('remote machine that did not say who the device is: no owner — no seed, no write under a guessed id', () => {
  assert.equal(workspaceOwnerOf({ user: { id: 'u-local' }, acting: { machine: 'vps', user: null, can: null } }), null);
  assert.equal(workspaceOwnerOf({ user: { id: 'u-local' }, acting: { machine: 'vps' } }), null);
  // A malformed block is not "local": refused the same way.
  assert.equal(workspaceOwnerOf({ user: { id: 'u-local' }, acting: 'vps' }), null);
});

test('no local session: no owner, whatever the remote block says', () => {
  for (const body of [null, {}, { user: null }, { user: { id: '' } }, { user: null, acting: { machine: 'vps', user: { id: 'u-remote' } } }]) {
    assert.equal(workspaceOwnerOf(body), null, JSON.stringify(body));
  }
});

test('the remote user is checked field by field: it comes from another machine', () => {
  assert.equal(parseActingUser({ email: 'x' }), null);
  assert.equal(parseActingUser({ id: 'x'.repeat(129) }), null);
  assert.deepEqual(parseActingUser({ id: 'u', email: 'e', name: 'n', is_superadmin: 'yes', avatar_url: '/api/ui/avatars/u.png', extra: 1 }), {
    id: 'u', email: 'e', name: 'n', is_superadmin: false, avatar_url: '/api/ui/avatars/u.png',
  });
});

test('an avatar URL from another machine stays on this origin: absolute or protocol-relative ones are dropped', () => {
  for (const avatar of ['https://evil.example/a.png', '//evil.example/a.png', 'javascript:alert(1)']) {
    assert.equal(parseActingUser({ id: 'u', avatar_url: avatar })?.avatar_url, null, avatar);
  }
});

test('the acting block: permissions filtered to the known ones, a missing machine id refused', () => {
  assert.equal(parseActingAccount({ user: { id: 'u' } }), null);
  assert.deepEqual(parseActingAccount({ machine: 'vps', user: { id: 'u' }, can: { 'projects:manage': true, 'root:everything': true } })?.can, { 'projects:manage': true });
});

test('each machine its mode: the page paints the scheme of the account acting on the active machine', () => {
  const local = { user: { id: 'u-local' }, prefs: { scheme: 'light' } };
  assert.equal(schemeOfMe(local), 'light');
  assert.equal(schemeOfMe({ ...local, acting: null }), 'light');
  // Two machines, two modes: this computer light, the VPS dark.
  assert.equal(schemeOfMe({ ...local, acting: { machine: 'vps', user: { id: 'u-remote' }, can: null, scheme: 'dark' } }), 'dark');
});

test('each machine its mode: a machine that did not say shows this computer\'s mode until it has its own', () => {
  const local = { user: { id: 'u-local' }, prefs: { scheme: 'light' } };
  assert.equal(schemeOfMe({ ...local, acting: { machine: 'vps', user: { id: 'u-remote' }, can: null } }), 'light');
  assert.equal(schemeOfMe({ ...local, acting: { machine: 'vps', user: { id: 'u-remote' }, can: null, scheme: 'sepia' } }), 'light');
  // No account named there: its mode is not trusted either.
  assert.equal(schemeOfMe({ ...local, acting: { machine: 'vps', user: null, can: null, scheme: 'dark' } }), 'light');
  assert.equal(schemeOfMe({ user: null }), null);
  assert.equal(schemeOfMe(null), null);
});

// TIM-0137: up to 0.1.6-rc.6 a window on a remote hashed its scopes with the
// local id; the rows written then are only found again under that id.
test('remote machine: the rows written before 0.1.6 were hashed with the local id', () => {
  const body = { user: { id: 'u-local' }, acting: { machine: 'vps', user: { id: 'u-remote' }, can: null } };
  assert.equal(previousLayoutOwnerOf(body), 'u-local');
  assert.equal(previousLayoutOwner('u-local', 'u-remote'), 'u-local');
});

test('no previous owner on this computer, on a remote paired with the same id, or without an owner', () => {
  assert.equal(previousLayoutOwnerOf({ user: { id: 'u-local' } }), null);
  assert.equal(previousLayoutOwnerOf({ user: { id: 'u-local' }, acting: null }), null);
  assert.equal(previousLayoutOwnerOf({ user: { id: 'u-same' }, acting: { machine: 'vps', user: { id: 'u-same' }, can: null } }), null);
  assert.equal(previousLayoutOwnerOf({ user: { id: 'u-local' }, acting: { machine: 'vps', user: null, can: null } }), null);
  assert.equal(previousLayoutOwnerOf({ user: null, acting: { machine: 'vps', user: { id: 'u-remote' }, can: null } }), null);
  assert.equal(previousLayoutOwnerOf(null), null);
  assert.equal(previousLayoutOwner(null, 'u-remote'), null);
  assert.equal(previousLayoutOwner('u-local', null), null);
});
