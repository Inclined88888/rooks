/**
 * One live mascot per conversation (TODO #902): a card waiting for an answer
 * made every bubble of its agent hop, in every chat of that agent.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { bubbleState, isPendingCard, liveBubbleOf, STREAM_BUBBLE_ID, type BubbleMsg } from './bubble-face';

const agent = (id: string): BubbleMsg => ({ id, role: 'agent' });
const user = (id: string): BubbleMsg => ({ id, role: 'user' });

test('the card that waits is the live bubble, wherever it sits', () => {
  const card: BubbleMsg = { id: 'q', role: 'permission', perm: { state: 'pending' } };
  assert.equal(liveBubbleOf([agent('a1'), card, agent('a2'), user('u1')], true), 'q', 'over the bubble being written too');
  assert.equal(isPendingCard({ id: 's', role: 'secret', secretRequest: { status: 'pending' } }), true);
  assert.equal(isPendingCard({ id: 'p', role: 'permission', perm: { state: 'allowed' } }), false, 'an answered card waits no more');
});

test('without a card: the bubble being written, otherwise the agent\'s last one', () => {
  assert.equal(liveBubbleOf([agent('a1'), user('u1')], true), STREAM_BUBBLE_ID);
  assert.equal(liveBubbleOf([agent('a1'), agent('a2'), user('u1'), { id: 'n', role: 'notice' }], false), 'a2', 'a person\'s turn or a notice has no mascot');
  assert.equal(liveBubbleOf([user('u1')], false), null);
});

test('the live bubble shows this conversation; the store only adds a reaction or sleep', () => {
  assert.equal(bubbleState('waiting', 'idle'), 'waiting');
  assert.equal(bubbleState(null, 'waiting'), 'idle', 'another conversation of the agent waits: not this one');
  assert.equal(bubbleState(null, 'working'), 'idle');
  assert.equal(bubbleState(null, 'happy'), 'happy');
  assert.equal(bubbleState(null, 'sleeping'), 'sleeping');
  assert.equal(bubbleState(null, null), 'idle');
});
