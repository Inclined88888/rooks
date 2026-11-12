import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canDetachWorktree, detachTaskWorktree } from './worktree-detach';

test('only a pending or blocked task with a worktree offers the action', () => {
  assert.equal(canDetachWorktree({ status: 'BLOCKED', worktree_path: '/w/1' }), true);
  assert.equal(canDetachWorktree({ status: 'PENDING', worktree_path: '/w/1' }), true);
  assert.equal(canDetachWorktree({ status: 'IN_PROGRESS', worktree_path: '/w/1' }), false);
  assert.equal(canDetachWorktree({ status: 'DONE', worktree_path: '/w/1' }), false);
  assert.equal(canDetachWorktree({ status: 'BLOCKED', worktree_path: null }), false);
});

test('the request posts nothing but the task id, and reads the refusal', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const ok = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, detached: true }), { status: 200 });
  }) as typeof fetch;
  assert.deepEqual(await detachTaskWorktree('a/b', ok), { ok: true });
  assert.equal(calls[0]!.url, '/api/ui/tasks/a%2Fb/worktree-detach');
  assert.equal(calls[0]!.init?.method, 'POST');
  assert.equal(calls[0]!.init?.body, undefined);

  const refused = (async () => new Response(JSON.stringify({ error: 'contains modified or untracked files' }), { status: 500 })) as typeof fetch;
  assert.deepEqual(await detachTaskWorktree('t', refused), { ok: false, message: 'contains modified or untracked files' });
  const down = (async () => { throw new Error('offline'); }) as typeof fetch;
  assert.deepEqual(await detachTaskWorktree('t', down), { ok: false, message: null });
});
