/**
 * A face is a picture or the agent's initial. A stored mascot or emoji is not drawn.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentAvatar, agentIdentity, lookOfAgent } from './agent-avatar';
import { defaultLookFor } from './mascot/agent-look';

// The test runner compiles JSX to `React.createElement`.
Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });
const { createElement } = React;

test('the look an agent row carries: none without one, checked field by field with one', () => {
  assert.equal(lookOfAgent({ look: null, role: 'coder' }), null);
  assert.equal(lookOfAgent({ role: 'coder' }), null);
  assert.deepEqual(lookOfAgent({ look: { shape: 'round', color: '#D4A373', eyes: 'happy', acc: 'coffee' } }), { shape: 'round', color: '#d4a373', eyes: 'happy', acc: 'coffee' });
  const coder = defaultLookFor('coder');
  assert.deepEqual(lookOfAgent({ look: { shape: 'round', acc: 'sword' }, role: 'coder' }), { ...coder, shape: 'round' }, 'an unknown tool falls back to the role\'s');
});

test('a picture is the face; without one, the initial, never a mascot or an emoji', () => {
  const look = { shape: 'hex', color: '#7ed957', eyes: 'code', acc: 'coffee' };
  const stored = renderToStaticMarkup(createElement(AgentAvatar, { identity: agentIdentity({ name: 'nova', role: 'coder', look, avatar: 'mascot' }, null) }));
  assert.doesNotMatch(stored, /data-agent-mascot/);
  assert.match(stored, /<span>n<\/span>/);
  const picture = renderToStaticMarkup(createElement(AgentAvatar, { identity: agentIdentity({ name: 'nova', look, icon_url: '/api/uploads/nova.png', avatar: 'mascot' }, null) }));
  assert.doesNotMatch(picture, /data-agent-mascot/);
  assert.match(picture, /<img[^>]+nova\.png/);
  const initial = renderToStaticMarkup(createElement(AgentAvatar, { identity: agentIdentity({ name: 'nova', emoji: '🦊' }, null) }));
  assert.doesNotMatch(initial, /🦊|data-agent-mascot/);
  assert.match(initial, /<span>n<\/span>/);
});

test('a picture on the agent or the project wins; otherwise the initial', () => {
  const look = { shape: 'hex', color: '#7ed957', eyes: 'code', acc: 'coffee' };
  const project = { icon: '/api/uploads/acme.png', color: '#123456' } as Parameters<typeof agentIdentity>[1];
  const head = (agent: Omit<Parameters<typeof agentIdentity>[0], 'name'>, p: Parameters<typeof agentIdentity>[1] = null) =>
    renderToStaticMarkup(createElement(AgentAvatar, { identity: agentIdentity({ ...agent, name: 'nova' }, p) }));
  const full = { look, emoji: '🦊', icon_url: '/api/uploads/nova.png' };

  for (const avatar of ['mascot', 'emoji', 'image', undefined, null, 'hologram'] as const) {
    assert.match(head({ ...full, avatar }), /<img[^>]+nova\.png/, `the agent's picture (${String(avatar)})`);
    assert.doesNotMatch(head({ ...full, avatar }), /data-agent-mascot|🦊/);
  }
  assert.match(head({ look, emoji: '🦊' }, project), /<img[^>]+acme\.png/);
  assert.match(head({ look, emoji: '🦊' }), /<span>n<\/span>/);
  assert.match(head({ emoji: '🦊' }), /<span>n<\/span>/);
  assert.doesNotMatch(head({ emoji: '🦊' }, { icon: '🚀' }), /🚀/);
});
