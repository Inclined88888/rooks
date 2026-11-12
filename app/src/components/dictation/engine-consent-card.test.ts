/**
 * The consent card of a plugin's dictation engine: it names the destination
 * the manifest declares and the machine, stores nothing before a click, and
 * stores the answer for that destination only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function mount(egress: unknown) {
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
  const { recordDictationDeclarations } = await import('@/lib/dictation/destination');
  recordDictationDeclarations([
    { id: 'acme-dictation', label: 'Acme Dictation', dictation: { engines: [{ id: 'acme-cloud', runtime: 'page', egress }], models: null } },
  ]);
  const consent = await import('@/lib/dictation/consent');
  const { EngineConsentCard } = await import('./engine-consent-card');
  let closed = 0;
  const root = createRoot(document.getElementById('root')!);
  const request = { pluginId: 'acme-dictation', engineId: 'acme-cloud', engineLabel: 'Acme Cloud' };
  await React.act(async () => { root.render(React.createElement(EngineConsentCard, { request, onClose: () => { closed += 1; } })); });

  const click = async (label: string) => {
    const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === label);
    assert.ok(button, `no "${label}" button in: ${document.body.textContent}`);
    await React.act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  };
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    recordDictationDeclarations([]);
    dom.window.close();
  };
  return {
    click,
    text: () => document.body.textContent ?? '',
    buttons: () => Array.from(document.querySelectorAll('button')).map((b) => b.textContent),
    consent: () => consent.engineConsent('acme-dictation', 'acme-cloud'),
    closed: () => closed,
    unmount,
  };
}

test('Don\'t allow stores a refusal and closes; nothing was stored before the click', async () => {
  const card = await mount(['api.acme.com']);
  try {
    assert.match(card.text(), /Let Acme Cloud hear you\?/);
    assert.match(card.text(), /Dictation engine of the plugin Acme Dictation/);
    assert.match(card.text(), /Your voice is sent to api\.acme\.com\./);
    assert.match(card.text(), /This choice applies to this computer only/);
    assert.deepEqual(card.buttons(), ['Allow', 'Don\'t allow']);
    assert.equal(card.consent(), 'ask');
    await card.click('Don\'t allow');
    assert.equal(card.consent(), 'refused');
    assert.equal(card.closed(), 1);
  } finally { await card.unmount(); }
});

test('Allow stores the consent for the named destination, then says how to dictate', async () => {
  const card = await mount('daemon');
  try {
    assert.match(card.text(), /Your voice is sent to the Rooks daemon of this computer\./);
    await card.click('Allow');
    assert.equal(card.consent(), 'granted');
    assert.match(card.text(), /Allowed\. Click the microphone to dictate\./);
    await card.click('Close');
    assert.equal(card.closed(), 1);
  } finally { await card.unmount(); }
});
