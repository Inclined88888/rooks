/**
 * Signing a subscription account in from the browser (TODO #52, volet 3):
 * what the person is asked to do at each step of a flow, and how an account
 * reads in the list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountLoginPrompt, AccountRow, GrantsPanel, RenamePanel } from '../components/settings/backend-accounts-settings';
import { accountStatus, cleanPastedCode, isLoginOver, loginFailureText, type AccountLogin, type BackendAccount } from './backend-accounts';

Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });

const base: AccountLogin = {
  accountId: 'a1b2c3d4e5', backend: 'claude', state: 'waiting', prompt: null, failure: null,
  identity: null, codeSent: false, startedAt: 0, expiresAt: 1,
};

function prompt(login: AccountLogin | null, code = ''): string {
  return renderToStaticMarkup(React.createElement(AccountLoginPrompt, {
    login, code, busy: false, onCode: () => {}, onSubmit: () => {}, onRetry: () => {}, onClose: () => {},
  }));
}

const account: BackendAccount = {
  id: 'a1b2c3d4e5', instance: 'claude@a1b2c3d4e5', backend: 'claude', name: 'Perso', ownerUserId: 'u1',
  mine: true, state: 'active', connected: false,
};

test('the paste flow links the provider\'s page and asks for the code', () => {
  const html = prompt({ ...base, prompt: { kind: 'paste-code', url: 'https://claude.com/cai/oauth/authorize?code=true' } });
  assert.match(html, /href="https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /Paste the code shown at the end/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Finish sign-in/, 'nothing to send while the field is empty');
  assert.doesNotMatch(prompt({ ...base, prompt: { kind: 'paste-code', url: 'https://x.example' } }, 'abc#def'), /disabled=""[^>]*>Finish/);
});

test('the device flow shows the code to type and waits', () => {
  const html = prompt({ ...base, backend: 'codex', prompt: { kind: 'device-code', url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345' } });
  assert.match(html, />ABCD-12345</);
  assert.match(html, /Waiting for you to confirm/);
  assert.doesNotMatch(html, /<input/, 'nothing to paste in a device flow');
});

test('each other step says where the flow stands', () => {
  assert.match(prompt(null), /Starting the sign-in/);
  assert.match(prompt({ ...base, codeSent: true, prompt: { kind: 'paste-code', url: 'https://x.example' } }), /Checking who signed in/);
  assert.match(prompt({ ...base, state: 'connected', identity: 'ada@example.com' }), /Signed in as ada@example\.com/);
  const failed = prompt({ ...base, state: 'failed', failure: 'mismatch', identity: 'ada@example.com' });
  assert.match(failed, /role="alert"/);
  assert.match(failed, /belongs to ada@example\.com/);
  assert.match(failed, />Try again</);
});

test('a failure reads as what to do next, never as the CLI\'s words', () => {
  assert.match(loginFailureText({ ...base, state: 'failed', failure: 'duplicate' }), /already signed in under another account/);
  assert.match(loginFailureText({ ...base, state: 'failed', failure: null }), /command-line tool failed/);
});

test('an account reads as what it needs', () => {
  assert.equal(accountStatus(account), 'notConnected');
  assert.equal(accountStatus({ ...account, connected: true }), 'connected');
  assert.equal(accountStatus({ ...account, connected: true, state: 'reauth' }), 'reauth');
  assert.equal(accountStatus({ ...account, state: 'cooldown' }), 'cooldown');

  const row = (value: BackendAccount, canManage = true) => renderToStaticMarkup(React.createElement(AccountRow, {
    account: value, ownerName: null, canManage, panelOpen: false, icon: React.createElement('span'),
    onSignIn: () => {}, onDelete: () => {},
  }));
  assert.match(row(account), />Sign in</);
  const signedIn = row({ ...account, connected: true, identity: 'ada@example.com' });
  assert.match(signedIn, /Signed in as ada@example\.com/);
  assert.match(signedIn, />Sign in again</);
  assert.doesNotMatch(row(account, false), /<button/, 'a granted account is used, not signed in');
});

test('the pasted text goes out on one line; a flow is over once settled or gone', () => {
  assert.equal(cleanPastedCode('  abc#def\r\n'), 'abc#def');
  assert.equal(isLoginOver(null), true);
  assert.equal(isLoginOver({ ...base, state: 'verifying' }), false);
  assert.equal(isLoginOver({ ...base, state: 'failed' }), true);
});

test('the superadmin assigns an account from its row; anyone who manages it renames it (TODO #330)', () => {
  const row = (props: Partial<React.ComponentProps<typeof AccountRow>>) => renderToStaticMarkup(React.createElement(AccountRow, {
    account, ownerName: null, canManage: true, panelOpen: false, icon: React.createElement('span'),
    onSignIn: () => {}, onDelete: () => {}, ...props,
  }));
  const owner = row({ onRename: () => {} });
  assert.match(owner, />Rename</);
  assert.doesNotMatch(owner, />Assign</, 'only the superadmin assigns');
  const admin = row({ onRename: () => {}, onAssign: () => {}, grantees: ['ada', 'bob'] });
  assert.match(admin, />Assign</);
  assert.match(admin, /Assigned to ada, bob/);
  assert.doesNotMatch(row({ onRename: () => {}, onAssign: () => {}, panelOpen: true }), /<button/, 'an open panel holds the row');
});

test('the assignment panel offers every user but the owner, and says when there is nobody', () => {
  const users = [
    { id: 'u1', name: 'Owner', email: 'owner@example.com' },
    { id: 'u2', name: 'Ada', email: 'ada@example.com' },
  ];
  const panel = (value: BackendAccount, list = users) => renderToStaticMarkup(React.createElement(GrantsPanel, {
    account: value, users: list, onDone: () => {}, onCancel: () => {},
  }));
  const html = panel({ ...account, grantedTo: ['u2'] });
  assert.doesNotMatch(html, /Owner/);
  assert.match(html, /<input type="checkbox"[^>]*checked=""[^>]*\/><span[^>]*>Ada</);
  assert.match(panel(account, [users[0]!]), /no other user on this instance/);
});

test('renaming waits for a new, non-empty name', () => {
  const html = renderToStaticMarkup(React.createElement(RenamePanel, { account, onDone: () => {}, onCancel: () => {} }));
  assert.match(html, /value="Perso"/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Save</, 'the same name sends nothing');
  assert.match(html, /aria-label="New name for Perso"/);
});
