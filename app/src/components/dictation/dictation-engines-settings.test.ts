/**
 * The engines of the Voice pane: the choice of engine (TODO #492) — choosing
 * is not consenting, a chosen engine gone or unavailable is said — then each
 * engine's destination and consent (C3), and its own panel, contained when it
 * throws.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ComponentType } from 'react';

const Panel = () => null;

type Options = {
  /** Panels of the three engines, in order. */
  panels?: [ComponentType, ComponentType, ComponentType];
  /** Run once the engines are registered, before the pane renders. */
  before?: () => Promise<void> | void;
};

async function mount(options: Options = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, v: unknown) => Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'localStorage'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('@/lib/i18n');
  setLocale('en');
  const { grantClientPermissions, resetClientPermissionsForTests } = await import('@/lib/plugin-host/plugin-permissions');
  const { register, resetSlotsForTests } = await import('@/lib/plugin-host/slots');
  const { recordDictationDeclarations } = await import('@/lib/dictation/destination');
  const { resetDictationChoiceForTests } = await import('@/lib/dictation/choice');
  resetSlotsForTests();
  resetClientPermissionsForTests();
  resetDictationChoiceForTests();
  const engine = (id: string, label: string) => ({
    id, label, languages: { codes: [], mode: 'auto' as const }, interim: 'live' as const,
    availability: async () => ({ state: 'ready' as const }),
    start: async () => ({ feed: () => {}, stop: async () => {}, cancel: () => {} }),
  });
  recordDictationDeclarations([
    { id: 'acme-dictation', label: 'Acme Dictation', dictation: { engines: [{ id: 'acme-cloud', runtime: 'page', egress: ['api.acme.com'] }], models: null } },
  ]);
  grantClientPermissions('@timon/settings', ['dictation:engine']);
  grantClientPermissions('acme-dictation', ['dictation:engine']);
  grantClientPermissions('rogue', ['dictation:engine']);
  const [localPanel, cloudPanel, roguePanel] = options.panels ?? [Panel, Panel, Panel];
  register({ slot: 'dictation.engine', pluginId: '@timon/settings', key: 'local', dictation: engine('local', 'Timon (on this computer)') }, localPanel);
  register({ slot: 'dictation.engine', pluginId: 'acme-dictation', key: 'cloud', dictation: engine('acme-cloud', 'Acme Cloud') }, cloudPanel);
  register({ slot: 'dictation.engine', pluginId: 'rogue', key: 'rogue', dictation: engine('rogue-engine', 'Rogue') }, roguePanel);
  await options.before?.();

  const { DictationEnginesSettings } = await import('./dictation-engines-settings');
  const root = createRoot(document.getElementById('root')!);
  const errors: unknown[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  await React.act(async () => { root.render(React.createElement(DictationEnginesSettings)); });
  await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  /** Rows: Automatic first (jsdom has no Web Speech), then the engines. */
  const rows = () => Array.from(document.querySelectorAll('li')).map((li) => li.textContent ?? '');
  const radios = () => Array.from(document.querySelectorAll('[role="radio"]')).map((radio) => ({
    text: radio.textContent ?? '',
    checked: radio.getAttribute('aria-checked') === 'true',
    disabled: (radio as HTMLButtonElement).disabled,
  }));
  const press = async (element: Element) => {
    await React.act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  };
  const click = async (row: number, label: string) => {
    const button = Array.from(document.querySelectorAll('li')[row]!.querySelectorAll('button')).find((b) => b.textContent === label);
    assert.ok(button, `no "${label}" in row ${row}: ${rows()[row]}`);
    await press(button);
  };
  const choose = async (row: number) => { await press(document.querySelectorAll('[role="radio"]')[row]!); };
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    console.error = consoleError;
    recordDictationDeclarations([]);
    resetSlotsForTests();
    resetClientPermissionsForTests();
    resetDictationChoiceForTests();
    dom.window.close();
  };
  return { rows, radios, click, choose, unmount, errors, React };
}

// ── The choice ───────────────────────────────────────────────────────────

test('choosing a third-party engine is not consenting to it: the card opens, the consent stays to give', async () => {
  const pane = await mount();
  try {
    const { dictationChoice } = await import('@/lib/dictation/choice');
    const { engineConsent } = await import('@/lib/dictation/consent');
    assert.deepEqual(pane.radios().map((r) => r.checked), [true, false, false, false], 'Automatic by default');
    await pane.choose(2);
    assert.deepEqual(dictationChoice(), { kind: 'engine', pluginId: 'acme-dictation', engineId: 'acme-cloud', label: 'Acme Cloud' });
    assert.deepEqual(pane.radios().map((r) => r.checked), [false, false, true, false]);
    assert.equal(engineConsent('acme-dictation', 'acme-cloud'), 'ask', 'choosing gave no consent');
    assert.match(pane.rows()[2]!, /Not allowed yet/);
    await pane.choose(0);
    assert.deepEqual(dictationChoice(), { kind: 'auto' });
  } finally { await pane.unmount(); }
});

