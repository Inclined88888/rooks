/**
 * The consent card of local dictation, against a fake desktop bridge: the size
 * comes from the desktop's state, nothing downloads before the click, then
 * progress, pause, resume, a failure with Retry, and cancel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

type Model = { modelId: string; status: string; receivedBytes: number; totalBytes: number; error: string | null };
const TOTAL = 670_478_772;

async function mount() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, v: unknown) => Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);

  let model: Model = { modelId: 'parakeet-tdt-0.6b-v3-int8', status: 'absent', receivedBytes: 0, totalBytes: TOTAL, error: null };
  const calls: string[] = [];
  let emit: (event: unknown) => void = () => {};
  const speech = {
    getState: async () => ({ engine: 'available', model, sessionId: null }),
    downloadModel: async () => { calls.push('download'); return new Promise(() => {}); },
    cancelDownload: async () => { calls.push('cancel'); return true; },
    deleteModel: async () => { calls.push('delete'); model = { ...model, status: 'absent', receivedBytes: 0 }; return model; },
    startDictation: async () => ({ ok: false, code: 'model-missing', message: '' }),
    feed: () => {},
    stopDictation: async () => {},
    cancelDictation: async () => {},
    microphone: async () => ({ status: 'granted' }),
    onEvent: (listener: (event: unknown) => void) => { emit = listener; return () => {}; },
  };
  (dom.window as unknown as { timonDesktop: unknown }).timonDesktop = { restartAfterSetup: async () => {}, speech };

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('@/lib/i18n');
  setLocale('en');
  const { LocalModelConsentCard } = await import('./consent-card');
  let closed = 0;
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => { root.render(React.createElement(LocalModelConsentCard, { onClose: () => { closed += 1; } })); });
  await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  const setModel = async (next: Partial<Model>) => {
    model = { ...model, ...next };
    await React.act(async () => { emit({ type: 'model-state', state: model }); });
  };
  const click = async (label: string) => {
    const button = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === label);
    assert.ok(button, `no "${label}" button in: ${document.body.textContent}`);
    await React.act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const buttons = () => Array.from(document.querySelectorAll("button")).map((b) => b.textContent);
  const unmount = async () => { await React.act(async () => { root.unmount(); }); dom.window.close(); };
  return { calls, setModel, click, buttons, text: () => document.body.textContent ?? '', closed: () => closed, unmount };
}

test('consent, then progress with pause, resume, a failure and cancel', async () => {
  const card = await mount();
  try {
    // Consent: the size read from the desktop, formatted at runtime; nothing downloaded yet.
    assert.match(card.text(), /A speech model of 670 MB will be downloaded once\. Your voice stays on your computer\./);
    assert.deepEqual(card.buttons(), ['Download', 'Cancel']);
    assert.deepEqual(card.calls, []);

    await card.click('Download');
    assert.deepEqual(card.calls, ['download']);
    await card.setModel({ status: 'downloading', receivedBytes: TOTAL / 4 });
    assert.equal(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'), '25');
    assert.match(card.text(), /Downloading… 168 MB of 670 MB/);
    assert.deepEqual(card.buttons(), ['Pause', 'Cancel']);

    await card.click('Pause');
    await card.setModel({ status: 'partial' });
    assert.match(card.text(), /Paused at 168 MB of 670 MB/);
    assert.deepEqual(card.buttons(), ['Resume', 'Cancel']);

    await card.click('Resume');
    await card.setModel({ status: 'error', error: 'network' });
    assert.match(card.text(), /no connection/);
    assert.ok(!/Listening/.test(card.text()));
    assert.deepEqual(card.buttons(), ['Retry', 'Cancel']);

    await card.click('Cancel');
    assert.deepEqual(card.calls, ['download', 'cancel', 'download', 'cancel', 'delete']);
    assert.equal(card.closed(), 1);
  } finally { await card.unmount(); }
});

test('a finished download says how to dictate and closes on demand', async () => {
  const card = await mount();
  try {
    await card.click('Download');
    await card.setModel({ status: 'verifying', receivedBytes: TOTAL });
    assert.match(card.text(), /Checking the downloaded files/);
    await card.setModel({ status: 'ready' });
    assert.match(card.text(), /Click the microphone to dictate/);
    await card.click('Close');
    assert.equal(card.closed(), 1);
  } finally { await card.unmount(); }
});

test('offline at the first click: the card says so, and Retry starts the download again', async () => {
  const card = await mount();
  try {
    await card.click('Download');
    await card.setModel({ status: 'error', error: 'network', receivedBytes: 0 });
    assert.match(card.text(), /no connection/);
    assert.ok(!/Listening/.test(card.text()));
    await card.click('Retry');
    assert.deepEqual(card.calls, ['download', 'download']);
    await card.setModel({ status: 'downloading', error: null, receivedBytes: TOTAL / 2 });
    assert.match(card.text(), /Downloading… 335 MB of 670 MB/);
  } finally { await card.unmount(); }
});

test('a full disk names the space the model needs', async () => {
  const card = await mount();
  try {
    await card.click('Download');
    await card.setModel({ status: 'error', error: 'disk-full' });
    assert.match(card.text(), /Not enough disk space: the model needs 670 MB/);
    assert.deepEqual(card.buttons(), ['Retry', 'Cancel']);
  } finally { await card.unmount(); }
});
