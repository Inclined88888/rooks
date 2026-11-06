import assert from 'node:assert/strict';
import test from 'node:test';
import { isNavItemActive } from './nav-active';
import React from 'react';
import { register, resetSlotsForTests, slotEntries } from './plugin-host/slots';
import { UI_LAYOUT_CHILD_SLOTS } from './plugin-host/ui-layout';
import { mountBundledClients } from '@/plugins-client/mount';

// Sources are compiled with the classic JSX runtime, which reads a global `React`.
(globalThis as { React?: typeof React }).React = React;

test('an entry is lit on its own route and below it', () => {
  assert.equal(isNavItemActive('/agents', '/agents'), true);
  assert.equal(isNavItemActive('/agents/x', '/agents'), true);
  assert.equal(isNavItemActive('/agentsx', '/agents'), false);
  assert.equal(isNavItemActive(null, '/agents'), false);
});

test('an alias route lights the entry, its subpaths too, and nothing else does', () => {
  assert.equal(isNavItemActive('/chat', '/agents', ['/chat']), true);
  assert.equal(isNavItemActive('/chat/abc', '/agents', ['/chat']), true);
  assert.equal(isNavItemActive('/chat', '/agents'), false);
  assert.equal(isNavItemActive('/chatter', '/agents', ['/chat']), false);
});

test('the Agents entry, as mounted, lights on /chat', () => {
  resetSlotsForTests();
  register({ slot: 'root', pluginId: '@timon/ui-layout', children: UI_LAYOUT_CHILD_SLOTS }, () => null);
  mountBundledClients(null);
  const entry = slotEntries('nav.item').find((e) => e.pluginId === '@timon/agents' && e.order === 30);
  assert.ok(entry, 'the Agents nav entry is registered');
  const element = (entry.Component as unknown as () => React.ReactElement<{ href: string; activeRoutes?: string[] }>)();
  assert.equal(element.props.href, '/agents');
  assert.deepEqual(element.props.activeRoutes, ['/chat']);
});
