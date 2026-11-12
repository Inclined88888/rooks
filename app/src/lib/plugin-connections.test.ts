/**
 * Editing a plugin connection: what the prefilled form sends back, and when it
 * warns that the destination needs a new approval.
 *
 * The daemon side (`orchestrator/src/plugins/user-connections.test.ts`) proves
 * that a missing secret keeps the stored key and that a moved origin reopens
 * the request; here the form must not send what nobody changed — a config sent
 * back as text could fail the plugin's schema, a blank key would be refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';
import { connectionChanges, reopensApproval, type UserConnection } from './plugin-connections';

const TYPE = {
  id: 'hermes-gateway:gateway@1', pluginId: 'hermes-gateway', label: 'Hermes Gateway', description: null,
  fields: [{ key: 'profile', label: 'Hermes profile' }], secrets: [{ name: 'apiKey', label: 'API server key', required: true }],
  customTest: true,
};
const CONNECTION: UserConnection = {
  id: '11111111-2222-4333-8444-555555555555', pluginId: 'hermes-gateway', type: TYPE.id, label: 'Home gateway',
  url: 'https://gw.example/base', allowPrivateNetwork: false, config: { profile: 'main', port: 8642 }, secrets: ['apiKey'],
  approval: 'approved', enabled: true, revision: 3,
};

test('an unchanged edit sends nothing; a field typed back as text is not a change', () => {
  assert.deepEqual(connectionChanges(CONNECTION, {
    label: ' Home gateway ', url: 'https://gw.example/base', allowPrivateNetwork: false,
    config: { profile: 'main', port: '8642' }, secrets: { apiKey: '' },
  }), {});
  // A form that never shows the flag leaves it as it was.
  assert.deepEqual(connectionChanges(CONNECTION, { label: 'Home gateway', url: CONNECTION.url }), {});
});

test('only what changed is sent: the config whole, a typed key, never an empty one', () => {
  assert.deepEqual(connectionChanges(CONNECTION, {
    label: 'Home gateway', url: CONNECTION.url, config: { profile: 'dev', port: 8642 }, secrets: { apiKey: '' },
  }), { config: { profile: 'dev', port: 8642 } });
  assert.deepEqual(connectionChanges(CONNECTION, {
    label: 'Office', url: CONNECTION.url, allowPrivateNetwork: true, secrets: { apiKey: 'new-key-0123456789' },
  }), { label: 'Office', allowPrivateNetwork: true, secrets: { apiKey: 'new-key-0123456789' } });
  // Clearing an optional field removes it from the config.
  assert.deepEqual(connectionChanges(CONNECTION, { label: 'Home gateway', url: CONNECTION.url, config: { port: 8642 } }), { config: { port: 8642 } });
});

test('a new origin or local-network flag reopens the approval; a new path does not', () => {
  assert.equal(reopensApproval(CONNECTION, { url: 'https://gw.example/p/dev' }), false);
  assert.equal(reopensApproval(CONNECTION, { url: 'https://other.example/base' }), true);
  assert.equal(reopensApproval(CONNECTION, { url: 'https://gw.example:8443/base' }), true);
  assert.equal(reopensApproval(CONNECTION, { allowPrivateNetwork: true }), true);
  assert.equal(reopensApproval(CONNECTION, { label: 'Office', config: { profile: 'dev' } }), false);
});

type Sent = { url: string; method: string; body: unknown };

async function mount(options: { admin?: boolean; occupant?: boolean } = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLFormElement', 'Element', 'Node',
    'NodeFilter', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame',
  ] as const) install(key, key === 'self' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const sent: Sent[] = [];
  let listed = 0;
  let current: UserConnection = { ...CONNECTION };
  install('fetch', async (url: string, init?: RequestInit) => {
    if (url === '/api/ui/plugin-connections/types') return Response.json({ types: [TYPE] });
    if (url === '/api/ui/plugin-connections') { listed += 1; return Response.json({ connections: [current], approvalPolicy: 'admin' }); }
    if (url === '/api/ui/plugin-connections/approvals') {
      return options.admin ? Response.json({ connections: [current] }) : Response.json({ error: 'forbidden' }, { status: 403 });
    }
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Partial<UserConnection>;
      sent.push({ url, method: init.method, body });
      const moved = body.url !== undefined && new URL(body.url).origin !== new URL(current.url).origin;
      current = { ...current, ...body, revision: current.revision + 1, approval: moved && !options.admin ? 'pending' : current.approval };
      return Response.json({ connection: current });
    }
    return new Response(null, { status: 404 });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const slots = await import('./plugin-host/slots');
  slots.resetSlotsForTests();
  slots.declareSlot('settings.connection.form', 'keyed');
  const seen: { mode?: string; initial?: string | null }[] = [];
  if (options.occupant) {
    const { useConnectionForm } = await import('../components/settings/connection-form-slot');
    const Occupant = () => {
      const form = useConnectionForm();
      if (!form) return null;
      seen.push({ mode: form.mode, initial: form.initial?.id ?? null });
      return React.createElement('button', {
        type: 'button',
        onClick: () => void form.submit({ label: form.initial?.label ?? 'New', url: 'https://gw.example/p/dev', secrets: { apiKey: '' } }),
      }, 'Plugin save');
    };
    slots.register({ slot: 'settings.connection.form', key: TYPE.id, pluginId: TYPE.pluginId }, Occupant);
  }
  const { PluginConnectionsSettings } = await import('../components/settings/plugin-connections');
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => { root.render(React.createElement(PluginConnectionsSettings)); });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  await until(() => !!findText('button', 'Edit'), 'the connection list to load');
  const click = async (target: HTMLElement) => { await React.act(async () => { target.click(); }); };
  const type = async (input: HTMLInputElement, value: string) => {
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  const field = (label: string) => {
    const wrapper = Array.from(document.querySelectorAll('label')).find((node) => node.querySelector('span')?.textContent === label);
    const found = wrapper?.querySelector('input');
    if (!found) assert.fail(`field "${label}" not found`);
    return found;
  };
  const note = () => document.querySelector('[role="note"]')?.textContent ?? null;
  const unmount = async () => { await React.act(async () => { root.unmount(); }); slots.resetSlotsForTests(); };
  return { sent, listed: () => listed, seen, until, click, type, field, note, unmount };
}

function findText<T extends HTMLElement>(selector: string, text: string, scope: ParentNode = document): T | undefined {
  return Array.from(scope.querySelectorAll<T>(selector)).find((node) => node.textContent?.trim() === text);
}
function byText<T extends HTMLElement>(selector: string, text: string): T {
  const found = findText<T>(selector, text);
  // Never hand a DOM node to `assert`: on failure it inspects the whole jsdom graph.
  if (!found) assert.fail(`${selector} "${text}" not found`);
  return found;
}

test('Edit opens the form prefilled, with the key left empty, and sends only the changed profile', async () => {
  const ui = await mount();
  try {
    await ui.click(byText('button', 'Edit'));
    assert.equal(ui.field('Name').value, 'Home gateway');
    assert.equal(ui.field('Address').value, 'https://gw.example/base');
    assert.equal(ui.field('Hermes profile').value, 'main');
    const key = ui.field('API server key');
    assert.equal(key.value, '');
    assert.equal(key.required, false, 'a stored key need not be typed again');
    assert.equal(key.placeholder, 'Leave empty to keep the current key');
    assert.match(ui.note() ?? '', /asks an administrator to approve/);

    await ui.type(ui.field('Hermes profile'), 'dev');
    const before = ui.listed();
    await ui.click(byText('button', 'Save'));
    await ui.until(() => ui.sent.length === 1 && ui.listed() > before, 'the PATCH and the refresh');
    assert.deepEqual(ui.sent[0], {
      url: `/api/ui/plugin-connections/${CONNECTION.id}`, method: 'PATCH', body: { config: { profile: 'dev', port: 8642 } },
    });
    await ui.until(() => !findText('button', 'Save'), 'the form to close');
  } finally { await ui.unmount(); }
});

test('a new origin is flagged before saving, and the row then shows the new request', async () => {
  const ui = await mount();
  try {
    await ui.click(byText('button', 'Edit'));
    await ui.type(ui.field('Address'), 'https://other.example/base');
    assert.match(ui.note() ?? '', /needs an administrator's approval again/);
    await ui.click(byText('button', 'Save'));
    await ui.until(() => !!findText('span', 'Awaiting approval'), 'the refreshed row to show the request');
    assert.deepEqual(ui.sent.map((call) => call.body), [{ url: 'https://other.example/base' }]);
  } finally { await ui.unmount(); }
});

test('an administrator gets no approval warning', async () => {
  const ui = await mount({ admin: true });
  try {
    await ui.click(byText('button', 'Edit'));
    await ui.type(ui.field('Address'), 'https://other.example/base');
    assert.equal(ui.note(), null);
  } finally { await ui.unmount(); }
});

test('the plugin\'s own form learns the mode and the connection, and its submit patches', async () => {
  const ui = await mount({ occupant: true });
  try {
    await ui.click(byText('button', 'Add a connection'));
    assert.deepEqual(ui.seen.at(-1), { mode: 'create', initial: null });
    await ui.click(byText('button', 'Edit'));
    assert.deepEqual(ui.seen.at(-1), { mode: 'edit', initial: CONNECTION.id });
    await ui.click(byText('button', 'Plugin save'));
    await ui.until(() => ui.sent.length === 1, 'the PATCH');
    assert.deepEqual(ui.sent[0]?.body, { url: 'https://gw.example/p/dev' });
  } finally { await ui.unmount(); }
});
