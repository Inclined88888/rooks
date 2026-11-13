import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';
import { byAttention, type IntegrationReceipt, type IntegrationReceiptConnection } from './integration-receipts';

const connection = (id: string, counts: Partial<IntegrationReceiptConnection['counts']>): IntegrationReceiptConnection => ({
  id, pluginId: 'p', transport: 'p:chat@1', agent: 'a', enabled: true, owner: null,
  counts: { queued: 0, retrying: 0, failed: 0, ...counts }, receipts: [],
});

test('TODO #631: a connection with failures comes first, then one still retrying', () => {
  const ordered = byAttention([connection('ok', { queued: 3 }), connection('retry', { retrying: 2 }), connection('dead', { failed: 1 })]);
  assert.deepEqual(ordered.map((row) => row.id), ['dead', 'retry', 'ok']);
});

async function mount(initial: IntegrationReceiptConnection[]) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'NodeFilter', 'DocumentFragment',
    'MutationObserver', 'CustomEvent', 'Event', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  ] as const) install(key, key === 'self' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const sent: string[] = [];
  let current = initial;
  let listed = 0;
  install('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/api/ui/integration-receipts') { listed += 1; return Response.json({ connections: current }); }
    sent.push(`${init?.method} ${url}`);
    current = current.map((row) => ({ ...row, counts: { ...row.counts, failed: 0 }, receipts: [] }));
    return Response.json({ ok: true });
  });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { IntegrationReceiptsSettings } = await import('../components/settings/integration-receipts');
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => { root.render(React.createElement(IntegrationReceiptsSettings)); });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const button = (text: string) => Array.from(document.querySelectorAll('button')).find((node) => node.textContent?.trim() === text);
  const click = async (target: HTMLElement) => { await React.act(async () => { target.click(); }); };
  const unmount = async () => { await React.act(async () => { root.unmount(); }); };
  return { sent, listed: () => listed, until, button, click, unmount };
}

const failedReceipt: IntegrationReceipt = {
  id: '11111111-2222-4333-8444-555555555555', externalId: 'e1', stage: 'reply', status: 'failed', attempts: 295,
  lastError: 'provider 502', missionId: 'm1', preview: 'hello there', createdAt: 1, nextAt: null, failedAt: 2,
};

test('TODO #631: without a connection the section stays hidden', async () => {
  const ui = await mount([]);
  await ui.until(() => ui.listed() > 0, 'the list to load');
  assert.equal(document.getElementById('root')!.textContent, '');
  await ui.unmount();
});

test('TODO #631: a failed message shows its reason, and Replay sends it back then refreshes', async () => {
  const ui = await mount([{ ...connection('c1', { failed: 1 }), receipts: [failedReceipt] }]);
  await ui.until(() => !!ui.button('Replay'), 'the receipt to show');
  const text = document.getElementById('root')!.textContent ?? '';
  assert.ok(text.includes('hello there'));
  assert.ok(text.includes('provider 502'));
  assert.ok(text.includes('Sending the reply'));
  const before = ui.listed();
  await ui.click(ui.button('Replay')!);
  await ui.until(() => ui.listed() > before, 'the list to refresh');
  assert.deepEqual(ui.sent, [`POST /api/ui/integration-receipts/${failedReceipt.id}/replay`]);
  await ui.unmount();
});

test('TODO #631: a message still retrying cannot be discarded, and several failures offer Replay all', async () => {
  const retrying: IntegrationReceipt = { ...failedReceipt, id: 'r', status: 'retrying', attempts: 3, failedAt: null, nextAt: 5 };
  const ui = await mount([{ ...connection('c1', { retrying: 1 }), receipts: [retrying] }]);
  await ui.until(() => !!ui.button('Replay'), 'the receipt to show');
  assert.equal(ui.button('Discard'), undefined);
  await ui.unmount();

  const many = await mount([{ ...connection('c2', { failed: 2 }), receipts: [failedReceipt, { ...failedReceipt, id: 'other' }] }]);
  await many.until(() => !!many.button('Replay all 2'), 'the bulk action to show');
  await many.click(many.button('Replay all 2')!);
  await many.until(() => many.sent.length > 0, 'the bulk request');
  assert.deepEqual(many.sent, ['POST /api/ui/integration-receipts/connections/c2/replay-failed']);
  await many.unmount();
});
