/**
 * A multichat cell's link to the full chat on its mission (SUG-0055): there
 * only once the cell has a mission, and pointing at that agent and mission.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OpenMissionLink } from '../app/multichat/open-mission-link';
import { chatHref } from './chat-island-params';

// The test runner compiles JSX to `React.createElement`, a global here.
Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });

const render = (missionId: string | null | undefined) =>
  renderToStaticMarkup(React.createElement(OpenMissionLink, { agent: 'rooks.coder', missionId }));

test('a cell without a mission shows no link', () => {
  assert.equal(render(null), '');
  assert.equal(render(undefined), '');
  assert.equal(render(''), '');
});

test('a cell with a mission links to the chat on that agent and mission, labelled', () => {
  const html = render('m-42');
  assert.match(html, /href="\/chat\?agent=rooks\.coder&amp;mission=m-42"/);
  assert.match(html, /aria-label="Open this mission in the chat"/);
  assert.match(html, /title="Open this mission in the chat"/);
});

test('the link is built by chatHref, names escaped', () => {
  assert.equal(chatHref('a b', 'm/1'), '/chat?agent=a%20b&mission=m%2F1');
  assert.equal(chatHref('a', null), '/chat?agent=a');
  const html = renderToStaticMarkup(React.createElement(OpenMissionLink, { agent: 'a b', missionId: 'm/1' }));
  assert.match(html, /href="\/chat\?agent=a%20b&amp;mission=m%2F1"/);
});

test('the cell header mounts it with the mission the chat reported', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'app', 'multichat', 'chat-slot.tsx'), 'utf8');
  assert.match(src, /<OpenMissionLink agent=\{agent\.name\} missionId=\{missionId\} \/>/);
});
