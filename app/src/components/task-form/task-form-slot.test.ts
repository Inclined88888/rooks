/**
 * The task form's slot `task.form`: declared at boot, the product's form is
 * painted while nothing claims it, a plugin loaded through the real client
 * loader takes its place on every host and saves through the host, and its
 * removal gives the product's form back. The `examples/plugin-task-form`
 * template does the same with the SDK alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ComponentType } from 'react';
import { waitUntil } from '../../lib/test-wait';
import type { TaskFormSource } from './task-form-model';

const ACME = { id: 'acme-task-form', state: 'active', client: { url: '/x', rev: '1', slots: ['task.form'] } };

type Call = { method: string; url: string; body: Record<string, unknown> | null };

async function mount(plugins: unknown[] = []) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLFormElement',
    'HTMLSelectElement', 'HTMLTextAreaElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'SubmitEvent',
    'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'DocumentFragment'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const calls: Call[] = [];
  install('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null });
    if (url === '/api/ui/plugins') return Response.json({ plugins });
    if (url === '/api/ui/tasks' && method === 'POST') return Response.json({ task: { id: 'created' } }, { status: 201 });
    if (url.startsWith('/api/ui/tasks/') && method === 'PUT') return Response.json({ task: {} });
    if (url.includes('/api/ui/backends/catalog')) return Response.json({ defaultBackend: 'claude', backends: [] });
    if (url === '/api/ui/tasks') return Response.json({ tasks: [] });
    if (url === '/api/ui/agents') return Response.json({ agents: [] });
    return Response.json({}, { status: 404 });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  const loader = await import('@/lib/plugin-host/loader');
  loader.resetClientPluginsForTests();
  const { TaskFormModal } = await import('../task-form-modal');
  const { ProductTaskForm } = await import('./task-form');
  const context = await import('./task-form-context');

  const root = createRoot(document.getElementById('root')!);
  let finished = 0;
  const render = async (element: React.ReactElement) => {
    await React.act(async () => { root.render(element); });
  };
  const host = (task: TaskFormSource | null = null) => React.createElement(TaskFormModal, {
    task, agents: [{ name: 'coder' }], onSaved: () => { finished++; }, onClose: () => {},
  });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
  };
  const productForms = () => document.querySelectorAll('[role="tablist"]').length;
  const occupants = () => slots.slotEntries('task.form').map((e) => e.pluginId);
  /** The product's form, registered as the bundled half of `@timon/kanban` does. */
  const registerProduct = () => slots.register({ slot: 'task.form', fallback: true, pluginId: '@timon/kanban' }, ProductTaskForm);

  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    loader.setLoadClientModuleForTests(null);
    loader.resetClientPluginsForTests();
    slots.resetSlotsForTests();
    await new Promise((r) => setTimeout(r, 0));
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { React, dom, calls, context, slots, loader, render, host, until, click, productForms, occupants, registerProduct, unmount, finished: () => finished };
}

type Mounted = Awaited<ReturnType<typeof mount>>;

function acmeForm(m: Mounted, seen: Array<unknown>): ComponentType {
  const { React, context } = m;
  return function AcmeForm() {
    const host = context.useTaskForm();
    seen.push(host);
    if (!host) return null;
    return React.createElement('div', { 'data-acme': host.mode },
      React.createElement('h2', { id: host.titleId }, 'Acme'),
      React.createElement('button', {
        type: 'button', 'data-acme-save': '',
        onClick: () => void host.submit({
          title: 'From acme', description: '', agent_name: 'coder', priority: 2, type: 'doc', deps: [], scheduled_at: null,
          backend_override: null, model_override: null, fallback_backend_override: null, fallback_model_override: null,
          permission_mode_override: null, extra_skills: [], extra_mcp_servers: [], extra_allowed_tools: [], todo_id: null,
        }).then((r) => { if (r.ok) host.finish(); }),
      }, 'save'));
  };
}

test('the slot is declared at boot, and an empty slot still paints the product form', async () => {
  const m = await mount();
  try {
    assert.equal(m.slots.slotKind('task.form'), 'single');
    await m.render(m.host());
    await m.until(() => m.productForms() === 1, 'the product form');
    const dispose = m.registerProduct();
    assert.equal(m.slots.slotEntries('task.form')[0]?.fallback, true);
    await m.until(() => m.productForms() === 1, 'the product form through the slot');
    await m.React.act(async () => { dispose(); });
    // Outside a host, the product occupant has nothing to paint.
    await m.render(m.React.createElement(m.React.Fragment, null, m.React.createElement(await import('./task-form').then((x) => x.ProductTaskForm))));
    assert.equal(m.productForms(), 0);
  } finally {
    await m.unmount();
  }
});

