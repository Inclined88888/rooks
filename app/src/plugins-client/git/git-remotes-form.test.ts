/**
 * The checks the remotes dialog runs before sending (TODO #278).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteFormIssue, urlCarriesCredentials, validRemoteName } from './git-remotes-form';

test('remote names: what a person types, never an option', () => {
  for (const name of ['origin', 'gitea', 'my.fork', 'up_stream-2']) assert.equal(validRemoteName(name), true, name);
  for (const name of ['', '-x', 'a b', 'a/b', 'a..b', 'fork.', 'x.lock', 'a;b', 'n'.repeat(65)]) {
    assert.equal(validRemoteName(name), false, name);
  }
});

test('credentials in an https url are caught before anything is sent', () => {
  assert.equal(urlCarriesCredentials('https://user:pw@github.com/o/r.git'), true);
  assert.equal(urlCarriesCredentials('https://ghp_token@github.com/o/r.git'), true);
  assert.equal(urlCarriesCredentials(' HTTP://oauth2@gitlab.local/o/r.git'), true);
  assert.equal(urlCarriesCredentials('ssh://git:pw@example.com/r.git'), true);
  assert.equal(urlCarriesCredentials('ssh://git@example.com/r.git'), false);
  assert.equal(urlCarriesCredentials('git@github.com:o/r.git'), false);
  assert.equal(urlCarriesCredentials('https://github.com/o/r.git'), false);
  // An @ in the path is not a user part.
  assert.equal(urlCarriesCredentials('https://example.com/@scope/r.git'), false);
});

test('the first blocking issue', () => {
  assert.equal(remoteFormIssue('origin', 'git@github.com:o/r.git'), null);
  assert.equal(remoteFormIssue('', ''), null);
  assert.equal(remoteFormIssue('a b', 'git@github.com:o/r.git'), 'name');
  assert.equal(remoteFormIssue('origin', 'https://t@github.com/o/r.git'), 'credentials');
  assert.equal(remoteFormIssue('origin', '--upload-pack=x'), 'url');
  assert.equal(remoteFormIssue('origin', 'ext::sh -c x'), 'url');
  assert.equal(remoteFormIssue('origin', '/srv/git/my repo.git'), null);
});
