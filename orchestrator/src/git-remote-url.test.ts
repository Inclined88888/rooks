/**
 * The remote URLs a user may configure from the Git widget (TODO #278), and
 * the masking of credentials in what is shown back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRemoteUrl, redactUrlCredentials, REMOTE_URL_MESSAGES } from './git-remote-url.js';

test('accepts what people type for GitHub, GitLab, Gitea or their own server', () => {
  const cases: Array<[string, string]> = [
    ['git@github.com:owner/repo.git', 'ssh'],
    ['gitea@git.example.org:team/app', 'ssh'],
    ['git.example.org:repos/app.git', 'ssh'],
    ['ssh://git@gitlab.com/group/sub/repo.git', 'ssh'],
    ['ssh://git@[::1]:2222/srv/repo.git', 'ssh'],
    ['ssh://deploy@nas.local:2222/volume1/git/app.git', 'ssh'],
    ['git+ssh://git@example.com/r.git', 'ssh'],
    ['https://gitlab.com/group/repo.git', 'https'],
    ['https://git.example.org:3000/me/app', 'https'],
    ['http://192.168.1.10/git/app.git', 'http'],
    ['git://example.com/app.git', 'git'],
    ['file:///srv/git/app.git', 'file'],
    ['  git@github.com:o/r.git  ', 'ssh'],
  ];
  for (const [url, kind] of cases) {
    const r = checkRemoteUrl(url);
    assert.deepEqual(r, { ok: true, url: url.trim(), kind }, url);
  }
});

test('accepts an absolute local path, spaces included', () => {
  const path = process.platform === 'win32' ? 'C:\\Users\\Zoé Lefèvre\\repos\\app.git' : '/srv/git/my repo.git';
  assert.deepEqual(checkRemoteUrl(path), { ok: true, url: path, kind: 'path' });
});

test('refuses credentials in the URL', () => {
  for (const url of [
    'https://user:secret@github.com/o/r.git',
    'https://ghp_0123456789abcdef@github.com/o/r.git',
    'http://oauth2@gitlab.example.com/o/r.git',
    'ssh://git:secret@example.com/r.git',
    'user:secret@example.com:repo.git',
  ]) {
    assert.deepEqual(checkRemoteUrl(url), { ok: false, reason: 'credentials' }, url);
  }
});

test('refuses what git would run or read as an option', () => {
  const cases: Array<[string, string]> = [
    ['ext::sh -c touch% /tmp/pwned', 'scheme'],
    ['fd::3', 'scheme'],
    ['--upload-pack=touch /tmp/x', 'option'],
    ['-oProxyCommand=x', 'option'],
    ['ssh://-oProxyCommand=x/repo', 'host'],
    ['-x@host:repo', 'option'],
    ['ftp://example.com/r.git', 'scheme'],
    ['javascript://example.com/x', 'scheme'],
    ['', 'empty'],
    ['   ', 'empty'],
    ['git@github.com:o/r.git\nfoo', 'control-chars'],
    ['https://example.com/my repo.git', 'control-chars'],
    ['https://example.com/', 'malformed'],
    ['https://', 'malformed'],
    ['relative/path', 'malformed'],
    ['repo.git', 'malformed'],
    [`https://example.com/${'a'.repeat(2100)}`, 'too-long'],
  ];
  for (const [url, reason] of cases) {
    assert.deepEqual(checkRemoteUrl(url), { ok: false, reason }, url);
  }
});

test('a refusal message never quotes the URL', () => {
  for (const message of Object.values(REMOTE_URL_MESSAGES)) {
    assert.doesNotMatch(message, /secret|ghp_/);
  }
});

test('redaction masks credentials and keeps the rest of the text', () => {
  assert.equal(redactUrlCredentials('https://user:secret@github.com/o/r.git'), 'https://***@github.com/o/r.git');
  assert.equal(redactUrlCredentials('https://ghp_token@github.com/o/r.git'), 'https://***@github.com/o/r.git');
  assert.equal(
    redactUrlCredentials("fatal: unable to access 'https://u:p4ss@example.com/r.git/': Could not resolve host: example.com"),
    "fatal: unable to access 'https://***@example.com/r.git/': Could not resolve host: example.com",
  );
  assert.equal(redactUrlCredentials('ssh://git:pw@example.com/r.git'), 'ssh://***@example.com/r.git');
  // A user name alone is not a secret over ssh, and git's message is kept whole.
  assert.equal(redactUrlCredentials('ssh://git@example.com/r.git'), 'ssh://git@example.com/r.git');
  assert.equal(
    redactUrlCredentials('git@github.com: Permission denied (publickey).'),
    'git@github.com: Permission denied (publickey).',
  );
});