test('the kanban module registers the product form as the fallback of task.form', () => {
  const source = readFileSync(resolve(process.cwd(), 'src', 'plugins-client', 'kanban.tsx'), 'utf8');
  assert.match(source, /ctx\.register\(\{ slot: TASK_FORM_SLOT, fallback: true \}, ProductTaskForm\)/);
  for (const screen of ['src/plugins-client/kanban/kanban-page.tsx', 'src/app/agents/agents-client.tsx', 'src/app/agents-grid/agents-grid-client.tsx']) {
    assert.match(readFileSync(resolve(process.cwd(), screen), 'utf8'), /<TaskFormModal/, `${screen} opens the form through its host`);
  }
});

test('a plugin takes the slot, reads the host, saves through it, and its removal gives the product form back', async () => {
  const m = await mount([ACME]);
  const seen: unknown[] = [];
  try {
    const dispose = m.registerProduct();
    m.loader.setLoadClientModuleForTests(async () => ({
      apply(ctx) { ctx.slots.register({ slot: 'task.form' }, acmeForm(m, seen)); },
    }));
    await m.loader.syncClientPlugins();
    assert.equal(m.occupants()[0], 'acme-task-form', 'the replacement wins over the fallback');
    await m.render(m.host({ id: 'edited', title: 'x', agent_name: 'coder', priority: 3, deps: '[]' }));
    await m.until(() => !!document.querySelector('[data-acme="edit"]'), 'the replacement');
    assert.equal(m.productForms(), 0, 'the product form is not painted under it');
    const dialog = document.querySelector('[role="dialog"]');
    assert.equal(document.getElementById(dialog!.getAttribute('aria-labelledby')!)?.textContent, 'Acme', 'the host frames it');
    await m.click(document.querySelector('[data-acme-save]'));
    await m.until(() => m.finished() === 1, 'the screen told to re-read');
    assert.deepEqual(m.calls.map((c) => `${c.method} ${c.url}`), ['PUT /api/ui/tasks/edited']);

    m.loader.setLoadClientModuleForTests(null);
    await m.React.act(async () => { m.loader.resetClientPluginsForTests(); });
    await m.until(() => m.productForms() === 1, 'the product form back');
    await m.React.act(async () => { dispose(); });
  } finally {
    await m.unmount();
  }
});

/** `examples/plugin-task-form`, loaded as the platform loads it: `react` and `@timon/ui` are the platform's own. */
async function loadExample(): Promise<{ apply: (ctx: unknown) => void; cleanup: () => void }> {
  const source = readFileSync(resolve(process.cwd(), '..', 'examples', 'plugin-task-form', 'lib', 'client.js'), 'utf8');
  const platform = source
    .replace(/import React from 'react'\n/, 'const React = globalThis.__taskFormTestReact\n')
    .replace(/import \{([^}]*)\} from '@timon\/ui'\n/, 'const {$1} = globalThis.__taskFormTestUi\n');
  assert.notEqual(platform, source, 'the client still imports react and @timon/ui');
  const React = await import('react');
  const { UI_KIT } = await import('@/lib/plugin-host/ui-kit');
  Object.assign(globalThis, { __taskFormTestReact: React, __taskFormTestUi: UI_KIT });
  const dir = mkdtempSync(join(tmpdir(), 'task-form-example-'));
  const file = join(dir, 'client.mjs');
  writeFileSync(file, platform);
  const mod = await import(pathToFileURL(file).href) as { apply: (ctx: unknown) => void };
  return { apply: mod.apply, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the examples/plugin-task-form template replaces the form with the SDK alone and keeps what it does not edit', async () => {
  const m = await mount();
  const example = await loadExample();
  try {
    const disposeProduct = m.registerProduct();
    const disposers: Array<() => void> = [];
    example.apply({
      id: 'example-task-form',
      slots: { register: (options: { slot: string }, Component: ComponentType) => {
        const dispose = m.slots.register({ ...options, pluginId: 'example-task-form' }, Component);
        disposers.push(dispose);
        return dispose;
      } },
    });
    assert.equal(m.occupants()[0], 'example-task-form');
    await m.render(m.host({
      id: 'kept', title: 'Keep me', agent_name: 'coder', priority: 4, deps: '["dep-1"]', type: 'code',
      extra_skills: '["tdd"]', backend_override: 'codex', model_override: 'gpt-5.5', todo_id: 12,
    }));
    await m.until(() => !!document.querySelector('[data-quick-save]'), 'the quick form');
    assert.equal(m.productForms(), 0);
    await m.click(document.querySelector('[data-quick-save]'));
    await m.until(() => m.finished() === 1, 'the save');
    const put = m.calls.find((c) => c.method === 'PUT')!;
    assert.equal(put.url, '/api/ui/tasks/kept');
    assert.deepEqual(put.body?.deps, ['dep-1']);
    assert.deepEqual(put.body?.extra_skills, ['tdd']);
    assert.equal(put.body?.model_override, 'gpt-5.5');
    assert.equal(put.body?.todo_id, 12);
    await m.React.act(async () => { for (const d of disposers.splice(0)) d(); });
    await m.until(() => m.productForms() === 1, 'the product form back');
    await m.React.act(async () => { disposeProduct(); });
  } finally {
    example.cleanup();
    await m.unmount();
  }
});
