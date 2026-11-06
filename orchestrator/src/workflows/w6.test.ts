import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-workflows-w6-'));
const { db } = await import('../db.js');
const { dbApi } = await import('../db.js');
const { advance, answerWorkflowHuman, createRun } = await import('./engine.js');
const { armWorkflowTriggers, tickWorkflowTriggers } = await import('./triggers.js');
const { workflowNodeTriggers } = await import('./native-facade.js');
const { fireTrigger, tickSchedules } = await import('../triggers/engine.js');
const { getTrigger } = await import('../triggers/store.js');
const { registerActionProvider } = await import('../triggers/actions.js');
const { createWorkflowActionProvider } = await import('./native-triggers.js');

// Schedule, webhook and event nodes are façades of native triggers: the native
// engine fires them through the `workflow` action, unsupervised here.
registerActionProvider('workflow', createWorkflowActionProvider({ supervised: false }));
const facadeOf = (id: string) => getTrigger(workflowNodeTriggers(id)[0]!.trigger_id)!;
const fire = (id: string, body: unknown) => fireTrigger(facadeOf(id), { body, headers: {} });

function seed(nodes: unknown[], edges: unknown[] = [], settings: Record<string, unknown> = {}) {
  const id = randomUUID(); const now = Date.now();
  const definition = { schemaVersion: 1, nodes, edges, variables: [], settings };
  dbApi.insertWorkflow({ id, slug: `w6-${id.slice(0, 8)}`, name: 'W6 witness', description: null, project: null, owner_user_id: null, draft: JSON.stringify(definition), published_version: 1, enabled: 1, created_at: now, updated_at: now , agent_name: null});
  dbApi.insertWorkflowVersion({ workflow_id: id, version: 1, definition: JSON.stringify(definition), published_at: now, published_by: null });
  return id;
}

test('schedule claims a due tick once and skips an overlapping run', async () => {
  const id = seed([{ id: 'cron', type: 'trigger.schedule', config: { cron: '* * * * *' } }, { id: 'out', type: 'output', config: { template: 'ok' } }], [{ id: 'edge', from: 'cron', fromPort: 'out', to: 'out', toPort: 'in' }]);
  armWorkflowTriggers(id);
  const trigger = facadeOf(id);
  assert.equal(trigger.source, 'schedule');
  db.prepare('UPDATE triggers SET next_run_at=0 WHERE id=?').run(trigger.id);
  tickSchedules(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dbApi.listWorkflowRuns(id).length, 1);
  assert.equal(dbApi.listWorkflowRuns(id)[0]!.status, 'completed');
  assert.equal(JSON.parse(dbApi.listWorkflowRunNodes(dbApi.listWorkflowRuns(id)[0]!.id).find(n => n.node_id === 'out')!.output!), 'ok');
  assert.ok((getTrigger(trigger.id)!.nextRunAt ?? 0) > 1, 'the tick claimed the occurrence');
  db.prepare('UPDATE triggers SET next_run_at=0 WHERE id=?').run(trigger.id);
  dbApi.updateWorkflowRun(dbApi.listWorkflowRuns(id)[0]!.id, { status: 'running' });
  tickSchedules(2);
  assert.equal(dbApi.listWorkflowRuns(id).length, 1);
});

test('an event node keeps its expression filter on the native payload', () => {
  const id = seed([{ id: 'event', type: 'trigger.event', config: { kind: 'notification', filter: 'level == "high"' } }, { id: 'out', type: 'output', config: { template: 'ok' } }], [{ id: 'edge', from: 'event', fromPort: 'out', to: 'out', toPort: 'in' }]);
  armWorkflowTriggers(id);
  assert.equal(facadeOf(id).source, 'event');
  fire(id, { level: 'low' });
  assert.equal(dbApi.listWorkflowRuns(id).length, 0);
  fire(id, { level: 'high' });
  assert.equal(dbApi.listWorkflowRuns(id).length, 1);
});

test('human answer and timeout use their declared ports', async () => {
  const id = seed([{ id: 'manual', type: 'trigger.manual', config: {} }, { id: 'human', type: 'human', config: { question: 'Proceed?', options: ['later'], timeoutMs: 10_000 } }, { id: 'out', type: 'output', config: { template: 'ok' } }], [{ id: 'a', from: 'manual', fromPort: 'out', to: 'human', toPort: 'in' }, { id: 'b', from: 'human', fromPort: 'approved', to: 'out', toPort: 'in' }]);
  const run = createRun(id, { trigger: { kind: 'manual' } }); await new Promise((resolve) => setImmediate(resolve));
  const waiting = JSON.parse(dbApi.listWorkflowRunNodes(run.id).find((row) => row.node_id === 'human')!.output!) as { notification_id: string };
  const card = dbApi.getNotification(waiting.notification_id)!;
  assert.equal(card.type, 'action_required');
  assert.equal(card.title, 'Proceed?');
  assert.equal(card.dismissed_at, null);
  assert.equal(answerWorkflowHuman(run.id, 'human', 'approved'), true);
  assert.notEqual(dbApi.getNotification(waiting.notification_id)!.dismissed_at, null, 'answering closes the card');
  await advance(run.id);
  assert.equal(dbApi.listWorkflowRunNodes(run.id).find((row) => row.node_id === 'human')?.taken_port, 'approved');
});

