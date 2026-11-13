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

test('a card shows a picture or the initial, and a card photo wins', () => {
  const mascot = visageAgent('nova', nova({ avatar: 'mascot' }), PROJECTS);
  assert.equal(mascot.look, undefined);
  assert.equal(mascot.image, '/api/uploads/nova.png');
  assert.equal(mascot.glyphe, 'n');
  const emoji = visageAgent('nova', nova({ avatar: 'emoji' }), PROJECTS);
  assert.equal(emoji.glyphe, 'n');
  assert.equal(emoji.image, '/api/uploads/nova.png');
  assert.equal(visageAgent('nova', nova({ avatar: 'image' }), PROJECTS).image, '/api/uploads/nova.png');
  assert.equal(visageAgent('nova', nova({ avatar: 'mascot' }), PROJECTS, '/api/uploads/card.png').image, '/api/uploads/card.png', 'the card\'s own photo');
  for (const avatar of [undefined, null, 'hologram']) {
    const v = visageAgent('nova', nova({ avatar }), PROJECTS);
    assert.equal(v.image, '/api/uploads/nova.png');
    assert.equal(v.look, undefined);
  }
  const bare = visageAgent('nova', nova({ avatar: 'mascot', look: null, icon_url: null, emoji: '🦊' }), PROJECTS);
  assert.equal(bare.image, '/api/uploads/acme.png');
  assert.equal(bare.glyphe, 'n');
});

test('FaceAgent paints a picture or a letter, never a mascot', () => {
  const html = renderToStaticMarkup(React.createElement(FaceAgent, { visage: visageAgent('nova', nova({ avatar: 'mascot' }), PROJECTS), agent: 'nova' }));
  assert.doesNotMatch(html, /data-agent-mascot|<svg/);
  assert.match(html, /<img[^>]+nova\.png/);
  const letter = renderToStaticMarkup(React.createElement(FaceAgent, { visage: { image: null, glyphe: '🦊', couleur: '#123', look: LOOK }, agent: 'nova' }));
  assert.doesNotMatch(letter, /data-agent-mascot|🦊/);
  assert.match(letter, />n</);
});
