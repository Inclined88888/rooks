import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';
import test from 'node:test';

/**
 * A plugin consent card opens `/secrets?grant=<NAME>&plugin=<id>` (TODO #597).
 *
 * Mounts the real `SecretsClient` under the App Router contexts (same harness
 * as `missions-deep-link.test.ts`) and checks what the operator can actually
 * do there: the dialog names the effect and grants nothing until confirmed,
 * the grant it sends is `agent:plugin:<id>` on the row shared `global`, and a
 * plugin already granted gets no button. The daemon's refusal of a
 * non-superadmin is covered by `routes-auth.test.ts`.
 */
test('the consent card opens a dialog that grants the plugin by name, once confirmed', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/secrets', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('self', dom.window);
  for (const key of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'NodeFilter', 'HTMLInputElement', 'HTMLSelectElement', 'SVGElement', 'Event', 'CustomEvent', 'FocusEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const shared = {
    id: 'sec-global', name: 'GH_TOKEN', mode: 'inject', configured: true, updated_at: 1,
    grants: [{ scope_kind: 'global', scope_ref: null }],
  };
  const projectRow = {
    id: 'sec-project', name: 'GH_TOKEN', mode: 'inject', configured: true, updated_at: 1,
    grants: [{ scope_kind: 'project', scope_ref: 'alpha' }],
  };
  const brokered = {
    id: 'sec-broker', name: 'API_KEY', mode: 'broker', configured: true, updated_at: 1,
    broker_spec: JSON.stringify({ type: 'http', hosts: ['api.example.com'], inject: { kind: 'header', name: 'Authorization', template: 'Bearer {{value}}' } }),
    grants: [{ scope_kind: 'agent', scope_ref: 'plugin:acme' }],
  };
  const posts: { url: string; body: unknown }[] = [];
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ ...shared, grants: [...shared.grants, { scope_kind: 'agent', scope_ref: 'plugin:acme' }] });
    }
    if (url.startsWith('/api/ui/secrets')) return Response.json({ secrets: [projectRow, shared, brokered] });
    if (url === '/api/ui/plugins') {
      return Response.json({ plugins: [
        { id: 'acme', label: 'Acme connector', source: 'third-party' },
        { id: '@rooks/kanban', label: 'Kanban', source: 'bundled' },
      ] });
    }
    if (url === '/api/ui/projects') return Response.json({ projects: [{ slug: 'alpha' }] });
    if (url === '/api/ui/agents') return Response.json({ agents: [{ name: 'alpha.coder' }] });
    // A provider still waiting for its key is in the installed list only; an account instance in the catalogue only.
    if (url === '/api/ui/backends/manage') return Response.json({ backends: [{ id: 'opencode', label: 'OpenCode' }, { id: 'claude', label: 'Claude' }] });
    if (url === '/api/ui/backends/catalog') return Response.json({ backends: [{ id: 'claude', label: 'Claude' }, { id: 'claude@krz', label: 'Claude', instanceOf: 'claude' }] });
    return Response.json({});
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const { SearchParamsContext, PathnameContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { SecretsClient } = await import('../plugins-client/secrets-vault/secrets-page');

  const replaced: string[] = [];
  const router = { back() {}, forward() {}, refresh() {}, prefetch() {}, push() {}, replace(href: string) { replaced.push(href); } };
  const root = createRoot(document.getElementById('root')!);
  const render = (search: string) => React.act(async () => {
    root.render(
      React.createElement(AppRouterContext.Provider, { value: router as never },
        React.createElement(PathnameContext.Provider, { value: '/secrets' },
          React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) as never },
            React.createElement(SecretsClient)))),
    );
  });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const marked = (name: string) => document.querySelector(`[data-plugin-grant="${name}"]`);
  const dialogText = () => document.querySelector('[role="dialog"]')?.textContent ?? '';
  const click = (el: Element) => React.act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });

  try {
    await render('grant=GH_TOKEN&plugin=acme');
    await until(() => marked('effect') !== null, 'the dialog to name the effect of the grant');
    assert.match(dialogText(), /Acme connector \(acme\)/, 'the plugin is named, label and id');
    assert.match(dialogText(), /GH_TOKEN/);
    assert.equal(posts.length, 0, 'opening the card grants nothing');

    await click(marked('confirm')!);
    await until(() => posts.length === 1 && replaced.includes('/secrets'), 'the grant to be sent and the URL cleared');
    assert.deepEqual(posts[0], {
      url: '/api/ui/secrets/sec-global/grants',
      body: { scope: { scope_kind: 'agent', scope_ref: 'plugin:acme' } },
    }, 'the row shared `global` is the one granted, to the plugin by name');

    // Already granted: said so, no button to grant twice.
    await render('grant=API_KEY&plugin=acme');
    await until(() => marked('already') !== null, 'the dialog to say the plugin already has it');
    assert.equal(marked('confirm'), null);

    // A name the vault does not hold: nothing to confirm.
    await render('grant=NOPE_TOKEN&plugin=acme');
    await until(() => marked('missing') !== null, 'the dialog to say there is no such secret');
    assert.equal(marked('confirm'), null);

    // A malformed request opens no dialog at all.
    await render('grant=lower&plugin=acme');
    await until(() => document.querySelector('[role="dialog"]') === null, 'no dialog for a malformed request');
    assert.equal(posts.length, 1, 'nothing else was granted');

    // The editor offers "plugin" as a scope, listing third-party plugins only.
    await render('');
    const newButton = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('New secret'));
    assert.ok(newButton, 'the New secret button');
    await click(newButton!);
    await until(() => document.querySelectorAll('[role="dialog"] select').length > 0, 'the editor to open');
    const kind = document.querySelector('[role="dialog"] select') as HTMLSelectElement;
    assert.ok(Array.from(kind.options).some((o) => o.value === 'plugin'), 'a plugin scope is offered');
    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(kind, 'plugin');
      kind.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    const refs = () => {
      const selects = document.querySelectorAll('[role="dialog"] select');
      return selects.length > 1 ? Array.from((selects[1] as HTMLSelectElement).options).map((o) => [o.value, o.textContent]) : [];
    };
    await until(() => refs().length > 0, 'the plugin list to show');
    assert.deepEqual(refs(), [['acme', 'Acme connector (acme)']], 'bundled modules are not grantees');

    // The reservation (TODO #600): offered with the backends, a provider without its key included.
    const reservationHint = () => document.querySelector('[data-backend-reservation-hint]');
    assert.ok(!reservationHint(), 'no word of it while another scope is picked');
    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(kind, 'backend');
      kind.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await until(() => refs().some(([value]) => value === 'opencode'), 'the backend list to show');
    assert.deepEqual(refs(), [['opencode', 'OpenCode (opencode)'], ['claude', 'Claude (claude)']], 'never an account instance');
    assert.ok(reservationHint(), 'what it does is said where it is chosen');

    const addGrant = Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent?.trim() === 'Add scope');
    assert.ok(addGrant, 'the Add scope button');
    await click(addGrant!);
    assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /backend only: opencode/);

    const fill = (el: Element, value: string) => React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    const inputs = document.querySelectorAll('[role="dialog"] input:not([type="radio"])');
    await fill(inputs[0]!, 'OPENCODE_KEY');
    await fill(inputs[1]!, 'sk-test');
    const saveButton = Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent?.trim() === 'Save');
    assert.ok(saveButton, 'the Save button');
    const before = posts.length;
    await click(saveButton!);
    await until(() => posts.length === before + 1, 'the secret to be sent');
    assert.equal(posts.at(-1)?.url, '/api/ui/secrets');
    assert.deepEqual((posts.at(-1)?.body as { grants: unknown }).grants, [{ scope_kind: 'backend', scope_ref: 'opencode' }]);
  } finally {
    await React.act(async () => { root.unmount(); });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
