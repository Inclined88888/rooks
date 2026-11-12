/**
 * Which agents the mobile navigator lists: read from the daemon's `main` flag
 * and the orchestrator role, never from a seed name (TODO #595).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isMainAgent } from '@/components/mobile-agent-list';

test('the main agent is listed under any name, by its flag', () => {
  assert.equal(isMainAgent({ name: 'Rooks', main: true }), true);
});

test('orchestrators are listed by role, whatever they are called', () => {
  assert.equal(isMainAgent({ name: 'assoJS', role: 'orchestrator', project: 'asso' }), true);
});

test('a seed name alone lists nobody', () => {
  assert.equal(isMainAgent({ name: '_main', main: false }), false);
  assert.equal(isMainAgent({ name: 'rooks.main', role: 'coder', project: 'rooks' }), false);
});
