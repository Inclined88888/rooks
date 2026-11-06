import assert from 'node:assert/strict';
import test from 'node:test';
import React, { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SetupComposer } from './setup-composer';
import type { ChatComposerValue } from './composer';

// The components of this tree rely on the automatic JSX runtime; the test runner compiles classic.
Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });

function value(over: Partial<ChatComposerValue> = {}): ChatComposerValue {
  return {
    agent: { name: 'nova', model: 'sonnet', kind: 'live', status: 'idle' },
    liveStats: { model: null },
    currentMissionId: 'm1',
    pendingModelOverride: null,
    pendingBackendOverride: null,
    effBackend: 'claude',
    effModel: 'sonnet',
    modelSwitching: false,
    setLlmOpen: () => {},
    applyLlm: async () => {},
    pendingReasoningEffort: null,
    missionReasoningEffort: null,
    applyReasoningEffort: async () => {},
    dense: false,
    narrow: false,
    input: '',
    setInput: () => {},
    placeholder: 'Write…',
    send: () => {},
    taRef: createRef<HTMLTextAreaElement>(),
    recording: false,
    toggleDictation: () => {},
    dictationUnavailable: false,
    thinking: false,
    ...over,
  } as unknown as ChatComposerValue;
}

test('the setup composer holds the field, the model, the voice and send — nothing else', () => {
  const html = renderToStaticMarkup(createElement(SetupComposer, { value: value() }));
  assert.match(html, /data-setup-composer/);
  assert.equal((html.match(/<textarea/g) ?? []).length, 1);
  // model, voice, send
  assert.equal((html.match(/<button/g) ?? []).length, 3);
  assert.doesNotMatch(html, /type="file"/);
  assert.doesNotMatch(html, /terminal|attach|Paperclip/i);
});

test('without a speech service the voice button is not offered; send waits for text', () => {
  const html = renderToStaticMarkup(createElement(SetupComposer, { value: value({ dictationUnavailable: true }) }));
  assert.equal((html.match(/<button/g) ?? []).length, 2);
  assert.match(html, /disabled/);
});
