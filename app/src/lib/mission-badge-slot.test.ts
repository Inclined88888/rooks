import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * `mission.card.badge`: the liveness badge tells apart a live process in a
 * turn, a live process whose turn ended, an open row with nothing running and
 * a cut mission — where `status: running` said all four the same way.
 */

async function installDom() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'DocumentFragment',
    'MutationObserver', 'CustomEvent', 'Event', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  ] as const) install(key, key === 'self' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  return { React, root: createRoot(document.getElementById('root')!) };
}

async function withLivenessOccupant(fn: () => Promise<void>) {
  const { declareSlot, register, slotKind } = await import('./plugin-host/slots');
  const { MissionLivenessBadge } = await import('../plugins-client/missions/liveness-badge');
  const undo: Array<() => void> = [];
  if (slotKind('mission.card.badge') === null) undo.push(declareSlot('mission.card.badge', 'list'));
  undo.push(register({ slot: 'mission.card.badge', pluginId: 'test/liveness' }, MissionLivenessBadge));
  try { await fn(); } finally { for (const f of undo.reverse()) f(); }
}

async function paint(source: Record<string, unknown>): Promise<string> {
  const { React, root } = await installDom();
  const { MissionBadgeSlot } = await import('../plugins-client/missions/mission-badge-slot');
  const { toMissionItem } = await import('./mission-liveness');
  await React.act(async () => {
    root.render(React.createElement(MissionBadgeSlot, { mission: toMissionItem({ id: 'm1', status: 'running', ...source }) }));
  });
  const html = document.getElementById('root')!.innerHTML;
  await React.act(async () => { root.unmount(); });
  return html;
}

test('the four live states read differently, each with its own label', async () => {
  await withLivenessOccupant(async () => {
    const working = await paint({ running: true, turn_active: true, liveness: 'working' });
    const done = await paint({ running: true, turn_complete: true, liveness: 'turn_done' });
    const open = await paint({ liveness: 'open' });
    const cut = await paint({ liveness: 'interrupted', interrupted_reason: 'rate_limit' });
    assert.match(working, /data-liveness="working"/);
    assert.match(done, /data-liveness="turn_done"/);
    assert.match(open, /data-liveness="open"/);
    assert.match(cut, /data-liveness="interrupted"/);
    assert.equal(new Set([working, done, open, cut]).size, 4);
    // A cut mission says why, in the badge title.
    assert.match(cut, /usage limit/);
  });
});

test('what a mission still owes shows next to its state', async () => {
  await withLivenessOccupant(async () => {
    const html = await paint({ running: true, turn_complete: true, liveness: 'turn_done', pending_messages: 3, open_deliveries: 1 });
    assert.match(html, /3 message\(s\) waiting/);
    assert.match(html, /1 request\(s\) not answered/);
  });
});

test('a finished mission, or a daemon without the field, paints nothing', async () => {
  await withLivenessOccupant(async () => {
    assert.equal(await paint({ status: 'completed', liveness: 'ended' }), '');
    assert.equal(await paint({ running: true, turn_active: true }), '');
  });
});

test('without an occupant the slot paints nothing', async () => {
  assert.equal(await paint({ liveness: 'working' }), '');
});

test('a third-party half gets the hook through `@timon/ui`, and its manifest may declare the slot', async () => {
  const { UI_KIT } = await import('./plugin-host/ui-kit');
  const { useMissionItem } = await import('../plugins-client/missions/mission-badge-slot');
  const { PLATFORM_MODULE_SOURCES, platformModuleExports } = await import('./plugin-host/platform-modules');
  const { isSlotAdmissible } = await import('./plugin-host/slot-compat');
  assert.equal(UI_KIT.useMissionItem, useMissionItem);
  assert.ok(platformModuleExports('ui.js').includes('useMissionItem'));
  assert.match(PLATFORM_MODULE_SOURCES['ui.js']!, /useMissionItem=u\.useMissionItem/);
  assert.equal(isSlotAdmissible(['mission.card.badge'], 'mission.card.badge'), true);
  assert.equal(isSlotAdmissible(['mission.card.badge'], 'mission.card.action'), false, 'exact name, never a family');
});

test('every liveness label and reason has an English and a French string', async () => {
  const en = (await import('../locales/en/misc.json')).default.missionLiveness;
  const fr = (await import('../locales/fr/misc.json')).default.missionLiveness;
  const shape = (o: unknown): string[] =>
    Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => (typeof v === 'object' && v ? shape(v).map((s) => `${k}.${s}`) : [k]));
  assert.deepEqual(shape(fr).sort(), shape(en).sort());
  for (const reason of ['rate_limit', 'exhausted', 'backend_unavailable', 'overloaded', 'permission_denied', 'killed', 'stopped', 'timeout', 'crash', 'unknown']) {
    assert.ok(reason in en.reason, reason);
  }
});
