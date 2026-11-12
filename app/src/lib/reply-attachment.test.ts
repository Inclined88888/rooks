/**
 * A user turn that replies to an earlier message: the thread draws a quote
 * from its `reply` attachment and hides the header the agent read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promptTypedText, readReplyAttachment, renderPromptText } from './prompt-presentation';

const header = '<reply-to event="9">\nThe plan\n</reply-to>\nThe user is replying…\n\n';
const origin = (attachments: unknown[]) => ({
  presentation: { version: 1, parts: [{ kind: 'instruction', text: header, label: 'replyTo' }, { kind: 'text', text: 'Go ahead' }], attachments },
});

test('a well-formed reply attachment is read, a malformed one is ignored', () => {
  assert.deepEqual(readReplyAttachment(origin([{ type: 'reply', event_id: 9, role: 'agent', excerpt: 'The plan' }])),
    { eventId: 9, role: 'agent', excerpt: 'The plan' });
  for (const bad of [{ type: 'reply', event_id: 0, role: 'agent', excerpt: 'x' }, { type: 'reply', event_id: 9, role: 'bot', excerpt: 'x' },
    { type: 'reply', event_id: 9, role: 'agent', excerpt: 'x'.repeat(500) }]) {
    assert.equal(readReplyAttachment(origin([bad])), null);
  }
  assert.equal(readReplyAttachment(origin([{ type: 'annotation' }])), null);
  assert.equal(readReplyAttachment(null), null);
});

test('the bubble hides the reply header only when the quote replaces it', () => {
  const text = header + 'Go ahead';
  const shown = renderPromptText(text, origin([{ type: 'reply', event_id: 9, role: 'agent', excerpt: 'The plan' }]));
  assert.doesNotMatch(shown, /reply-to|replying/);
  assert.match(shown, /Go ahead/);
  // No quote to draw: the header stays, folded, rather than vanish.
  assert.match(renderPromptText(text, origin([])), /automatic-instruction/);
  assert.equal(promptTypedText(text, origin([{ type: 'reply', event_id: 9, role: 'agent', excerpt: 'The plan' }])), 'Go ahead');
});
