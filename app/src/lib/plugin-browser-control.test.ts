/**
 * `browser:control` (TODO #461): the `command()` of `useBrowserChrome()` drives
 * a signed-in session through the user's own route, so the browser half gates
 * it on the manifest of the plugin whose slot entry is painting.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToString } from 'react-dom/server';
import type { sseOn } from './sse-stream';
import { mountBundledClients } from '../plugins-client/mount';
import { clientContext } from './plugin-host/loader';
import {
  BROWSER_CONTROL_PERMISSION, clientPluginHolds, grantClientPermissions, resetClientPermissionsForTests,
} from './plugin-host/plugin-permissions';
import { declareSlot, register, resetSlotsForTests } from './plugin-host/slots';
import {
  BROWSER_DRAWER_SLOT, BROWSER_TOOLBAR_SLOT, BrowserChromeProvider, BrowserDrawerSlot, BrowserToolbarSlot, useBrowserChrome,
  type BrowserChrome,
} from '@/components/browser-chrome';

const noSse: typeof sseOn = () => () => {};

function chrome(sent: string[]): BrowserChrome {
  return {
    profileId: 'crm', status: null, controlled: true, conversation: { agent: 'a', mission: null }, drawer: null,
    command: async <T,>(action: string) => { sent.push(action); return undefined as T; },
    openDrawer: () => {}, closeDrawer: () => {},
  };
}

/** Paints the toolbar and one drawer, and hands back what each occupant's hook returned. */
function paint(value: BrowserChrome, plugins: { toolbar: string; drawer: string }) {
  resetSlotsForTests();
  const read: Record<string, BrowserChrome | null> = {};
  const undeclare = [declareSlot(BROWSER_TOOLBAR_SLOT, 'list'), declareSlot(BROWSER_DRAWER_SLOT, 'keyed')];
  const disposers = [
    register({ slot: BROWSER_TOOLBAR_SLOT, pluginId: plugins.toolbar }, () => { read.toolbar = useBrowserChrome(); return null; }),
    register({ slot: BROWSER_DRAWER_SLOT, pluginId: plugins.drawer, key: 'd' }, () => { read.drawer = useBrowserChrome(); return null; }),
  ];
  function Outside() { read.outside = useBrowserChrome(); return null; }
  const children = [
    React.createElement(BrowserToolbarSlot, { key: 'toolbar' }),
    React.createElement(BrowserDrawerSlot, { key: 'drawer', entryKey: 'd', label: 'drawer' }),
    React.createElement(Outside, { key: 'outside' }),
  ];
  renderToString(React.createElement(BrowserChromeProvider, { value, children }));
  for (const dispose of disposers) dispose();
  for (const dispose of undeclare) dispose();
  return read;
}

test('an occupant whose plugin does not declare browser:control cannot drive the browser', async () => {
  resetClientPermissionsForTests();
  const sent: string[] = [];
  const revoke = grantClientPermissions('acme', ['browser:read', 'storage']);
  try {
    const read = paint(chrome(sent), { toolbar: 'acme', drawer: 'nobody' });
    for (const [where, pluginId] of [['toolbar', 'acme'], ['drawer', 'nobody']] as const) {
      const hook = read[where];
      assert.ok(hook, `${where}: the hook is there`);
      await assert.rejects(hook.command('navigate', { url: 'https://evil.example' }), (error: Error) => {
        assert.equal(error.name, 'BrowserControlDenied');
        assert.match(error.message, new RegExp(`plugin \`${pluginId}\`: command\\(\\) of useBrowserChrome\\(\\) needs the \`browser:control\` permission`));
        return true;
      });
      // Everything else stays readable.
      assert.equal(hook.profileId, 'crm');
      assert.equal(hook.controlled, true);
      assert.equal(typeof hook.openDrawer, 'function');
    }
    assert.deepEqual(sent, [], 'a refused command never reaches the engine');
  } finally {
    revoke();
  }
});

test('outside a slot entry, command() is refused too: no plugin identity, no control', async () => {
  resetClientPermissionsForTests();
  const sent: string[] = [];
  const read = paint(chrome(sent), { toolbar: 'acme', drawer: 'acme' });
  assert.ok(read.outside);
  await assert.rejects(read.outside.command('fillCredential'), /outside a browser\.toolbar \/ browser\.drawer entry/);
  assert.deepEqual(sent, []);
});

test('an occupant whose plugin declares browser:control drives the browser, and loses it with its grant', async () => {
  resetClientPermissionsForTests();
  const sent: string[] = [];
  const revoke = grantClientPermissions('acme', [BROWSER_CONTROL_PERMISSION]);
  const granted = paint(chrome(sent), { toolbar: 'acme', drawer: 'acme' });
  await granted.toolbar!.command('navigate', { url: 'https://crm.example' });
  await granted.drawer!.command('recordStatus');
  assert.deepEqual(sent, ['navigate', 'recordStatus']);
  revoke();
  const revoked = paint(chrome(sent), { toolbar: 'acme', drawer: 'acme' });
  await assert.rejects(revoked.toolbar!.command('navigate'), /browser:control/);
  assert.deepEqual(sent, ['navigate', 'recordStatus']);
});

test('the loader grants a third-party half its manifest permissions for the life of the load', () => {
  resetClientPermissionsForTests();
  const without = clientContext('plain', [], noSse);
  assert.equal(clientPluginHolds('plain', BROWSER_CONTROL_PERMISSION), false, 'nothing declared, nothing held');
  without.dispose();

  const first = clientContext('acme', [], noSse, [BROWSER_CONTROL_PERMISSION]);
  assert.equal(clientPluginHolds('acme', BROWSER_CONTROL_PERMISSION), true);
  // A reload: the new load is granted before the old one is gone; disposing the old one keeps the new grant.
  const second = clientContext('acme', [], noSse, [BROWSER_CONTROL_PERMISSION]);
  first.dispose();
  assert.equal(clientPluginHolds('acme', BROWSER_CONTROL_PERMISSION), true);
  second.dispose();
  assert.equal(clientPluginHolds('acme', BROWSER_CONTROL_PERMISSION), false, 'an unloaded plugin holds nothing');
  assert.equal(clientPluginHolds(null, BROWSER_CONTROL_PERMISSION), false);
});

test('a bundled half holds browser:control only when it declares it, while it is mounted', () => {
  resetClientPermissionsForTests();
  resetSlotsForTests();
  const apply = () => {};
  const off = mountBundledClients(null, [
    { module: '@rooks/browser-recording', permissions: [BROWSER_CONTROL_PERMISSION], apply },
    { module: '@rooks/browser-embedded', apply },
  ]);
  assert.equal(clientPluginHolds('@rooks/browser-recording', BROWSER_CONTROL_PERMISSION), true);
  assert.equal(clientPluginHolds('@rooks/browser-embedded', BROWSER_CONTROL_PERMISSION), false, 'being bundled is not a grant');
  off();
  assert.equal(clientPluginHolds('@rooks/browser-recording', BROWSER_CONTROL_PERMISSION), false, 'switched off, it holds nothing');
});

test('the client name is the daemon\'s, and the daemon classifies it sensitive', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, '..', '..', '..', 'orchestrator', 'src', 'plugins', 'manifest.ts'), 'utf8');
  const sensitive = /export const SENSITIVE_PLUGIN_PERMISSIONS = Object\.freeze\(\[([\s\S]*?)\] as const/.exec(source);
  assert.ok(sensitive, 'SENSITIVE_PLUGIN_PERMISSIONS not found');
  assert.match(sensitive[1] ?? '', new RegExp(`'${BROWSER_CONTROL_PERMISSION}'`));
});
