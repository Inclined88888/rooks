import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAgentsView } from '../app/agents/view-mode';
import { declareLayoutSlots } from './plugin-host/client-plugin-host';
import { resetSlotsForTests, slotEntry, register, slotKind } from './plugin-host/slots';
import { mountBundledClients } from '../plugins-client/mount';
import { isSlotAdmissible } from './plugin-host/slot-compat';
import type { Capabilities } from './capabilities';

test('old Grid links and preferences resolve to Projects', () => {
  assert.equal(normalizeAgentsView('grid'), 'projects');
  for (const view of ['canvas', 'projects', 'company']) assert.equal(normalizeAgentsView(view), view);
  assert.equal(normalizeAgentsView('missing'), null);
});

test('Projects is independently disabled and restored through plugin lifecycle', () => {
  resetSlotsForTests();
  declareLayoutSlots();
  const dispose = mountBundledClients(null);
  assert.equal(slotEntry('agents.view', 'projects')?.pluginId, '@timon/agents-projects');
  dispose();
  const caps: Capabilities = { edition: 'full', profile: 'local', capabilities: [], modules: [{ id: '@timon/agents-projects', tier: 'std', active: false, reason: 'disabled', missing: [] }], ui: { hidden: [], home: '/' }, kernel: true, developer: { unsignedPlugins: false } };
  const off = mountBundledClients(caps);
  assert.equal(slotEntry('agents.view', 'projects'), null);
  assert.equal(slotKind('agents.left.widget'), 'list', 'the sidebar hosts survive removing a view');
  off();
  const on = mountBundledClients(null);
  assert.ok(slotEntry('agents.view', 'projects'));
  on();
});

test('Company is an exact plugin slot and disappears when its package is disposed', () => {
  resetSlotsForTests();
  declareLayoutSlots();
  assert.equal(isSlotAdmissible(['cockpit.widget'], 'agents.view'), false);
  assert.equal(isSlotAdmissible(['agents.view'], 'agents.view'), true);
  const dispose = register({ slot: 'agents.view', key: 'company', pluginId: 'company' }, () => null);
  assert.equal(slotEntry('agents.view', 'company')?.pluginId, 'company');
  dispose();
  assert.equal(slotEntry('agents.view', 'company'), null);
});

test('Company ships with the app but stays hidden until its ui option says otherwise', () => {
  resetSlotsForTests();
  declareLayoutSlots();
  // Beta 12/09/2026: the module ships and runs, its surfaces do not.
  const dispose = mountBundledClients(null);
  assert.equal(slotEntry('agents.view', 'company'), null);
  assert.equal(slotEntry('page', '/company'), null);
  dispose();
  const caps: Capabilities = { edition: 'full', profile: 'local', capabilities: [], modules: [{ id: '@timon/company', tier: 'std', active: false, reason: 'disabled', missing: [] }], ui: { hidden: [], home: '/' }, kernel: true, developer: { unsignedPlugins: false } };
  const off = mountBundledClients(caps);
  assert.equal(slotEntry('agents.view', 'company'), null);
  off();
});

test('Company comes back whole when the config opts into its ui option', () => {
  resetSlotsForTests();
  declareLayoutSlots();
  const caps: Capabilities = { edition: 'full', profile: 'local', capabilities: [], modules: [{ id: '@timon/company', tier: 'std', active: true, reason: null, missing: [], options: { ui: true } }], ui: { hidden: [], home: '/' }, kernel: true, developer: { unsignedPlugins: false } };
  const on = mountBundledClients(caps);
  assert.equal(slotEntry('agents.view', 'company')?.pluginId, '@timon/company');
  assert.equal(slotEntry('page', '/company')?.pluginId, '@timon/company');
  on();
  assert.equal(slotEntry('agents.view', 'company'), null);
});
