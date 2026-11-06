/** The terminal belongs to a project (or an agent without one): its shells are filed under that scope. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeFromKey, scopeKey, scopeOfView } from './terminal-web';

test('a view is scoped by its project first, then its agent', () => {
  assert.deepEqual(scopeOfView('globex', 'globex.coder'), { kind: 'project', slug: 'globex' });
  assert.deepEqual(scopeOfView(null, 'solo-agent'), { kind: 'agent', name: 'solo-agent' });
  assert.equal(scopeOfView(null, null), null);
  assert.equal(scopeKey({ kind: 'project', slug: 'timon' }), 'project:timon');
  assert.deepEqual(scopeFromKey('agent:a.b'), { kind: 'agent', name: 'a.b' });
  assert.equal(scopeFromKey(null), null);
});
