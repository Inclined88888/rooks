/**
 * A mascot is its own frame: no border, ring or round fill around it, in the
 * shared avatar and in the frames the agent-chat views put around `FaceAgent`.
 * An emoji or a picture keeps its round disc, and a working agent keeps its
 * animated pulse whatever its head.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { ActiveAgentAvatar, AgentAvatar, agentIdentity } from './agent-avatar';
import { FramedFace, faceFrame } from '@/plugins-client/agent-chat/agent-avatar';
import type { Visage } from '@/plugins-client/agent-chat/use-agents';

// The test runner compiles JSX to `React.createElement`.
Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });
const { createElement } = React;

const LOOK = { shape: 'hex', color: '#7ed957', eyes: 'code', acc: 'coffee' } as const;
const mascot = agentIdentity({ name: 'rooks', role: 'coder', look: LOOK, avatar: 'mascot' }, null);
const emoji = agentIdentity({ name: 'rooks', role: 'coder', emoji: '🦊', avatar: 'emoji' }, null);

function dom(element: React.ReactElement): Document {
  return new JSDOM(`<div id="root">${renderToStaticMarkup(element)}</div>`).window.document;
}

/** Elements that draw a round frame: a border, a ring, or a filled disc. */
function frames(doc: Document): Element[] {
  return Array.from(doc.querySelectorAll('[class]')).filter((el) => {
    const cls = el.getAttribute('class') ?? '';
    return /(^|\s)(border|ring-\d|bg-\[var\(--accent-soft\)\]|bg-card|bg-muted)(\s|$)/.test(cls);
  });
}

test('a mascot avatar wears no frame; an emoji keeps its round disc', () => {
  const m = dom(createElement(AgentAvatar, { identity: mascot, roleBadge: false }));
  assert.ok(m.querySelector('[data-agent-mascot] svg'), 'the mascot is drawn');
  assert.deepEqual(frames(m), [], 'nothing around it');

  const e = dom(createElement(AgentAvatar, { identity: emoji, roleBadge: false }));
  const disc = e.querySelector('#root > div > div')!;
  assert.match(disc.getAttribute('class') ?? '', /rounded-\[var\(--avatar-radius\)\] border/);
  assert.equal(disc.textContent, '🦊');
});

test('a working mascot keeps its pulse but loses the static ring; an emoji keeps both', () => {
  const m = dom(createElement(ActiveAgentAvatar, { identity: mascot, state: 'thinking' }));
  assert.ok(m.querySelector('[data-chip-pulse]'), 'the activity pulse is still there');
  assert.match(m.querySelector('[data-chip-pulse]')!.getAttribute('class') ?? '', /animate-\[ping/);
  assert.ok(!m.querySelector('[data-chip-ring]'), 'no static circle around the mascot');

  const e = dom(createElement(ActiveAgentAvatar, { identity: emoji, state: 'thinking' }));
  assert.ok(e.querySelector('[data-chip-pulse]'));
  assert.ok(e.querySelector('[data-chip-ring]'), 'an emoji keeps its state ring');

  // At rest nothing is painted around either.
  const idle = dom(createElement(ActiveAgentAvatar, { identity: emoji, state: 'idle' }));
  assert.ok(!idle.querySelector('[data-chip-ring]'));
});

test('the agent-chat frame drops for a mascot and stays for a glyph or a picture', () => {
  const face: Visage = { image: null, glyphe: 'n', couleur: '#123456', look: { ...LOOK } };
  const glyph: Visage = { image: null, glyphe: 'n', couleur: '#123456', look: null };
  const picture: Visage = { image: '/api/uploads/rooks.png', glyphe: 'n', couleur: '#123456' };
  assert.equal(faceFrame(face, 'rounded-full border'), undefined);
  assert.equal(faceFrame(glyph, 'rounded-full border'), 'rounded-full border');
  assert.equal(faceFrame(picture, 'rounded-full border'), 'rounded-full border');

  const m = dom(createElement(FramedFace, { visage: face, className: 'size-6' }));
  assert.ok(m.querySelector('[data-agent-mascot]'));
  assert.deepEqual(frames(m), []);
  const g = dom(createElement(FramedFace, { visage: glyph, className: 'size-6' }));
  assert.match(g.querySelector('#root > span')!.getAttribute('class') ?? '', /rounded-full border border-border bg-card/);
});
