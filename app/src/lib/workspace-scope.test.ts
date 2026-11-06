import assert from 'node:assert/strict';
import test from 'node:test';
import { leftoverNavScope, resolvedNavScope, sharedNavScope, sharedPresetsScope, workspaceKeys, workspaceScope } from './workspace-scope';

const VIEWS: Array<readonly [string, string | null]> = [
  ['/', null],
  ['/chat', 'alpha'],
  ['/agents', null],
  ['/projects', 'beta'],
];

/** What VerticalNav stored under until TIM-0011: the view's own key + `.nav`. */
async function viewNavScope(owner: string, view: string, project: string | null): Promise<string> {
  return leftoverNavScope(await workspaceScope(owner, view, project))!;
}

test('the pinned-nav scope is the same for every view of an owner', async () => {
  const owner = 'owner-a';
  const leftovers = await Promise.all(VIEWS.map(([view, project]) => viewNavScope(owner, view, project)));
  assert.equal(new Set(leftovers).size, VIEWS.length, 'each view used to write its own row');

  const shared = await Promise.all(VIEWS.map(() => sharedNavScope(owner)));
  assert.equal(new Set(shared).size, 1);
  assert.equal(shared[0], await sharedNavScope(owner));
  assert.match(shared[0]!, /^[a-z0-9][a-z0-9._-]{0,63}$/);
  assert.ok(shared[0]!.length <= 64, `${shared[0]!.length} characters`);
  for (const leftover of leftovers) {
    assert.notEqual(shared[0], leftover, 'the owner-wide row is not a view leftover');
  }
});

test('two owners keep distinct pinned-nav rows', async () => {
  const [a, b, aAgain] = await Promise.all([
    sharedNavScope('owner-a'),
    sharedNavScope('owner-b'),
    sharedNavScope('owner-a'),
  ]);
  assert.equal(a, aAgain);
  assert.notEqual(a, b);
  assert.notEqual(
    leftoverNavScope(await workspaceScope('owner-a', '/', null)),
    leftoverNavScope(await workspaceScope('owner-b', '/', null)),
  );
});

test('a missing owner-wide nav row takes the current view leftover as its initial value', async () => {
  const owner = 'owner-a';
  const cockpitKey = await workspaceScope(owner, '/', null);
  const chatKey = await workspaceScope(owner, '/chat', null);
  const global = await sharedNavScope(owner);
  const cockpitLeftover = leftoverNavScope(cockpitKey);
  const chatLeftover = leftoverNavScope(chatKey);
  assert.ok(cockpitLeftover);
  assert.ok(chatLeftover);
  assert.notEqual(global, cockpitLeftover);
  assert.notEqual(global, chatLeftover);
  assert.equal(leftoverNavScope(null), undefined);

  const stored = new Map<string, unknown>([[cockpitLeftover, { pinned: true }]]);
  const initial = stored.get(global) ?? stored.get(cockpitLeftover) ?? null;
  assert.deepEqual(initial, { pinned: true });

  stored.set(global, initial);
  assert.deepEqual(stored.get(global) ?? stored.get(chatLeftover), { pinned: true });
});

/** Same vectors as `orchestrator/src/plugins-bundled/settings/widget-model.test.ts`:
 *  the daemon reads and writes these rows for `widgets_get` and presets. */
test('the scope hash matches the daemon\'s copy, vector for vector', async () => {
  const { workspaceScope: scope, sharedPresetsScope: shared } = await import('./workspace-scope');
  assert.equal(await scope('user-1', '/chat', 'timon'), 'v2.8291cf877624b87afd146a96827a920d843da0cd');
  assert.equal(await scope('user-1', '/', null), 'v2.487f3eb51e8412ef2ba2c1c58bb149023be5c862');
  assert.equal(await shared('user-1', '/'), 'v2.487f3eb51e8412ef2ba2c1c58bb149023be5c862.shared-presets');
});

// TIM-0105: the rail is remounted by every page; its first paint must already
// know the scope, or it paints collapsed until the async hash answers.
test('a derived rail scope is available synchronously afterwards, per owner', async () => {
  assert.equal(resolvedNavScope(null), null);
  assert.equal(resolvedNavScope('owner-never-derived'), null);
  const a = await sharedNavScope('owner-memo-a');
  assert.equal(resolvedNavScope('owner-memo-a'), a);
  assert.equal(resolvedNavScope('owner-memo-b'), null, 'another account does not inherit it');
});

// TIM-0137: every stored arrangement is found again by recomputing this hash.
// A change of the derivation (field order, a field added, a longer slice)
// strands every row already written, as a change of the owner did on remote
// machines between 0.1.6-rc.6 and 0.1.6. These values were computed outside
// the function; a deliberate change comes with its handover of the old rows.
test('the scope derivation is pinned: a change would strand every stored layout', async () => {
  assert.equal(await workspaceScope('owner-a', '/chat', 'alpha'), 'v2.a255316a0a4bfc883c651bdb6aabc87509b84a2a');
  assert.equal(await sharedPresetsScope('owner-a', '/chat'), 'v2.d99918a43faa61f34439684fee3b6207fd2852ad.shared-presets');
});

// TODO #790: one derivation of the keys a workspace's rows are read under,
// for the server render and the browser alike.
test('the previous keys are the same view and project hashed with the previous owner', async () => {
  const local = await workspaceKeys('owner-a', null, '/chat', 'alpha');
  assert.deepEqual(local, {
    key: await workspaceScope('owner-a', '/chat', 'alpha'),
    sharedKey: await sharedPresetsScope('owner-a', '/chat'),
    previousKey: null,
    previousSharedKey: null,
  });
  const remote = await workspaceKeys('owner-remote', 'owner-a', '/chat', 'alpha');
  assert.equal(remote.key, await workspaceScope('owner-remote', '/chat', 'alpha'));
  assert.equal(remote.previousKey, local.key);
  assert.equal(remote.previousSharedKey, local.sharedKey);
});
