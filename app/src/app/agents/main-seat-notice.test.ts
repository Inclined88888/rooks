import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MainSeatNotice } from './main-seat-notice';

// Sources are compiled with the classic JSX runtime, which reads a global `React`.
(globalThis as { React?: typeof React }).React = React;

test('empty seat: the warning offers each eligible agent the seat (TIM-0143)', () => {
  const html = renderToStaticMarkup(React.createElement(MainSeatNotice, { candidates: ['Themis', 'Zeus'] }));
  assert.match(html, /No main orchestrator/);
  assert.match(html, /Set Themis as main orchestrator/);
  assert.match(html, /Set Zeus as main orchestrator/);
});

test('empty seat with nobody eligible: the warning says how to make one, with no button (TIM-0143)', () => {
  const html = renderToStaticMarkup(React.createElement(MainSeatNotice, { candidates: [] }));
  assert.match(html, /No main orchestrator/);
  assert.match(html, /give the orchestrator role to an agent without a project/);
  assert.doesNotMatch(html, /<button/);
});
