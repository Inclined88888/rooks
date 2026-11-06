/**
 * Triggers page (TODO #216): "send an example" with a pasted payload — a dry
 * run unless asked otherwise — and the journal of the last calls.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

test('send an example, then read the journal', async (suite) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/triggers?tab=webhooks', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'FocusEvent', 'MouseEvent', 'PointerEvent', 'CustomEvent', 'DocumentFragment', 'NodeFilter', 'HTMLInputElement', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    const value = (dom.window as unknown as Record<string, unknown>)[key];
    install(key, key === 'window' ? dom.window : typeof value === 'function' && /^[a-z]/.test(key) ? value.bind(dom.window) : value);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { TriggerList } = await import('../plugins-client/triggers/trigger-list');

  const originalFetch = globalThis.fetch;
  const tests: Record<string, unknown>[] = [];
  const trigger = {
    id: 'tr-1', name: 'Discord bugs', slug: 'discord-bugs', source: 'webhook', enabled: true, config: { auth: 'generic' },
    filter: null, actions: [{ type: 'todo', text: 'Bug: {content}' }], created_by: 'user', creator_agent: null, has_secret: true,
    url: '/api/triggers/hooks/discord-bugs', last_run_at: null, next_run_at: null, created_at: 1, updated_at: 1,
  };
  const deliveries = [
    { id: 4, at: 4000, status: 'duplicate', reason: null, delivery_key: 'd-1', excerpt: null, result: null },
    { id: 3, at: 3000, status: 'error', reason: '1 action(s) failed', delivery_key: null, excerpt: '{"content":"x"}', result: [{ type: 'todo', ok: false, error: 'project unknown' }] },
    { id: 2, at: 2000, status: 'ignored', reason: 'filter', delivery_key: null, excerpt: '{}', result: null },
    { id: 1, at: 1000, status: 'received', reason: null, delivery_key: 'd-1', excerpt: '{"content":"crash"}', result: [{ type: 'todo', ok: true, id: 42 }] },
  ];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === '/api/ui/agents') return Response.json({ agents: [] });
    if (url === '/api/ui/triggers?source=webhook') return Response.json({ triggers: [trigger] });
    if (url === '/api/ui/triggers/tr-1/test' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      tests.push(body);
      return body.execute
        ? Response.json({ status: 'received', outcomes: [{ type: 'todo', ok: true, id: 43 }] })
        : Response.json({ status: 'dry_run', outcomes: [{ type: 'todo', ok: true, id: null, preview: { text: 'Bug: crash' } }] });
    }
    if (url === '/api/ui/triggers/tr-1/deliveries?limit=50') return Response.json({ deliveries });
    throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`);
  };

  const root = createRoot(document.getElementById('root')!);
  const settle = async () => { await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const button = (label: RegExp) => Array.from(document.querySelectorAll('button')).find((b) => label.test(b.textContent ?? ''));
  const click = async (el: Element | undefined | null) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
    await settle();
  };
  const fill = async (selector: string, value: string) => {
    const el = document.querySelector<HTMLTextAreaElement>(selector);
    assert.ok(el, selector);
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  const result = () => document.querySelector('[data-testid="trigger-test-result"]')?.textContent ?? '';

  try {
    await React.act(async () => root.render(React.createElement(TriggerList, { source: 'webhook' })));
    await settle();

    await suite.test('a pasted payload is a dry run by default', async () => {
      await click(button(/^send an example$/));
      await fill('#trigger-test-payload', '{"content": "crash"}');
      await fill('#trigger-test-headers', '{"X-Event": "message"}');
      await click(button(/^Send the example$/));
      assert.deepEqual(tests, [{ payload: { content: 'crash' }, headers: { 'X-Event': 'message' } }]);
      assert.match(result(), /dry run/);
      assert.match(result(), /Bug: crash/);
    });

    await suite.test('invalid JSON is caught before the daemon is asked', async () => {
      await fill('#trigger-test-payload', '{oops');
      await click(button(/^Send the example$/));
      assert.equal(tests.length, 1);
      assert.match(document.querySelector('[role="dialog"] [role="alert"]')?.textContent ?? '', /not valid JSON/);
    });

    await suite.test('running the actions for real is an explicit choice', async () => {
      await fill('#trigger-test-payload', '{"content": "crash"}');
      const execute = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
        .find((box) => /Really run the actions/.test(box.parentElement?.textContent ?? ''));
      await click(execute);
      await click(button(/^Send the example$/));
      assert.equal(tests[1]?.execute, true);
      assert.match(result(), /received/);
      assert.match(result(), /created \(43\)/);
      await click(document.querySelector('[role="dialog"] button[aria-label="Close"]'));
    });

    await suite.test('the journal shows received, ignored, error and duplicate calls', async () => {
      await click(button(/^journal$/));
      const journal = document.querySelector('[data-testid="trigger-journal"]');
      assert.ok(journal);
      const statuses = Array.from(journal.querySelectorAll(':scope > li')).map((li) => li.querySelector('span')?.textContent);
      assert.deepEqual(statuses, ['duplicate', 'error', 'ignored', 'received']);
      assert.match(journal.textContent ?? '', /project unknown/);
      assert.match(journal.textContent ?? '', /created \(42\)/);
    });
  } finally {
    await React.act(async () => root.unmount());
    // Radix tears its dialog down on timers (focus return, presence): let
    // them run while jsdom and the globals they reach are still in place.
    for (let tick = 0; tick < 2; tick += 1) await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    dom.window.close();
  }
});
