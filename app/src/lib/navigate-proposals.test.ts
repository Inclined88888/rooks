import { test } from 'node:test';
import assert from 'node:assert/strict';
import { navigateHref, parseNavigateProposal } from './navigate-proposals';

test('a path that could leave the app does not parse', () => {
  for (const path of ['//evil.example', 'https://evil.example', 'javascript:alert(1)', '/a?b=c', '/../x', '']) {
    assert.equal(parseNavigateProposal({ path }), null, path);
  }
  assert.equal(parseNavigateProposal({ path: '/chat', params: { mission: 'a&b' } }), null);
  assert.equal(parseNavigateProposal({ path: '/chat', params: { 'Mis': 'x' } }), null);
});

test('the address is rebuilt from the path and its parameters', () => {
  const p = parseNavigateProposal({ path: '/chat', params: { mission: 'm-1' } });
  assert.ok(p);
  assert.equal(navigateHref(p, 'http://localhost:3101/agents'), '/chat?mission=m-1');
  assert.equal(navigateHref({ path: '/kanban', params: {} }, 'http://x/'), '/kanban');
});

test('settings is a dialog over the page on screen', () => {
  const p = parseNavigateProposal({ path: '/settings', params: { section: 'agents' } });
  assert.ok(p);
  assert.equal(navigateHref(p, 'http://localhost:3101/chat?mission=m-1'), '/chat?mission=m-1&settings=agents');
});
