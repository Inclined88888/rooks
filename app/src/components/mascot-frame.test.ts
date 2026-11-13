/**
 * A face is a round disc: a picture or an initial. A working agent keeps its
 * state ring and its pulse.
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
const mascot = agentIdentity({ name: 'nova', role: 'coder', look: LOOK, avatar: 'mascot' }, null);
const emoji = agentIdentity({ name: 'nova', role: 'coder', emoji: '🦊', avatar: 'emoji' }, null);

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

test('an initial and a stored mascot both wear the round disc', () => {
  const m = dom(createElement(AgentAvatar, { identity: mascot, roleBadge: false }));
  assert.ok(!m.querySelector('[data-agent-mascot]'));
  assert.equal(m.querySelector('#root > div > div')?.textContent, 'n');

  const e = dom(createElement(AgentAvatar, { identity: emoji, roleBadge: false }));
  const disc = e.querySelector('#root > div > div')!;
  assert.match(disc.getAttribute('class') ?? '', /rounded-\[var\(--avatar-radius\)\] border/);
  assert.equal(disc.textContent, 'n');
});

test('a working agent has no glow ring and no pulse', () => {
  const m = dom(createElement(ActiveAgentAvatar, { identity: mascot, state: 'thinking' }));
  assert.equal(m.querySelector('[data-chip-pulse]'), null);
  assert.equal(m.querySelector('[data-chip-ring]'), null);
  assert.ok(m.querySelector('[data-chip-avatar]'));
});

test('the agent-chat frame stays for a stored look, a letter and a picture', () => {
  const face: Visage = { image: null, glyphe: 'n', couleur: '#123456', look: { ...LOOK } };
  const glyph: Visage = { image: null, glyphe: 'n', couleur: '#123456', look: null };
  const picture: Visage = { image: '/api/uploads/nova.png', glyphe: 'n', couleur: '#123456' };
  assert.equal(faceFrame(face, 'rounded-full border'), 'rounded-full border');
  assert.equal(faceFrame(glyph, 'rounded-full border'), 'rounded-full border');
  assert.equal(faceFrame(picture, 'rounded-full border'), 'rounded-full border');

  const m = dom(createElement(FramedFace, { visage: face, className: 'size-6' }));
  assert.ok(!m.querySelector('[data-agent-mascot]'));
  assert.match(m.querySelector('#root > span')!.getAttribute('class') ?? '', /rounded-full border border-border bg-card/);
  const g = dom(createElement(FramedFace, { visage: glyph, className: 'size-6' }));
  assert.match(g.querySelector('#root > span')!.getAttribute('class') ?? '', /rounded-full border border-border bg-card/);
});
