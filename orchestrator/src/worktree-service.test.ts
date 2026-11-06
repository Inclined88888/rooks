import './test-home.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { db, dbApi } from './db.js';
import { disposeTaskWorktree } from './worktree-service.js';

test('disposing a worktree whose folder is gone clears the reference without needing the agent cwd', async () => {
  const id = randomUUID();
  // An agent that does not exist has no cwd: the old path threw 'agent has no cwd'.
  dbApi.createTask(id, 'Stale worktree', 'no-such-agent');
  dbApi.setTaskWorktree(id, join(process.env.TIMON_HOME!, 'gone', id), `timon/task/${id}`, 'main');
  const task = dbApi.getTask(id)!;
  assert.deepEqual(await disposeTaskWorktree(task, false), { disposed: true });
  const after = db.prepare('SELECT worktree_path, branch_name FROM tasks WHERE id = ?').get(id);
  assert.deepEqual(after, { worktree_path: null, branch_name: null });
});
