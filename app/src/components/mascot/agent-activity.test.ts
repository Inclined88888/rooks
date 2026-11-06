/**
 * The face that follows a conversation's real activity: what the agent does
 * gives its state, and a short reaction when that changes. Moved verbatim from
 * the former onboarding chat step's test, which was its only cover.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { activityReaction, activityState, IDLE_ACTIVITY, type AgentActivity } from './agent-activity';

test('the face follows the activity: waits on a card, scans a lookup, works a tool, thinks otherwise', () => {
  const busy = (tool: string | null, awaitingUser = false): AgentActivity => ({ busy: true, tool, awaitingUser });
  assert.equal(activityState(busy(null)), 'thinking');
  assert.equal(activityState(busy('mcp__timon__setup_recruit_team')), 'working');
  assert.equal(activityState(busy('mcp__timon__onboarding_profile_get')), 'searching');
  assert.equal(activityState(busy('WebSearch')), 'searching');
  assert.equal(activityState(busy(null, true)), 'waiting', 'a question card outranks the turn');
  assert.equal(activityState(IDLE_ACTIVITY), null);
  assert.equal(activityState(IDLE_ACTIVITY, { typing: true }), 'listening');

  const celebrate = new Set(['setup_set_soul']);
  assert.equal(activityReaction(busy('mcp__timon__setup_set_soul'), busy(null), celebrate), 'celebrate');
  assert.equal(activityReaction(busy(null), IDLE_ACTIVITY, celebrate), 'happy', 'a turn ends on its answer');
  assert.equal(activityReaction(busy(null), { busy: false, tool: null, awaitingUser: true }, celebrate), null);
  assert.equal(activityReaction(busy('Read'), busy(null), celebrate), null);
});

