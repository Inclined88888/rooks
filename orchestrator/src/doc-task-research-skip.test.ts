/**
 * A `research` task linked to a TODO or a trigger gets no `doc` follow-up: its
 * report already lives in the TODO. A hand-launched research and the other
 * types are unchanged.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, dbApi, type TaskRow } from './db.js';
import { writeRoles } from './projects.js';
import { agentDir } from './paths.js';
import { maybeCreateDocTask } from './doc-task.js';
await import('../tests/helpers/claude-provider.js');


const PROJECT = 'acme';
writeRoles(PROJECT, { doc: { agent: 'acme.librarian', backend: 'claude', model: 'sonnet' } });
mkdirSync(agentDir('acme.librarian'), { recursive: true });
writeFileSync(join(agentDir('acme.librarian'), 'config.json'), JSON.stringify({ role: 'librarian', project: PROJECT }));
writeFileSync(join(agentDir('acme.librarian'), 'system-prompt.md'), 'librarian');

async function docFor(type: TaskRow['type'], link: { todoId?: number; triggerId?: string } = {}): Promise<TaskRow | undefined> {
  const id = randomUUID();
  dbApi.createTask(id, `${type} task`, 'acme.worker', { type, project: PROJECT });
  if (link.todoId !== undefined) dbApi.setTaskTodoId(id, link.todoId);
  if (link.triggerId !== undefined) db.prepare(`UPDATE tasks SET trigger_id = ? WHERE id = ?`).run(link.triggerId, id);
  dbApi.updateTaskStatus(id, 'DONE', { doneComment: 'done' });
  await maybeCreateDocTask(dbApi.getTask(id)!);
  return dbApi.listTasks().find((t) => t.type === 'doc' && t.deps.includes(id));
}

test('research linked to a TODO gets no doc', async () => {
  assert.equal(await docFor('research', { todoId: 42 }), undefined);
});

test('research born from a trigger gets no doc', async () => {
  assert.equal(await docFor('research', { triggerId: 'trg-1' }), undefined);
});

test('a hand-launched research keeps its doc', async () => {
  assert.ok(await docFor('research'));
});

test('code and chore tasks are unchanged', async () => {
  assert.ok(await docFor('code', { todoId: 42 }));
  assert.ok(await docFor('chore'));
});
