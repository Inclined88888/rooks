/**
 * Settings → Missions → Global instructions, mounted in jsdom: the file the
 * daemon reports is shown as markdown, and an edit is written to the daemon's
 * route as plain text, then read again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function mount(initial: string) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, v: unknown) => Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Event', 'MouseEvent'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  let content = initial;
  const calls: { url: string; method: string; body: string | null; type: string | null }[] = [];
  install('fetch', async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ?? null, type: init?.headers?.['content-type'] ?? null });
    if (init?.method === 'PUT') { content = init.body ?? ''; return { ok: true, json: async () => ({ ok: true }) }; }
    return { ok: true, json: async () => ({ content, path: '/home/u/.timon/global-instructions.md', max_chars: 32000 }) };
  });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { GlobalInstructionsSettings } = await import('../plugins-client/settings/global-instructions-settings');
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => { root.render(React.createElement(GlobalInstructionsSettings)); });
  const act = (fn: () => void) => React.act(async () => { fn(); });
  const byText = (re: RegExp) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => re.test(b.textContent ?? ''));
  const unmount = async () => { await React.act(async () => { root.unmount(); }); dom.window.close(); };
  return { calls, act, byText, unmount, window: dom.window };
}

test('the instructions are shown as markdown with the file and its weight', async () => {
  const r = await mount('# Conventions\n\nAnswer in French.');
  try {
    assert.equal(document.querySelector('.chat-bubble h1')?.textContent, 'Conventions');
    assert.match(document.body.textContent ?? '', /global-instructions\.md/);
    assert.match(document.body.textContent ?? '', /~\d+ tokens · at most 32000 characters/);
  } finally { await r.unmount(); }
});

test('an edit is written as plain text to the global instructions route, then read again', async () => {
  const r = await mount('old');
  try {
    await r.act(() => r.byText(/^Edit/)!.click());
    const area = document.querySelector('textarea')!;
    assert.equal(area.value, 'old');
    await r.act(() => {
      const setter = Object.getOwnPropertyDescriptor(r.window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(area, 'new text');
      area.dispatchEvent(new r.window.Event('input', { bubbles: true }));
    });
    const reads = r.calls.filter((c) => c.method === 'GET').length;
    await r.act(() => r.byText(/^Save/)!.click());
    const write = r.calls.find((c) => c.method === 'PUT')!;
    assert.equal(write.url, '/api/ui/global-instructions');
    assert.equal(write.body, 'new text');
    assert.match(write.type ?? '', /^text\/plain/);
    assert.equal(r.calls.filter((c) => c.method === 'GET').length, reads + 1, 'read again after the save');
    assert.match(document.body.textContent ?? '', /new text/);
  } finally { await r.unmount(); }
});

test('an empty file says so and still offers to write it', async () => {
  const r = await mount('');
  try {
    assert.match(document.body.textContent ?? '', /Nothing yet/);
    assert.ok(r.byText(/^Edit/));
  } finally { await r.unmount(); }
});
