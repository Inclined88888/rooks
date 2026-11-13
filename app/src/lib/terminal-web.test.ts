/**
 * The built-in terminal's client helpers: the stream stays on the page's
 * origin (the app server proxies it), and the phone key bar sends the bytes a
 * physical keyboard would.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ctrlSequence, cwdLabel, insertStep, KEY_SEQUENCES, terminalStreamUrl } from './terminal-web';

test('the stream URL follows the page scheme and host', () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  assert.equal(terminalStreamUrl(id, { protocol: 'https:', host: 'pc.tailnet.ts.net' }), `wss://pc.tailnet.ts.net/api/ui/terminal/web/sessions/${id}/ws`);
  assert.equal(terminalStreamUrl(id, { protocol: 'http:', host: '127.0.0.1:3110' }), `ws://127.0.0.1:3110/api/ui/terminal/web/sessions/${id}/ws`);
});

test('Ctrl+<key> maps to its control code', () => {
  assert.equal(ctrlSequence('c'), '\u0003');
  assert.equal(ctrlSequence('C'), '\u0003');
  assert.equal(ctrlSequence('d'), '\u0004');
  assert.equal(ctrlSequence('['), '\u001b');
  assert.equal(ctrlSequence('1'), null);
  assert.equal(ctrlSequence('ab'), null);
  assert.equal(KEY_SEQUENCES.up, '\u001b[A');
});

test('a tab is labelled by the last folder, whatever the separator', () => {
  assert.equal(cwdLabel('/home/user/webdev/rooks'), 'rooks');
  assert.equal(cwdLabel('C:\\Users\\robin\\proj\\'), 'proj');
});

test('text to type waits for a shell being started, else goes to the active one, the latest, or a new one', () => {
  const sessions = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(insertStep(sessions, 'a', false), { kind: 'type', sessionId: 'a' });
  assert.deepEqual(insertStep(sessions, 'gone', false), { kind: 'type', sessionId: 'b' });
  assert.deepEqual(insertStep(sessions, 'a', true), { kind: 'wait' }, 'an open with a folder: not into the old shell');
  assert.deepEqual(insertStep([], null, true), { kind: 'wait' });
  assert.deepEqual(insertStep([], null, false), { kind: 'create' });
});
