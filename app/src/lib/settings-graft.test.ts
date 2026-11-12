import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { clientContext } from './plugin-host/loader';
import { NativeCategoryGraft } from './plugin-host/settings-graft';
import { UI_LAYOUT_CHILD_SLOTS } from './plugin-host/ui-layout';
import { register, resetSlotsForTests, slotEntries } from './plugin-host/slots';

const Empty = () => React.createElement('div');

function mountLayout(): void {
  resetSlotsForTests();
  register({ slot: 'root', pluginId: '@rooks/ui-layout', children: UI_LAYOUT_CHILD_SLOTS }, Empty);
}

function paint(group: string): string {
  return renderToStaticMarkup(React.createElement(NativeCategoryGraft, { group }));
}

test('a plugin declared for settings.missions appears in that slot', () => {
  mountLayout();
  const graft = clientContext('missions-graft', ['settings.missions']);
  graft.slots.register({ slot: 'settings.missions' }, Empty);
  assert.equal(slotEntries('settings.missions').length, 1);
});

test('a cockpit.widget is refused by a settings graft slot', () => {
  mountLayout();
  const widget = clientContext('widget-only', ['cockpit.widget']);
  assert.throws(
    () => widget.slots.register({ slot: 'settings.missions' }, Empty),
    /is not allowed in slot settings\.missions/,
  );
  assert.equal(slotEntries('settings.missions').length, 0);
});

test('an empty native-category graft paints nothing', () => {
  mountLayout();
  const html = paint('Missions');
  assert.equal(html, '');
  assert.doesNotMatch(html, /data-slot-region/);
});

test('a graft occupies the native pane after the product rows, without a card frame', () => {
  mountLayout();
  const graft = clientContext('missions-graft', ['settings.missions']);
  graft.slots.register(
    { slot: 'settings.missions' },
    () => React.createElement('p', null, 'grafted row'),
  );
  const html = paint('Missions');
  assert.match(html, /data-slot-region="settings.missions"/);
  assert.match(html, /grafted row/);
  assert.doesNotMatch(html, /border-border/);
  assert.doesNotMatch(html, /Plugins/);
});

test('Push paints settings.notifications, not a slugified name', () => {
  mountLayout();
  const graft = clientContext('push-graft', ['settings.notifications']);
  graft.slots.register(
    { slot: 'settings.notifications' },
    () => React.createElement('p', null, 'push graft'),
  );
  const html = paint('Push');
  assert.match(html, /data-slot-region="settings.notifications"/);
  assert.doesNotMatch(html, /settings\.push/);
});