test('an engine with no declared destination cannot be chosen', async () => {
  const pane = await mount();
  try {
    const rogue = pane.radios()[3]!;
    assert.match(rogue.text, /Rogue/);
    assert.equal(rogue.disabled, true);
  } finally { await pane.unmount(); }
});

test('a chosen engine that is not registered stays chosen and is said unavailable', async () => {
  const pane = await mount({
    before: async () => {
      const { setDictationChoice } = await import('@/lib/dictation/choice');
      setDictationChoice({ kind: 'engine', pluginId: 'acme-dictation', engineId: 'acme-eu', label: 'Acme EU' });
    },
  });
  try {
    const radios = pane.radios();
    assert.equal(radios.at(-1)!.text.includes('Acme EU (not available)'), true);
    assert.equal(radios.at(-1)!.checked, true);
    assert.equal(radios.filter((r) => r.checked).length, 1, 'nothing else is shown as chosen');
    assert.match(pane.rows().at(-1)!, /dictation stays off until it is back/);
  } finally { await pane.unmount(); }
});

test('a choice reset because its plugin is gone is said once, until read', async () => {
  const pane = await mount({
    before: async () => {
      const { resetDictationChoice } = await import('@/lib/dictation/choice');
      resetDictationChoice('Acme Cloud');
    },
  });
  try {
    const status = () => document.querySelector('[role="status"]')?.textContent ?? '';
    assert.match(status(), /Acme Cloud is no longer installed: dictation went back to Automatic\./);
    assert.equal(pane.radios()[0]!.checked, true);
    const ok = Array.from(document.querySelectorAll('[role="status"] button')).find((b) => b.textContent === 'OK')!;
    await pane.React.act(async () => { ok.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    assert.equal(status(), '');
  } finally { await pane.unmount(); }
});

// ── Destinations and consent (C3) ────────────────────────────────────────

test('each engine says where the voice goes; a plugin\'s engine is allowed and withdrawn here', async () => {
  const pane = await mount();
  try {
    const [auto, local, cloud, rogue] = pane.rows();
    assert.match(auto!, /Automatic/);
    assert.match(local!, /Your voice stays on this computer\./);
    assert.doesNotMatch(local!, /Allow|Withdraw/, 'the product engine asks no consent');
    assert.match(cloud!, /Dictation engine of the plugin Acme Dictation/);
    assert.match(cloud!, /Your voice is sent to api\.acme\.com\./);
    assert.match(cloud!, /Not allowed yet/);
    assert.match(rogue!, /This engine does not say where your voice goes\./);
    assert.match(rogue!, /Not used/);
    assert.doesNotMatch(rogue!, /Allow/, 'nothing to consent to without a destination');

    await pane.click(2, 'Allow');
    assert.match(pane.rows()[2]!, /Allowed on this computer\./);
    await pane.click(2, 'Withdraw');
    assert.match(pane.rows()[2]!, /Not allowed yet/);
  } finally { await pane.unmount(); }
});

// ── The engine's panel ───────────────────────────────────────────────────

test('each engine\'s panel is painted under its card; one that throws is contained', async () => {
  const React = await import('react');
  const LocalPanel = () => React.createElement('p', null, 'Speech model pane');
  const Broken = (): never => { throw new Error('panel bug'); };
  const CloudPanel = () => React.createElement('p', null, 'Acme settings');
  const pane = await mount({ panels: [LocalPanel, Broken, CloudPanel] });
  try {
    const [, local, cloud, rogue] = pane.rows();
    assert.match(local!, /Speech model pane/);
    assert.match(cloud!, /Plugin acme-dictation en erreur/, 'the error shows in place');
    assert.match(cloud!, /Not allowed yet/, 'the engine\'s card is still there');
    assert.match(rogue!, /Acme settings/, 'the next engine renders');
    assert.equal(pane.radios().length, 4, 'the pane lives on');
  } finally { await pane.unmount(); }
});

test('a panel the plugin also grafted in settings.voice is painted once, in the graft', async () => {
  const React = await import('react');
  const CloudPanel = () => React.createElement('p', null, 'Acme settings');
  const pane = await mount({
    panels: [Panel, CloudPanel, Panel],
    before: async () => {
      const { declareSlot, register } = await import('@/lib/plugin-host/slots');
      // Declared by the settings layout in the app; not by the test registry.
      declareSlot('settings.voice', 'list');
      register({ slot: 'settings.voice', pluginId: 'acme-dictation', key: 'cloud' }, CloudPanel);
    },
  });
  try {
    assert.doesNotMatch(pane.rows()[2]!, /Acme settings/);
  } finally { await pane.unmount(); }
});
