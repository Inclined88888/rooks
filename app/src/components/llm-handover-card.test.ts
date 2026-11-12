/**
 * The card of a lost native session (`context_recovery`): it is all the user
 * reads of what the agent still remembers, so "lost" must read as lost and no
 * lossy mode may pass for the whole conversation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LlmHandoverCard, recoveryLabel, type HandoverContextMode, type LlmHandover } from './llm-handover-card';

(globalThis as { React?: typeof React }).React = React;

function card(mode: HandoverContextMode): string {
  const side = { backend: 'claude', model: 'opus' };
  const handover: LlmHandover = { kind: 'recovery', from: side, to: side, context: { mode, tokens: 12_000 } };
  return renderToStaticMarkup(createElement(LlmHandoverCard, { handover, time: '09:00' }));
}

test('each recovery mode says what was really replayed', () => {
  assert.match(recoveryLabel({ mode: 'transcript', tokens: 12_000 }), /replayed.*12 k tokens/);
  assert.match(recoveryLabel({ mode: 'summary', tokens: 300 }), /summary.*details may be missing/);
  assert.match(recoveryLabel({ mode: 'tail', tokens: 300 }), /end of the conversation.*beginning is missing/);
  assert.match(recoveryLabel({ mode: 'none', tokens: 0 }), /earlier context is lost/);
});

test('the card names the lost session and its mode, in the forced tone', () => {
  const lost = card('none');
  assert.match(lost, /Native session unavailable/);
  assert.match(lost, /earlier context is lost/);
  assert.match(lost, /border-amber-500/);
  assert.doesNotMatch(lost, /text-emerald/, 'a lost context is not a success');
  assert.match(card('transcript'), /text-emerald/);
  assert.match(card('tail'), /text-amber-600/);
});

test('same engine on both sides: one tile, no arrow between them', () => {
  const html = card('transcript');
  assert.equal(html.split('role="status"').length, 2);
  assert.equal(html.match(/rotate-90/g), null);
});

test('a repointed pilot: the card promises the context for later, never as already preserved', () => {
  const handover: LlmHandover = {
    kind: 'backend',
    from: { backend: 'acme', model: null },
    to: { backend: 'acme-next', model: null },
    context: { mode: 'pending', tokens: 0 },
    cause: 'fallback',
    causeDetail: 'quota',
  };
  const html = renderToStaticMarkup(createElement(LlmHandoverCard, { handover, time: '09:00' }));
  assert.match(html, /Automatic fallback/);
  assert.match(html, /goes to this backend with your next message/);
  assert.match(html, /will continue on this one/);
  assert.doesNotMatch(html, /context preserved/);
  assert.doesNotMatch(html, /no prior context/);
  assert.doesNotMatch(html, /text-emerald/, 'nothing has crossed yet');
});
