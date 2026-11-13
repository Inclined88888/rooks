/**
 * The `workflow` action of the trigger editor (TODO #216): offered only while
 * the Workflows module runs, it picks a workflow and the entry node of its
 * published version.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

test('the workflow action is offered with Workflows on only, and posts its entry node', async (suite) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/triggers?tab=events', pretendToBeVisual: true });
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
  const { TriggerEditor } = await import('../plugins-client/triggers/trigger-editor');

  const originalFetch = globalThis.fetch;
  const posts: Record<string, unknown>[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === '/api/ui/workflows/wf-1/entry-nodes') return Response.json({ nodes: [{ id: 'start', type: 'trigger.manual', label: 'Start' }] });
    if (url === '/api/ui/triggers' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      return Response.json({ trigger: { ...body, id: 'tr-1' } }, { status: 201 });
    }
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
    const el = document.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
    assert.ok(el, selector);
    const proto = el instanceof dom.window.HTMLSelectElement ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
      el.dispatchEvent(new dom.window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    });
    await settle();
  };
  const typeOptions = () => Array.from(document.querySelectorAll<HTMLOptionElement>('[aria-label="Type of action 1"] option')).map((o) => o.value);
  const render = async (workflows: { id: string; name: string; published_version: number | null }[] | null) => {
    await React.act(async () => root.render(React.createElement(TriggerEditor, {
      source: 'event', trigger: null, agents: [], workflows, onClose: () => {}, onSaved: () => {},
    })));
    await settle();
    await fill('#trigger-name', 'Blocked task to workflow');
    await click(button(/^Next$/));
    await click(button(/^Next$/));
  };

  try {
    await suite.test('Workflows off: no workflow action to choose', async () => {
      await render(null);
      assert.deepEqual(typeOptions(), ['todo', 'task', 'notify', 'webhook', 'script']);
      await React.act(async () => root.render(React.createElement('div')));
    });

    await suite.test('Workflows on: pick a published workflow and its entry node', async () => {
      await render([{ id: 'wf-1', name: 'Triage', published_version: 2 }, { id: 'wf-2', name: 'Draft', published_version: null }]);
      assert.deepEqual(typeOptions(), ['todo', 'task', 'notify', 'workflow', 'webhook', 'script']);
      await fill('[aria-label="Type of action 1"]', 'workflow');
      const unpublished = document.querySelector<HTMLOptionElement>('#trigger-action-0-workflow option[value="wf-2"]');
      assert.equal(unpublished?.disabled, true);
      await click(button(/^Create trigger$/));
      assert.equal(document.querySelector('[role="dialog"] [role="alert"]')?.textContent, 'Action 1: choose a workflow and the node it starts at.');
      await fill('#trigger-action-0-workflow', 'wf-1');
      await fill('#trigger-action-0-node', 'start');
      await click(button(/^Create trigger$/));
      assert.deepEqual(posts.map((p) => p.actions), [[{ type: 'workflow', workflow: 'wf-1', node: 'start' }]]);
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
