import assert from 'node:assert/strict';
import test from 'node:test';
import type { Capabilities } from '@/lib/capabilities';
import { setupLanding, welcomeLanding } from './setup-landing';
import { MAIN_AGENT_REPAIR_PATH, WELCOME_PATH } from '@/lib/first-run-gate';

function caps(over: Partial<Capabilities> = {}): Capabilities {
  return {
    edition: 'beta', profile: 'expert', capabilities: [], kernel: true,
    modules: [{ id: '@rooks/bots', active: true }] as Capabilities['modules'],
    ui: { hidden: [], home: 'cockpit' }, developer: { unsignedPlugins: false },
    ...over,
  };
}

test('onboarding lands on /bots', () => {
  assert.equal(setupLanding(caps()), '/bots');
  assert.equal(setupLanding(caps({ surfaces: { all: true } as Capabilities['surfaces'] })), '/bots');
});

test('the cockpit when /bots is out of reach', () => {
  assert.equal(setupLanding(null), '/');
  assert.equal(setupLanding(caps({ modules: [{ id: '@rooks/bots', active: false }] as Capabilities['modules'] })), '/');
  assert.equal(setupLanding(caps({ surfaces: { pages: ['/'] } as unknown as Capabilities['surfaces'] })), '/');
});

test('the onboarding hands over to the welcome on /bots, to the repair screen when /bots is out of reach', () => {
  assert.equal(welcomeLanding(caps()), WELCOME_PATH);
  assert.equal(WELCOME_PATH, setupLanding(caps()), 'the gate and the landing name the same page');
  assert.equal(welcomeLanding(null), WELCOME_PATH, 'the gate corrects it once capabilities are read');
  assert.equal(welcomeLanding(caps({ modules: [{ id: '@rooks/bots', active: false }] as Capabilities['modules'] })), MAIN_AGENT_REPAIR_PATH);
});
