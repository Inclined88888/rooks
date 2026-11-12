import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mergeThinking, readThinking } from './thinking';
import { ThinkingBlock } from '../components/chat/thinking-block';

test('reasoning is read from thinking blocks only, empty and redacted ones being absences', () => {
  assert.equal(readThinking([{ type: 'text', text: 'hello' }]), '');
  assert.equal(readThinking([{ type: 'thinking', thinking: '   ' }, { type: 'redacted_thinking' }]), '');
  assert.equal(readThinking([null, 'x', { type: 'thinking', thinking: 42 }]), '');
  assert.equal(
    readThinking([{ type: 'thinking', thinking: ' First. ' }, { type: 'text', text: 'a' }, { type: 'thinking', thinking: 'Second.' }]),
    'First.\n\nSecond.',
  );
});

test('pieces of one step fold into a single text, whatever order they arrive in', () => {
  assert.equal(mergeThinking(undefined, ''), undefined);
  assert.equal(mergeThinking('kept', ''), 'kept');
  assert.equal(mergeThinking(undefined, 'a'), 'a');
  // The 165 chunks an agent can send in one turn end up as ONE block.
  const folded = Array.from({ length: 165 }, (_, i) => `p${i}`).reduce<string | undefined>(mergeThinking, undefined);
  assert.equal(folded?.split('\n\n').length, 165);
});

test('the reasoning block is folded by default and never injects HTML', () => {
  const html = renderToStaticMarkup(React.createElement(ThinkingBlock, { text: 'plan <img src=x onerror=alert(1)>' }));
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.match(html, /<summary[^>]*>.*Reasoning.*<\/summary>/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.equal(renderToStaticMarkup(React.createElement(ThinkingBlock, { text: '' })), '');
});
