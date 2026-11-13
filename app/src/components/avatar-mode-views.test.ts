/**
 * TODO #887: the views that drew an agent's head on their own follow its
 * picked mode (`config.avatar`, docs/AGENT-AVATAR.md) — the Multichat rail and
 * cell, the Agents graph's nodes, the mobile list. One view per family; the
 * chat's bubbles are in `lib/chat-bubble-avatar-mode.test.ts`, the mobile list
 * in `mobile-agent-list-avatar.test.ts` (it needs a DOM before react-dom loads).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentAvatar as RailAvatar } from '@/app/multichat/agent-side-rail';
import { graphNodeFace } from '@/lib/graph-face';
import type { AgentMeta } from '@/app/multichat/types';

Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });
const { createElement } = React;

const LOOK = { shape: 'hex', color: '#7ed957', eyes: 'code', acc: 'coffee' };
const FULL = { emoji: '🦊', icon_url: '/api/uploads/nova.png', look: LOOK };

function railHead(agent: Partial<AgentMeta>, project?: { slug: string; icon?: string | null }): string {
  const meta: AgentMeta = { name: 'nova', project: null, icon_url: null, emoji: null, color: null, role: 'coder', ...agent };
  return renderToStaticMarkup(createElement(RailAvatar, { agent: meta, project, color: '#123456', state: undefined }));
}

test('Multichat rail: a picture or the initial, never a mascot or an emoji', () => {
  for (const avatar of ['mascot', 'emoji', 'image', undefined] as const) {
    const html = railHead({ ...FULL, avatar });
    assert.match(html, /data-agent-head="disc"/);
    assert.doesNotMatch(html, /data-agent-mascot|🦊/);
    assert.match(html, /<img[^>]+nova\.png/);
  }
  assert.match(railHead({ look: LOOK, emoji: '🦊' }, { slug: 'acme', icon: '/api/uploads/acme.png' }), /<img[^>]+acme\.png/);
  assert.match(railHead({ look: LOOK, emoji: '🦊' }), /class="uppercase"[^>]*>n</);
  assert.doesNotMatch(railHead({ look: LOOK, emoji: '🦊' }), /data-agent-mascot|🦊/);
  assert.match(railHead({}), /class="uppercase"[^>]*>n</);
});

test('Agents graph: a picture, or the node\'s own initials', () => {
  const agent = { name: 'nova', role: 'coder', ...FULL };
  assert.deepEqual(graphNodeFace({ ...agent, avatar: 'mascot' }, null), { iconUrl: '/api/uploads/nova.png', look: null, glyph: null });
  assert.deepEqual(graphNodeFace({ ...agent, avatar: 'emoji' }, null), { iconUrl: '/api/uploads/nova.png', look: null, glyph: null });
  assert.deepEqual(graphNodeFace({ ...agent, avatar: 'image' }, null), { iconUrl: '/api/uploads/nova.png', look: null, glyph: null });
  assert.equal(graphNodeFace(agent, null).iconUrl, '/api/uploads/nova.png');
  assert.equal(graphNodeFace({ name: 'nova', look: LOOK }, { icon: '/api/uploads/acme.png' }).iconUrl, '/api/uploads/acme.png');
  assert.equal(graphNodeFace({ name: 'nova', look: LOOK }, null).look, null);
  assert.deepEqual(graphNodeFace({ name: 'nova' }, { icon: '🚀' }), { iconUrl: null, look: null, glyph: null });
  assert.deepEqual(graphNodeFace({ name: 'nova' }, null), { iconUrl: null, look: null, glyph: null }, 'the node writes its initials');
});
