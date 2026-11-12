/**
 * Trigger editor (TODO #216): a webhook created in three steps — source,
 * filter, action — and its secret shown once, masked, never in the page.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const SECRET = 'f'.repeat(24) + 'secret-value-0123456789';

test('a webhook is created in three steps and its secret never reaches the page', async (suite) => {
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
  const copied: string[] = [];
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async (text: string) => { copied.push(text); } }, configurable: true });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { TriggerList } = await import('../plugins-client/triggers/trigger-list');

  const originalFetch = globalThis.fetch;
  const posts: unknown[] = [];
  const patches: { url: string; body: unknown }[] = [];
  // Made outside the page (CLI, MCP): values the simple form cannot hold.
  const existing = {
    id: 'tr-0', name: 'GitLab issues', slug: 'gitlab-issues', source: 'webhook', enabled: true,
    config: { auth: 'gitlab', rate_limit: 12, coalesce: { key: 'issue.id', quiet_ms: 1500, max_ms: 10_000 } },
    filter: { all: [
      { op: 'equals', path: 'assignee', value: null },
      { op: 'in', path: 'labels', values: ['a,b', ' c ', ''] },
    ] },
    actions: [{ type: 'todo', text: 'Issue: {issue.title}' }],
    created_by: 'agent', creator_agent: 'coder', has_secret: true, url: '/api/triggers/hooks/gitlab-issues',
    last_run_at: null, next_run_at: null, created_at: 0, updated_at: 0,
  };
  let triggers: unknown[] = [existing];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === '/api/ui/agents') return Response.json({ agents: [{ name: 'coder' }] });
    if (url === '/api/ui/triggers?source=webhook') return Response.json({ triggers });
    if (url === '/api/ui/triggers' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      const trigger = {
        id: 'tr-1', name: body.name, slug: body.slug, source: 'webhook', enabled: true, config: body.config,
        filter: body.filter, actions: body.actions, created_by: 'user', creator_agent: null, has_secret: true,
        url: `/api/triggers/hooks/${String(body.slug)}`, last_run_at: null, next_run_at: null, created_at: 1, updated_at: 1,
      };
      triggers = [...triggers, trigger];
      return Response.json({ trigger, secret: SECRET }, { status: 201 });
    }
    if (url === '/api/ui/triggers/tr-0' && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      patches.push({ url, body });
      return Response.json({ trigger: { ...existing, ...body } });
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
    const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector);
    assert.ok(el, selector);
    const proto = el instanceof dom.window.HTMLSelectElement ? dom.window.HTMLSelectElement.prototype
      : el instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
      el.dispatchEvent(new dom.window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    });
  };
  const alert = () => document.querySelector('[role="dialog"] [role="alert"]')?.textContent ?? null;

  try {
    await React.act(async () => root.render(React.createElement(TriggerList, { source: 'webhook' })));
    await settle();

    await suite.test('step 1, source: the name gives the route its name, and is required', async () => {
      await click(button(/\+ New webhook/));
      assert.match(document.querySelector('[data-testid="trigger-editor-title"]')?.textContent ?? '', /New webhook trigger/);
      await click(button(/^Next$/));
      assert.equal(alert(), 'Give the trigger a name.');
      await fill('#trigger-name', 'Discord bugs');
      assert.equal(document.querySelector<HTMLInputElement>('#trigger-slug')?.value, 'discord-bugs');
      assert.match(document.querySelector('#trigger-slug + code')?.textContent ?? '', /^http:\/\/localhost\/api\/triggers\/hooks\/discord-bugs$/);
      await fill('#trigger-auth', 'generic');
      await click(button(/^Next$/));
    });

    await suite.test('step 2, filter: conditions on the payload', async () => {
      assert.equal(document.querySelector('[aria-current="step"]')?.textContent, '2. Filter');
      await click(Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find((r) => r.parentElement?.textContent === 'Conditions'));
      await fill('[aria-label="Path of condition 1"]', 'channel');
      await fill('[aria-label="Value of condition 1"]', 'bugs');
      await click(button(/^Next$/));
    });

    await suite.test('step 3, action: a TO DO idea from a template', async () => {
      assert.equal(document.querySelector('[aria-current="step"]')?.textContent, '3. Action');
      await click(button(/^Create trigger$/));
      assert.equal(alert(), 'Action 1: the idea needs a text.');
      await fill('#trigger-action-0-text', 'Bug: {content}');
      await click(button(/^Create trigger$/));
      assert.deepEqual(posts, [{
        source: 'webhook', name: 'Discord bugs', enabled: true, slug: 'discord-bugs', config: { auth: 'generic' },
        filter: { op: 'equals', path: 'channel', value: 'bugs' },
        actions: [{ type: 'todo', text: 'Bug: {content}' }],
      }]);
    });

    await suite.test('the secret is shown once, masked, and only copied', async () => {
      assert.match(document.querySelector('[data-testid="trigger-secret-title"]')?.textContent ?? '', /Webhook secret/);
      assert.equal(document.body.innerHTML.includes(SECRET), false, 'the secret is never rendered');
      await click(button(/Copy the secret/));
      assert.deepEqual(copied, [SECRET]);
      await click(button(/I copied it/));
      assert.ok(!document.querySelector('[data-testid="trigger-secret-title"]'));
      assert.equal(document.body.innerHTML.includes(SECRET), false);
      assert.match(document.body.textContent ?? '', /Discord bugs/);
    });

    await suite.test('renaming a trigger made elsewhere keeps its filter and coalescing exactly', async () => {
      await click(Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'GitLab issues'));
      assert.match(document.querySelector('[data-testid="trigger-editor-title"]')?.textContent ?? '', /Edit webhook trigger/);
      assert.equal(document.querySelector<HTMLInputElement>('#trigger-coalesce-quiet')?.value, '1.5');
      assert.equal(document.querySelector<HTMLInputElement>('#trigger-coalesce-max')?.value, '10');
      await fill('#trigger-name', 'GitLab issues (team)');
      await click(button(/^Next$/));
      const json = document.querySelector<HTMLTextAreaElement>('#trigger-filter-json');
      assert.ok(json, 'a filter the conditions cannot hold opens as JSON');
      await click(button(/^Next$/));
      await click(button(/^Save$/));
      assert.deepEqual(patches, [{
        url: '/api/ui/triggers/tr-0',
        body: {
          name: 'GitLab issues (team)', enabled: true, slug: 'gitlab-issues',
          config: existing.config, filter: existing.filter,
          actions: [{ type: 'todo', text: 'Issue: {issue.title}' }],
        },
      }]);
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
