/**
 * The agent column of `/events`: an event is shown under its mission's agent,
 * never under the seed name `_main` (TODO #595).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMissionAgentResolver, eventAgentLabel } from '@/lib/event-agent-label';

test('an event with no agent shows its mission, never `_main`', () => {
  assert.equal(eventAgentLabel('rooks', 'abcdef0123456789'), 'rooks');
  assert.equal(eventAgentLabel(null, 'abcdef0123456789'), 'abcdef01');
  assert.equal(eventAgentLabel(undefined, null), '—');
});

test('a live event takes the agent of its mission, looked up once', async () => {
  const asked: string[] = [];
  const resolver = createMissionAgentResolver(async (id) => {
    asked.push(id);
    return id === 'm-coder-0001' ? 'rooks.coder' : null;
  });
  assert.equal(await resolver.label('m-coder-0001'), 'rooks.coder');
  assert.equal(await resolver.label('m-coder-0001'), 'rooks.coder');
  // Deleted or not visible to this viewer: the short id, not another agent.
  assert.equal(await resolver.label('m-gone-00001'), 'm-gone-0');
  assert.deepEqual(asked, ['m-coder-0001', 'm-gone-00001']);
});

test('the seed of recent events answers without a lookup', async () => {
  const resolver = createMissionAgentResolver(async () => { throw new Error('no lookup expected'); });
  resolver.remember('m-seeded-001', 'nina');
  resolver.remember('m-deleted-01', null);
  assert.equal(await resolver.label('m-seeded-001'), 'nina');
  assert.equal(await resolver.label('m-deleted-01'), 'm-delete');
});

test('a failed lookup is retried at the next event, not pinned on the mission', async () => {
  let calls = 0;
  const resolver = createMissionAgentResolver(async () => {
    calls += 1;
    if (calls === 1) throw new Error('network');
    return 'rooks.reviewer';
  });
  assert.equal(await resolver.label('m-flaky-0001'), 'm-flaky-');
  assert.equal(await resolver.label('m-flaky-0001'), 'rooks.reviewer');
  assert.equal(calls, 2);
});
