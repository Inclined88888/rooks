/**
 * The chat card's faces (`visageAgent`, `FaceAgent`) follow the head an agent
 * picked (docs/AGENT-AVATAR.md); without a pick, or without its setting, this
 * view's own order is unchanged, and a photo set on the card still wins.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { visageAgent, type AgentChoisissable } from './use-agents';
import { FaceAgent } from './agent-avatar';

// The test runner compiles JSX to `React.createElement`.
Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });

const LOOK = { shape: 'hex', color: '#7ed957', eyes: 'code', acc: 'coffee' };
const rooks = (extra: Partial<AgentChoisissable>): AgentChoisissable[] => [{ name: 'rooks', emoji: '🦊', icon_url: '/api/uploads/rooks.png', look: LOOK, project: 'acme', ...extra }];
const PROJECTS = [{ slug: 'acme', icon: '/api/uploads/acme.png' }];

test('a picked head wins in the card; a card photo wins over it; no pick keeps the card\'s order', () => {
  assert.deepEqual(visageAgent('rooks', rooks({ avatar: 'mascot' }), PROJECTS).look, LOOK);
  assert.equal(visageAgent('rooks', rooks({ avatar: 'emoji' }), PROJECTS).glyphe, '🦊');
  assert.equal(visageAgent('rooks', rooks({ avatar: 'emoji' }), PROJECTS).image, null);
  assert.equal(visageAgent('rooks', rooks({ avatar: 'image' }), PROJECTS).image, '/api/uploads/rooks.png');
  assert.equal(visageAgent('rooks', rooks({ avatar: 'mascot' }), PROJECTS, '/api/uploads/card.png').image, '/api/uploads/card.png', 'the card\'s own photo');
  for (const avatar of [undefined, null, 'hologram']) {
    const v = visageAgent('rooks', rooks({ avatar }), PROJECTS);
    assert.equal(v.image, '/api/uploads/rooks.png');
    assert.equal(v.look, undefined, 'no mascot appears by itself');
  }
  assert.equal(visageAgent('rooks', rooks({ avatar: 'mascot', look: null, icon_url: null }), PROJECTS).image, '/api/uploads/acme.png', 'a pick without its setting: the order');
});

test('FaceAgent paints the mascot of a visage that has one', () => {
  const html = renderToStaticMarkup(React.createElement(FaceAgent, { visage: visageAgent('rooks', rooks({ avatar: 'mascot' }), PROJECTS) }));
  assert.match(html, /data-agent-mascot/);
  assert.match(html, /<svg/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(FaceAgent, { visage: visageAgent('rooks', rooks({}), PROJECTS) })), /data-agent-mascot/);
});
