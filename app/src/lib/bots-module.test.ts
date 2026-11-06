import assert from 'node:assert/strict';
import test from 'node:test';
import { declareLayoutSlots } from './plugin-host/client-plugin-host';
import { resetSlotsForTests, slotEntry, slotEntries } from './plugin-host/slots';
import { mountBundledClients } from '../plugins-client/mount';
import type { Capabilities } from './capabilities';

const botsNav = () => slotEntries('nav.item').filter((e) => e.pluginId === '@timon/bots');

test('switching @timon/bots off takes both its nav entry and its page away', () => {
  resetSlotsForTests();
  declareLayoutSlots();
  const on = mountBundledClients(null);
  assert.equal(slotEntry('page', '/bots')?.pluginId, '@timon/bots');
  assert.equal(botsNav().length, 1);
  on();
  const caps: Capabilities = { edition: 'full', profile: 'local', capabilities: [], modules: [{ id: '@timon/bots', tier: 'std', active: false, reason: 'disabled', missing: [] }], ui: { hidden: [], home: '/' }, kernel: true, developer: { unsignedPlugins: false } };
  const off = mountBundledClients(caps);
  assert.equal(slotEntry('page', '/bots'), null, '/bots is no longer reachable by URL');
  assert.equal(botsNav().length, 0);
  off();
});
