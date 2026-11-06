/**
 * The picto of an agent follows its ROLE, never its name.
 *
 * `agentRoleKey` used to fall back on the name suffix: `globex.reviewer` showed
 * the reviewer picto with an empty role field, which made the name a contract
 * — an agent called `Jean-Pierre` could never look like a reviewer. The daemon
 * stamped the role on the historical agents once (`agent-role-backfill.ts`),
 * so there is nothing left to infer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentRoleKey, resolveRole } from './roles';

test('the role field decides, whatever the agent is called', () => {
  assert.equal(agentRoleKey('reviewer'), 'reviewer');
  assert.equal(resolveRole(agentRoleKey('reviewer'))?.label, 'reviewer');
});

test('a name that spells a role no longer grants it', () => {
  assert.equal(agentRoleKey(null), null, 'globex.reviewer with no role field stays roleless');
  assert.equal(agentRoleKey(''), null);
  assert.equal(agentRoleKey('not-a-role'), null, 'an unknown key resolves to nothing');
});
