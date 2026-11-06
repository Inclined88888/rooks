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
const nova = (extra: Partial<AgentChoisissable>): AgentChoisissable[] => [{ name: 'nova', emoji: '🦊', icon_url: '/api/uploads/nova.png', look: LOOK, project: 'acme', ...extra }];
const PROJECTS = [{ slug: 'acme', icon: '/api/uploads/acme.png' }];

test('a picked head wins in the card; a card photo wins over it; no pick keeps the card\'s order', () => {
  assert.deepEqual(visageAgent('nova', nova({ avatar: 'mascot' }), PROJECTS).look, LOOK);
  assert.equal(visageAgent('nova', nova({ avatar: 'emoji' }), PROJECTS).glyphe, '🦊');
  assert.equal(visageAgent('nova', nova({ avatar: 'emoji' }), PROJECTS).image, null);
  assert.equal(visageAgent('nova', nova({ avatar: 'image' }), PROJECTS).image, '/api/uploads/nova.png');
  assert.equal(visageAgent('nova', nova({ avatar: 'mascot' }), PROJECTS, '/api/uploads/card.png').image, '/api/uploads/card.png', 'the card\'s own photo');
  for (const avatar of [undefined, null, 'hologram']) {
    const v = visageAgent('nova', nova({ avatar }), PROJECTS);
    assert.equal(v.image, '/api/uploads/nova.png');
    assert.equal(v.look, undefined, 'no mascot appears by itself');
  }
  assert.equal(visageAgent('nova', nova({ avatar: 'mascot', look: null, icon_url: null }), PROJECTS).image, '/api/uploads/acme.png', 'a pick without its setting: the order');
});

test('FaceAgent paints the mascot of a visage that has one', () => {
  const html = renderToStaticMarkup(React.createElement(FaceAgent, { visage: visageAgent('nova', nova({ avatar: 'mascot' }), PROJECTS) }));
  assert.match(html, /data-agent-mascot/);
  assert.match(html, /<svg/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(FaceAgent, { visage: visageAgent('nova', nova({}), PROJECTS) })), /data-agent-mascot/);
});
