/**
 * The three counts the Git widget used to show as "0 to push" (bugs #22-#24).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPushRemote, publishTone, publishView, pushConfirmation, remotePending } from './git-publish-view';
import type { GitRemote } from '@/lib/git-store';

const base: GitRemote = {
  slug: 'p', state: 'synced', cwd: '/p', branch: 'main', remote_name: 'origin', remote_count: 1,
  remote: 'git@github.com:o/p.git', remote_web: 'https://github.com/o/p', upstream: 'origin/main',
  compare_ref: 'origin/main', branch_published: true, ahead: 0, behind: 0, dirty: 0, has_commits: true,
  last_commit_at: null, fetched_at: null, gh_available: true, gh_account: null, default_repo_name: 'p',
  branches: [
    { name: 'main', upstream: 'origin/main', compare_ref: 'origin/main', ahead: 0, behind: 0, published: true },
    { name: 'feat', upstream: null, compare_ref: 'origin/main', ahead: 0, behind: 0, published: false },
  ],
};

test('nothing waiting reads green', () => {
  assert.equal(publishTone(publishView(base, 'main')), 'green');
});

test('#22: a comparison that did not resolve is unknown, not up to date', () => {
  const v = publishView({ ...base, ahead: null, behind: null }, 'main');
  assert.equal(v.ahead, null);
  assert.equal(publishTone(v), 'amber');
});

test('#23: a detached HEAD is flagged, whatever its count', () => {
  const v = publishView({ ...base, state: 'no-upstream', branch: null, upstream: null, branch_published: false, ahead: 0 }, null);
  assert.equal(v.detached, true);
  assert.equal(publishTone(v), 'amber');
});

test('#24: a branch never pushed is not published even at zero gap', () => {
  const v = publishView(base, 'feat');
  assert.equal(v.ahead, 0);
  assert.equal(v.branchPublished, false);
  assert.equal(publishTone(v), 'amber');
});

test('no remote at all reads red', () => {
  assert.equal(publishTone(publishView({ ...base, state: 'no-remote' }, 'main')), 'red');
});

const twoRemotes: GitRemote = {
  ...base,
  remote_count: 2,
  remotes: [
    { name: 'mirror', url: '/srv/mirror.git', web: null, branches: [
      { name: 'main', published: true, ahead: 3 }, { name: 'feat', published: false, ahead: null },
    ] },
    { name: 'origin', url: 'git@github.com:o/p.git', web: 'https://github.com/o/p', branches: [
      { name: 'main', published: true, ahead: 0 }, { name: 'feat', published: false, ahead: null },
    ] },
  ],
};

test('the default destination is the remote of the upstream, else origin, else the first', () => {
  assert.equal(defaultPushRemote(twoRemotes, 'main'), 'origin');
  const tracksMirror: GitRemote = {
    ...twoRemotes,
    branches: [{ name: 'main', upstream: 'mirror/main', compare_ref: 'mirror/main', ahead: 0, behind: 0, published: true }],
  };
  assert.equal(defaultPushRemote(tracksMirror, 'main'), 'mirror');
  assert.equal(defaultPushRemote(twoRemotes, 'feat'), 'origin', 'no upstream: origin');
  const noOrigin: GitRemote = { ...twoRemotes, remotes: twoRemotes.remotes!.map((r) => ({ ...r, name: r.name === 'origin' ? 'gitlab' : r.name })) };
  assert.equal(defaultPushRemote(noOrigin, 'feat'), 'mirror', 'no upstream, no origin: the first remote');
  assert.equal(defaultPushRemote(base, 'main'), 'origin', 'an older daemon: the publication remote');
});

test('what a branch lacks on a remote, or that it is absent there', () => {
  assert.deepEqual(remotePending(twoRemotes, 'mirror', 'main')?.ahead, 3);
  const absent = remotePending(twoRemotes, 'mirror', 'feat');
  assert.equal(absent?.published, false);
  assert.equal(absent?.ahead, null);
  assert.equal(remotePending(twoRemotes, 'nowhere', 'main'), null);
  assert.equal(remotePending(base, 'origin', 'main'), null);
});

const plan = {
  repo: null, branch: 'main', remote: 'origin', url: 'acme/widgets', upstream: true, published: true, ahead: 122,
};

test('every push to the upstream names the destination, the branch and the count', () => {
  const c = pushConfirmation(plan);
  assert.equal(c.title, 'Push 122 commits of main to acme/widgets?');
  assert.match(c.description ?? '', /origin \(acme\/widgets\)/);
  assert.equal(c.destructive, false);
  assert.equal(c.confirmLabel, 'Push');
  assert.equal(pushConfirmation({ ...plan, ahead: 1 }).title, 'Push 1 commit of main to acme/widgets?');
});

test('a branch never pushed is published, an unknown count says so', () => {
  const absent = pushConfirmation({ ...plan, published: false, ahead: 4 });
  assert.equal(absent.title, 'Publish main on acme/widgets?');
  assert.match(absent.description ?? '', /whole history/);
  assert.equal(absent.confirmLabel, 'Publish');
  const unknown = pushConfirmation({ ...plan, ahead: null });
  assert.equal(unknown.title, 'Push main to acme/widgets?');
  assert.match(unknown.description ?? '', /unknown/);
});

test('the repository is named when the project holds several', () => {
  assert.doesNotMatch(pushConfirmation(plan).description ?? '', /Repository/);
  assert.match(pushConfirmation({ ...plan, repo: 'notes' }).description ?? '', /^Repository notes\. /);
});

test('another remote than the upstream keeps the stronger warning', () => {
  const c = pushConfirmation({ ...plan, remote: 'mirror', url: 'backup/p', upstream: false, ahead: 5 });
  assert.equal(c.title, 'Push 5 commits of main to backup/p?');
  assert.match(c.description ?? '', /mirror is not the upstream of main\./);
  assert.match(c.description ?? '', /5 commit\(s\) of main will be published on mirror \(backup\/p\)/);
  assert.equal(c.destructive, true);
  assert.equal(c.confirmLabel, 'Push to mirror');
});
