import { test } from 'node:test';
import assert from 'node:assert/strict';

import { answerSince, relayStep, type RelayInput, type RelayMessage, type UndelegatedWatch } from './relay';

const plain = (html: string) => html.replace(/<[^>]+>/g, ' ');

const typed: RelayMessage = { id: 'u1', role: 'user', content: 'look at this screenshot' };
const older: RelayMessage = { id: 'a0', role: 'agent', content: '<p>Earlier answer.</p>' };

function input(over: Partial<RelayInput>): RelayInput {
  return { live: true, thinking: false, delegationPending: false, messages: [older], ...over };
}

/** Runs the inputs in order, like the effect does on each render. */
function run(steps: RelayInput[]): { watch: UndelegatedWatch; relays: string[] } {
  let watch: UndelegatedWatch = null;
  const relays: string[] = [];
  for (const step of steps) {
    const next = relayStep(watch, step, plain);
    watch = next.watch;
    if (next.relay) relays.push(next.relay);
  }
  return { watch, relays };
}

test('answerSince keeps the new written agent bubbles only', () => {
  const messages: RelayMessage[] = [
    older,
    typed,
    { id: 'v1', role: 'agent', voice: 'voice', content: 'spoken by GPT-Live' },
    { id: 'a1', role: 'agent', content: '<p>New answer.</p>' },
    { id: 'a2', role: 'agent', content: '' },
  ];
  assert.equal(answerSince(messages, new Set(['a0'])), '<p>New answer.</p>');
});

test('a typed turn during a live session is relayed once it ends', () => {
  const answer: RelayMessage = { id: 'a1', role: 'agent', content: '<p>The screenshot shows a 404.</p>' };
  const { relays, watch } = run([
    input({ thinking: true, messages: [older, typed] }),
    input({ thinking: true, messages: [older, typed, answer] }),
    input({ thinking: false, messages: [older, typed, answer] }),
    input({ thinking: false, messages: [older, typed, answer] }),
  ]);
  assert.deepEqual(relays, ['The screenshot shows a 404.']);
  assert.equal(watch, null);
});

test('messages present when the turn started are never relayed', () => {
  const { relays } = run([
    input({ thinking: true, messages: [older] }),
    input({ thinking: false, messages: [older] }),
  ]);
  assert.deepEqual(relays, []);
});

test('a turn opened by a delegation is left to the delegation', () => {
  const answer: RelayMessage = { id: 'a1', role: 'agent', content: 'Done.' };
  const { relays } = run([
    input({ thinking: true, delegationPending: true, messages: [older] }),
    input({ thinking: false, delegationPending: true, messages: [older, answer] }),
    // The delegation effect has answered and emptied its queue.
    input({ thinking: false, delegationPending: false, messages: [older, answer] }),
  ]);
  assert.deepEqual(relays, []);
});

test('a delegation arriving mid-turn takes the answer over', () => {
  const answer: RelayMessage = { id: 'a1', role: 'agent', content: 'Done.' };
  const { relays } = run([
    input({ thinking: true, messages: [older, typed] }),
    input({ thinking: true, delegationPending: true, messages: [older, typed] }),
    input({ thinking: false, delegationPending: false, messages: [older, typed, answer] }),
  ]);
  assert.deepEqual(relays, []);
});

test('nothing is watched or relayed outside a live session', () => {
  const answer: RelayMessage = { id: 'a1', role: 'agent', content: 'Done.' };
  const { relays } = run([
    input({ live: false, thinking: true, messages: [older] }),
    input({ live: false, thinking: false, messages: [older, answer] }),
  ]);
  assert.deepEqual(relays, []);
  // The session closing mid-turn drops the watch.
  const closed = run([
    input({ thinking: true, messages: [older] }),
    input({ live: false, thinking: false, messages: [older, answer] }),
  ]);
  assert.deepEqual(closed.relays, []);
});

test('a turn without a written answer stays silent', () => {
  const { relays } = run([
    input({ thinking: true, messages: [older, typed] }),
    input({ thinking: false, messages: [older, typed] }),
  ]);
  assert.deepEqual(relays, []);
});

test('code blocks are not read aloud', () => {
  const answer: RelayMessage = { id: 'a1', role: 'agent', content: '<p>Here:</p><pre>npm test</pre>' };
  const { relays } = run([
    input({ thinking: true, messages: [older] }),
    input({ thinking: false, messages: [older, answer] }),
  ]);
  assert.equal(relays.length, 1);
  assert.ok(!relays[0]!.includes('npm test'));
});
