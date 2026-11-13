/**
 * The maintainer's request: a notification must say which agent it comes from. The agent is read
 * from the notification's mission, else its task — nothing is stored, so the
 * notifications raised before this change get one too.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-notification-agents-'));

const { dbApi } = await import('./db.js');

test('each notification names the agent of its mission, else of its task', () => {
  const mission = randomUUID();
  dbApi.createMission(mission, 'rooks.coder', 'fix the bell');
  const task = randomUUID();
  dbApi.createTask(task, 'review the bell', 'rooks.reviewer', {});

  const fromMission = dbApi.createNotification({ id: randomUUID(), type: 'alert', title: 'TIM-0060', missionId: mission });
  const fromTask = dbApi.createNotification({ id: randomUUID(), type: 'alert', title: 'Task blocked', taskId: task });
  const both = dbApi.createNotification({ id: randomUUID(), type: 'report', title: 'done', missionId: mission, taskId: task });
  const daemon = dbApi.createNotification({ id: randomUUID(), type: 'report', title: 'Memory curation' });
  const dangling = dbApi.createNotification({ id: randomUUID(), type: 'report', title: 'gone', missionId: randomUUID() });

  const agents = dbApi.notificationAgents([fromMission, fromTask, both, daemon, dangling]);
  assert.equal(agents.get(fromMission.id), 'rooks.coder');
  assert.equal(agents.get(fromTask.id), 'rooks.reviewer');
  assert.equal(agents.get(both.id), 'rooks.coder', 'the mission wins: it is who actually wrote');
  assert.equal(agents.has(daemon.id), false, 'the daemon itself is no agent');
  assert.equal(agents.has(dangling.id), false);
  assert.equal(dbApi.notificationAgents([]).size, 0);
});
