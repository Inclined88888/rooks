import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupEntry } from './setup-entry';

const pending = { status: 'pending' as const, available: true };

test('an orchestrator of any name that was not named yet sees « Your AIs », then the name', () => {
  assert.deepEqual(setupEntry({ ...pending, name: 'Rooks', named: false }, null, false), { kind: 'providers' });
  assert.deepEqual(setupEntry({ ...pending, name: 'Rooks', named: false }, null, true), { kind: 'name' });
  assert.deepEqual(setupEntry({ ...pending, name: '_main', named: false }, null, false), { kind: 'providers' });
  // A daemon older than the field says nothing: the step is not skipped on a guess.
  assert.deepEqual(setupEntry({ ...pending, name: 'Rooks' }, null, false), { kind: 'providers' });
});

test('a name already given resumes on the chat, whatever the name — `_main` included', () => {
  assert.deepEqual(setupEntry({ ...pending, name: 'Rooks', named: true }, null, false), { kind: 'startChat', agent: 'Rooks' });
  assert.deepEqual(setupEntry({ ...pending, name: '_main', named: true }, null, false), { kind: 'startChat', agent: '_main' });
});

test('an open conversation of the same agent reopens; a finished step leaves', () => {
  const resume = { agent: 'Rooks', missionId: 'm-1' };
  assert.deepEqual(setupEntry({ ...pending, name: 'Rooks', named: true }, resume, false), { kind: 'chat', agent: 'Rooks', missionId: 'm-1' });
  assert.deepEqual(setupEntry({ ...pending, name: 'Other', named: true }, resume, false), { kind: 'startChat', agent: 'Other' });
  assert.deepEqual(setupEntry({ status: 'complete', available: true, name: 'Rooks', named: true }, null, false), { kind: 'done' });
});