test('script returns JSON, fails non-zero, and masks secret output in its span', async () => {
  const id = seed([{ id: 'manual', type: 'trigger.manual', config: {} }, { id: 'script', type: 'script', config: { bin: 'node', args: ['-e', 'process.stdout.write(JSON.stringify({ok:true}))'], timeoutMs: 5_000 } }], [{ id: 'edge', from: 'manual', fromPort: 'out', to: 'script', toPort: 'in' }]);
  const run = createRun(id, { trigger: { kind: 'manual' } });
  const deadline = performance.now() + 10_000;
  let script = dbApi.listWorkflowRunNodes(run.id).find((row) => row.node_id === 'script');
  while (!script || ['pending', 'ready', 'running', 'waiting'].includes(script.status)) {
    assert.ok(performance.now() < deadline, `Script node did not finish within 10000 ms (status: ${script?.status ?? 'missing'})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    script = dbApi.listWorkflowRunNodes(run.id).find((row) => row.node_id === 'script');
  }
  assert.equal(script.status, 'ok', `Script node failed: ${script.error ?? script.status}`);
  assert.deepEqual(JSON.parse(script.output!), { ok: true });
});

test('script runs with the system whitelist, never the daemon\'s own environment', async () => {
  // What `loadSecretsAtBoot` leaves in the daemon's environment, and an API key the user exported.
  process.env.TIMON_TELEGRAM_BOT_TOKEN = 'daemon-secret-telegram';
  process.env.OPENAI_API_KEY = 'daemon-secret-openai';
  try {
    const probe = 'process.stdout.write(JSON.stringify({ telegram: process.env.TIMON_TELEGRAM_BOT_TOKEN ?? null, openai: process.env.OPENAI_API_KEY ?? null, path: Boolean(process.env.PATH), home: process.env.TIMON_HOME ?? null }))';
    const id = seed([{ id: 'manual', type: 'trigger.manual', config: {} }, { id: 'script', type: 'script', config: { bin: 'node', args: ['-e', probe], timeoutMs: 5_000 } }], [{ id: 'edge', from: 'manual', fromPort: 'out', to: 'script', toPort: 'in' }]);
    const run = createRun(id, { trigger: { kind: 'manual' } });
    const deadline = performance.now() + 10_000;
    let script = dbApi.listWorkflowRunNodes(run.id).find((row) => row.node_id === 'script');
    while (!script || ['pending', 'ready', 'running', 'waiting'].includes(script.status)) {
      assert.ok(performance.now() < deadline, `Script node did not finish within 10000 ms (status: ${script?.status ?? 'missing'})`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      script = dbApi.listWorkflowRunNodes(run.id).find((row) => row.node_id === 'script');
    }
    assert.equal(script.status, 'ok', `Script node failed: ${script.error ?? script.status}`);
    assert.deepEqual(JSON.parse(script.output!), { telegram: null, openai: null, path: true, home: process.env.TIMON_HOME });
  } finally {
    delete process.env.TIMON_TELEGRAM_BOT_TOKEN;
    delete process.env.OPENAI_API_KEY;
  }
});

async function settled(runId: string) {
  const deadline = performance.now() + 10_000;
  for (;;) {
    const run = dbApi.getWorkflowRun(runId)!;
    if (!['pending', 'running', 'waiting'].includes(run.status)) return run;
    assert.ok(performance.now() < deadline, `run did not settle within 10000 ms (status: ${run.status})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('a script leaves by its declared done port, and a wired failed port handles its failure', async () => {
  const chain = (code: string) => seed([
    { id: 'manual', type: 'trigger.manual', config: {} },
    { id: 'script', type: 'script', config: { bin: 'node', args: ['-e', code], timeoutMs: 5_000 } },
    { id: 'ok', type: 'output', config: { template: 'done path' } },
    { id: 'ko', type: 'output', config: { template: 'failed path' } },
  ], [
    { id: 'a', from: 'manual', fromPort: 'out', to: 'script', toPort: 'in' },
    { id: 'b', from: 'script', fromPort: 'done', to: 'ok', toPort: 'in' },
    { id: 'c', from: 'script', fromPort: 'failed', to: 'ko', toPort: 'in' },
  ]);
  const good = await settled(createRun(chain('process.stdout.write("{}")'), { trigger: { kind: 'manual' } }).id);
  assert.equal(good.status, 'completed');
  const goodNodes = dbApi.listWorkflowRunNodes(good.id);
  assert.equal(goodNodes.find((row) => row.node_id === 'script')!.taken_port, 'done');
  assert.equal(JSON.parse(goodNodes.find((row) => row.node_id === 'ok')!.output!), 'done path');
  assert.equal(goodNodes.find((row) => row.node_id === 'ko')!.status, 'skipped');

  const bad = await settled(createRun(chain('process.exit(3)'), { trigger: { kind: 'manual' } }).id);
  assert.equal(bad.status, 'completed', 'the failure was routed, so the run does not fail');
  const badNodes = dbApi.listWorkflowRunNodes(bad.id);
  const script = badNodes.find((row) => row.node_id === 'script')!;
  assert.equal(script.taken_port, 'failed');
  assert.match(script.error ?? '', /code 3/);
  assert.equal(JSON.parse(badNodes.find((row) => row.node_id === 'ko')!.output!), 'failed path');
  assert.equal(dbApi.listSpansByRun(bad.id).find((span) => span.id === `workflow:${bad.id}:node:script`)?.status, 'error', 'the span still says the script failed');
});

test('a script failure with no failed edge still fails the run', async () => {
  const id = seed([
    { id: 'manual', type: 'trigger.manual', config: {} },
    { id: 'script', type: 'script', config: { bin: 'node', args: ['-e', 'process.exit(2)'], timeoutMs: 5_000 } },
    { id: 'ok', type: 'output', config: { template: 'done path' } },
  ], [
    { id: 'a', from: 'manual', fromPort: 'out', to: 'script', toPort: 'in' },
    { id: 'b', from: 'script', fromPort: 'done', to: 'ok', toPort: 'in' },
  ]);
  const run = await settled(createRun(id, { trigger: { kind: 'manual' } }).id);
  assert.equal(run.status, 'failed');
  assert.equal(dbApi.listWorkflowRunNodes(run.id).find((row) => row.node_id === 'script')!.status, 'error');
});

const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
function automatic(kind: 'webhook' | 'event', overlap = 'skip', wait = false) {
  const id = seed([
    { id: 'start', type: `trigger.${kind}`, config: kind === 'event' ? { kind: 'notifications_changed' } : {} },
    { id: 'out', type: wait ? 'wait' : 'output', config: wait ? { ms: 60_000 } : { template: '{{input.text}}' } },
  ], [{ id: 'e', from: 'start', fromPort: 'out', to: 'out', toPort: 'in' }], { overlap });
  armWorkflowTriggers(id);
  return { id, fire: () => fire(id, { text: 'delivered' }) };
}

test('webhook and event façades reach their output with the native payload as input', async () => {
  for (const kind of ['webhook', 'event'] as const) {
    const { id, fire } = automatic(kind);
    assert.equal(facadeOf(id).source, kind);
    fire(); await drain();
    const run = dbApi.listWorkflowRuns(id)[0]!;
    assert.equal(run.status, 'completed');
    assert.equal(JSON.parse(dbApi.listWorkflowRunNodes(run.id).find(n => n.node_id === 'out')!.output!), 'delivered');
    db.prepare('UPDATE workflows SET enabled=0 WHERE id=?').run(id);
  }
});

test('the legacy notifications_changed kind maps to the native notification event', async () => {
  const id = seed([{ id: 'event', type: 'trigger.event', config: { kind: 'notifications_changed' } }]);
  armWorkflowTriggers(id);
  const trigger = facadeOf(id);
  assert.equal(trigger.source === 'event' && trigger.config.event, 'notification');
  fire(id, { ownerUserId: null }); await drain();
  assert.equal(dbApi.listWorkflowRuns(id)[0]!.status, 'completed');
});

test('webhook and event apply skip, queue and parallel consistently', async () => {
  for (const kind of ['webhook', 'event'] as const) for (const overlap of ['skip', 'queue', 'parallel']) {
    const { id, fire } = automatic(kind, overlap, true);
    fire(); await drain(); fire(); await drain();
    const runs = dbApi.listWorkflowRuns(id);
    assert.equal(runs.length, overlap === 'skip' ? 1 : 2, `${kind}/${overlap}`);
    if (overlap === 'queue') {
      assert.equal(runs.filter(r => r.status === 'pending').length, 1);
      const running = runs.find(r => r.status !== 'pending')!;
      dbApi.updateWorkflowRun(running.id, { status: 'completed' });
      tickWorkflowTriggers(); await drain();
      assert.equal(dbApi.listWorkflowRuns(id).filter(r => r.status === 'pending').length, 0);
    }
    db.prepare('UPDATE workflows SET enabled=0 WHERE id=?').run(id);
  }
});
