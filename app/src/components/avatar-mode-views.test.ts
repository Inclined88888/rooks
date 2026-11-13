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
const FULL = { emoji: '🦊', icon_url: '/api/uploads/rooks.png', look: LOOK };

function railHead(agent: Partial<AgentMeta>, project?: { slug: string; icon?: string | null }): string {
  const meta: AgentMeta = { name: 'rooks', project: null, icon_url: null, emoji: null, color: null, role: 'coder', ...agent };
  return renderToStaticMarkup(createElement(RailAvatar, { agent: meta, project, color: '#123456', state: undefined }));
}

test('Multichat rail: the picked head, then the historical order', () => {
  const mascot = railHead({ ...FULL, avatar: 'mascot' });
  assert.match(mascot, /data-agent-head="mascot"/);
  assert.match(mascot, /data-agent-mascot/);
  assert.doesNotMatch(mascot, /<img/);

  const emoji = railHead({ ...FULL, avatar: 'emoji' });
  assert.doesNotMatch(emoji, /data-agent-mascot|<img/);
  assert.match(emoji, />🦊</);

  assert.match(railHead({ ...FULL, avatar: 'image' }), /<img[^>]+rooks\.png/);
  // No pick: picture, then project logo, then mascot, then emoji, then initial (upper-cased by CSS).
  assert.match(railHead(FULL), /<img[^>]+rooks\.png/);
  assert.match(railHead({ look: LOOK, emoji: '🦊' }, { slug: 'acme', icon: '/api/uploads/acme.png' }), /<img[^>]+acme\.png/);
  assert.match(railHead({ look: LOOK, emoji: '🦊' }), /data-agent-mascot/);
  assert.match(railHead({}), /class="uppercase"[^>]*>r</);
});

test('Agents graph: a node shows the picked head, its own initials when it has nothing', () => {
  const agent = { name: 'rooks', role: 'coder', ...FULL };
  const mascot = graphNodeFace({ ...agent, avatar: 'mascot' }, null);
  assert.equal(mascot.iconUrl, null);
  assert.equal(mascot.look?.shape, 'hex');
  assert.deepEqual(graphNodeFace({ ...agent, avatar: 'emoji' }, null), { iconUrl: null, look: null, glyph: '🦊' });
  assert.deepEqual(graphNodeFace({ ...agent, avatar: 'image' }, null), { iconUrl: '/api/uploads/rooks.png', look: null, glyph: null });
  // Historical order without a pick.
  assert.equal(graphNodeFace(agent, null).iconUrl, '/api/uploads/rooks.png');
  assert.equal(graphNodeFace({ name: 'rooks', look: LOOK }, { icon: '/api/uploads/acme.png' }).iconUrl, '/api/uploads/acme.png');
  assert.equal(graphNodeFace({ name: 'rooks', look: LOOK }, null).look?.shape, 'hex');
  assert.deepEqual(graphNodeFace({ name: 'rooks' }, { icon: '🚀' }), { iconUrl: null, look: null, glyph: '🚀' });
  assert.deepEqual(graphNodeFace({ name: 'rooks' }, null), { iconUrl: null, look: null, glyph: null }, 'the node writes its initials');
});
