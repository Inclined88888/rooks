/**
 * The onboarding screen shows what an agent will actually be called. The
 * conversion must match the daemon's (`onboarding-main-agent.ts`) — a
 * preview that lies is worse than no preview.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAgentName } from './agent-name';

test('a typed display name becomes a valid agent name', () => {
  assert.equal(toAgentName('Rooks'), 'Rooks');
  assert.equal(toAgentName('Rooks, mon assistante'), 'Rooks-mon-assistante');
  assert.equal(toAgentName('  Éléa  '), 'Elea');
  assert.equal(toAgentName('a'.repeat(60)).length, 48);
  assert.equal(toAgentName('***'), '');
});
