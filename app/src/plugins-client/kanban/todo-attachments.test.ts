/**
 * A TO DO idea's attached files in the product's surfaces (TODO #837, volet
 * E): the detail lists them, sends a dropped file at once and removes one;
 * a refusal reads in the interface's words, before the upload (type) or from
 * the daemon (size); the quick entry holds its files until the idea exists;
 * the tile shows its 📎 count.
 *
 * Assertions compare texts and booleans, never DOM nodes: an inspected jsdom
 * node blows the memory guard when an assertion fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReactElement } from 'react';
import { waitUntil } from '../../lib/test-wait';
import type { KanbanTodoCardValue } from './kanban-card-context';
import type { ProjectTodo } from './project-todo-types';
import type { TodoAttachment } from '@/lib/task-attachments';

const IDEA: ProjectTodo = {
  id: 209, text: 'Unify the cards', project: 'timon', author: 'agent.main', status: 'open', notes: null,
  created_at: 1, updated_at: 1, done_at: null, promoted_task_id: null, urgency: null, progress: null,
};

const STORED: TodoAttachment = {
  id: '0f7c5e2a-9a1b-4c3d-8e5f-0a1b2c3d4e5f', todo_id: 209, name: 'mockup.png', size: 2048,
  mime: 'image/png', kind: 'image', created_at: 1,
};

type Call = { method: string; url: string; body: Record<string, unknown> | null };
type Answer = (call: Call) => Response | null;

async function mount(answer: Answer = () => null) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/kanban', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
    'HTMLTextAreaElement', 'SVGElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event',
    'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'DocumentFragment'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const calls: Call[] = [];
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null,
    };
    calls.push(call);
    const custom = answer(call);
    if (custom) return custom;
    if (call.url.startsWith('/api/ui/tasks?')) return Response.json({ tasks: [] });
    if (call.url === '/api/ui/project-todo/209/attachments' && call.method === 'GET') return Response.json({ attachments: [STORED] });
    if (/\/attachments$/.test(call.url) && call.method === 'POST') {
      const id = Number(call.url.split('/')[4]);
      return Response.json({ attachment: { ...STORED, id: crypto.randomUUID(), todo_id: id, name: call.body?.name, mime: 'text/markdown', kind: 'document' } }, { status: 201 });
    }
    if (call.method === 'DELETE') return Response.json({ ok: true });
    if (call.url === '/api/ui/project-todo' && call.method === 'POST') return Response.json({ item: { ...IDEA, id: 210 } }, { status: 201 });
    if (call.url.startsWith('/api/ui/project-todo')) return Response.json({ item: IDEA });
    return Response.json({});
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();

  const root = createRoot(document.getElementById('root')!);
  const render = async (element: ReactElement) => { await React.act(async () => { root.render(element); }); };
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
  };
  const type = async (el: Element | null | undefined, value: string) => {
    assert.ok(el, 'field to type in');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  const addFiles = async (files: File[]) => {
    const input = document.querySelector<HTMLInputElement>('[data-attachment-input]');
    assert.ok(input, 'the file input');
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    await React.act(async () => { input.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
  };
  const paste = async (target: Element | null | undefined, files: File[]) => {
    assert.ok(target, 'element to paste in');
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files, getData: () => '' } });
    await React.act(async () => { target.dispatchEvent(event); });
    return event.defaultPrevented;
  };
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    await React.act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    slots.resetSlotsForTests();
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { React, calls, render, until, click, type, addFiles, paste, unmount };
}

type Mounted = Awaited<ReturnType<typeof mount>>;

async function renderPopup(m: Mounted, item: ProjectTodo | null, record: string[] = []) {
  const { TodoFormModal } = await import('./todo-form-modal');
  await m.render(m.React.createElement(TodoFormModal, {
    item, defaultProject: 'timon',
    onSaved: () => { record.push('saved'); },
    onClose: () => { record.push('closed'); },
  }));
  await m.until(() => !!document.querySelector('[role="dialog"]'), 'the popup');
}

const $ = (selector: string) => document.querySelector(selector);
const text = () => document.body.textContent ?? '';

test('the detail lists the idea\'s files in the attachments zone, an image as a thumbnail served under the idea', async () => {
  const m = await mount();
  try {
    await renderPopup(m, IDEA);
    await m.until(() => !!$('[data-attachment="mockup.png"]'), 'the stored file');
    assert.ok($('[data-detail-shell-attachments] [data-attachment="mockup.png"]'), 'in the DetailShell attachments zone');
    assert.equal($('[data-detail-shell-attachments]')?.getAttribute('aria-label'), 'Attachments');
    assert.equal($('[data-attachment="mockup.png"] img')?.getAttribute('src'), `/api/ui/project-todo/209/attachments/${STORED.id}`);
    assert.match($('[data-attachment="mockup.png"]')?.textContent ?? '', /2 kB/);
    assert.equal(
      $('[data-attachment="mockup.png"] a')?.getAttribute('href'),
      `/api/ui/project-todo/209/attachments/${STORED.id}`,
      'an image opens inline',
    );
  } finally {
    await m.unmount();
  }
});

test('a file dropped on the detail is sent at once, a stored one is removed, and the screen reads the ideas again on close', async () => {
  const m = await mount();
  const record: string[] = [];
  try {
    await renderPopup(m, IDEA, record);
    await m.until(() => !!$('[data-attachment="mockup.png"]'), 'the stored file');
    await m.addFiles([new File(['# notes'], 'notes.md', { type: 'text/markdown' })]);
    await m.until(() => m.calls.some((c) => c.method === 'POST' && c.url === '/api/ui/project-todo/209/attachments'), 'the upload');
    const post = m.calls.find((c) => c.method === 'POST')!;
    assert.deepEqual(post.body, { name: 'notes.md', data: Buffer.from('# notes').toString('base64'), mime: 'text/markdown' });
    await m.until(() => !text().includes('Sending…') && !!$('[data-attachment="notes.md"] a'), 'the upload to end');

    await m.click($('[aria-label="Remove mockup.png"]'));
    await m.until(() => !$('[data-attachment="mockup.png"]'), 'the removal');
    assert.ok(m.calls.some((c) => c.method === 'DELETE' && c.url === `/api/ui/project-todo/209/attachments/${STORED.id}`));
    assert.deepEqual(record, [], 'no re-read while the popup is open: it would reset the drafts');
    await m.click($('[aria-label="Close"]'));
    assert.deepEqual(record, ['saved', 'closed']);
  } finally {
    await m.unmount();
  }
});

test('a re-read of the list after a file change keeps the edition in progress', async () => {
  const m = await mount();
  try {
    await renderPopup(m, IDEA);
    await m.until(() => !!$('[data-attachment="mockup.png"]'), 'the stored file');
    const title = $('textarea[aria-label="Title"]');
    await m.React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(title, 'A title being written');
      title!.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    // The daemon announced the file, the screen read its ideas again: same idea, new object, one more file.
    await renderPopup(m, { ...IDEA, attachment_count: 2 });
    assert.equal(($('textarea[aria-label="Title"]') as HTMLTextAreaElement | null)?.value, 'A title being written');
    await renderPopup(m, { ...IDEA, text: 'Renamed elsewhere' });
    assert.equal(($('textarea[aria-label="Title"]') as HTMLTextAreaElement | null)?.value, 'Renamed elsewhere', 'a real change still shows');
  } finally {
    await m.unmount();
  }
});

test('a pasted file is attached, a paste of text is left to its field', async () => {
  const m = await mount();
  try {
    await renderPopup(m, IDEA);
    await m.until(() => !!$('[data-attachment="mockup.png"]'), 'the stored file');
    const title = $('textarea[aria-label="Title"]');
    assert.equal(await m.paste(title, []), false, 'a text paste is not taken');
    assert.equal(await m.paste(title, [new File(['shot'], 'shot.png', { type: 'image/png' })]), true);
    await m.until(() => m.calls.some((c) => c.method === 'POST' && c.body?.name === 'shot.png'), 'the pasted upload');
  } finally {
    await m.unmount();
  }
});

test('a refused type is told before any upload, a file the daemon finds too large in the interface\'s words', async () => {
  const m = await mount((call) => (call.method === 'POST' && call.url.endsWith('/attachments')
    ? Response.json({ error: 'Internal: payload 16777216 > 15728640', code: 'attachment_too_large' }, { status: 413 })
    : null));
  try {
    await renderPopup(m, IDEA);
    await m.until(() => !!$('[data-attachment="mockup.png"]'), 'the stored file');
    await m.addFiles([new File(['MZ'], 'setup.exe')]);
    assert.match($('[role="alert"]')?.textContent ?? '', /setup\.exe: this type of file is not accepted\./);
    assert.equal(m.calls.some((c) => c.method === 'POST'), false, 'nothing sent');

    await m.addFiles([new File(['x'], 'big.pdf', { type: 'application/pdf' })]);
    await m.until(() => /big\.pdf: too large \(15 MB at most\)\./.test($('[role="alert"]')?.textContent ?? ''), 'the daemon\'s refusal');
    assert.equal(text().includes('Internal: payload'), false, 'never the daemon\'s raw text');
    assert.equal($('[data-attachment="big.pdf"]'), null, 'the refused file leaves the list');
  } finally {
    await m.unmount();
  }
});

test('a quota or an unexplained failure from the daemon reads in the idea\'s words, never in its text', async () => {
  let refusal = { status: 413, body: { error: 'quota exceeded for todo 209', code: 'attachment_quota' } };
  const m = await mount((call) => (call.method === 'POST' && call.url.endsWith('/attachments')
    ? Response.json(refusal.body, { status: refusal.status })
    : null));
  try {
    await renderPopup(m, IDEA);
    await m.until(() => !!$('[data-attachment="mockup.png"]'), 'the stored file');
    await m.addFiles([new File(['a'], 'a.txt', { type: 'text/plain' })]);
    await m.until(() => /a\.txt: the idea already holds as many files as it can/.test(text()), 'the quota');
    refusal = { status: 500, body: { error: 'EACCES: /home/x/.timon/uploads', code: 'attachment_write_failed' } };
    await m.addFiles([new File(['b'], 'b.txt', { type: 'text/plain' })]);
    await m.until(() => /b\.txt: could not be sent\./.test(text()), 'the failure');
    assert.equal(text().includes('EACCES'), false);
  } finally {
    await m.unmount();
  }
});

test('the quick entry holds its files and sends them once the idea exists, under its new id', async () => {
  const m = await mount();
  const record: string[] = [];
  try {
    await renderPopup(m, null, record);
    await m.addFiles([new File(['# spec'], 'spec.md', { type: 'text/markdown' })]);
    assert.match($('[data-attachment="spec.md"]')?.textContent ?? '', /Sent when the idea is added/);
    assert.equal(m.calls.some((c) => c.url.includes('/attachments')), false, 'nothing sent before the idea exists');
    await m.type($('input[placeholder="The idea, in one line"]'), 'Idea with a spec');
    await m.click(Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Add'));
    await m.until(() => record.includes('closed'), 'the popup closed');
    const order = m.calls.filter((c) => c.method === 'POST').map((c) => c.url);
    assert.deepEqual(order, ['/api/ui/project-todo', '/api/ui/project-todo/210/attachments']);
    assert.equal(m.calls.find((c) => c.url === '/api/ui/project-todo/210/attachments')?.body?.name, 'spec.md');
  } finally {
    await m.unmount();
  }
});

/** One idea's tile through the real host. */
async function renderTile(m: Mounted, density: 'card' | 'row', item: ProjectTodo) {
  const { KanbanCardHost } = await import('./kanban-card-slot');
  const value: KanbanTodoCardValue = {
    kind: 'todo', density, item, show: { id: true, author: true, project: true },
    open: () => {}, toggleDone: null, handoff: null, remove: null,
  };
  const host = m.React.createElement(KanbanCardHost, { value });
  await m.render(density === 'row' ? m.React.createElement('ul', null, host) : host);
}

test('the tile shows its 📎 and its number of files, in the card\'s meta and among the row\'s tags; none without a file', async () => {
  const m = await mount();
  try {
    await renderTile(m, 'card', { ...IDEA, attachment_count: 3 });
    assert.equal($('[data-board-card-meta] [data-todo-attachments]')?.textContent, '3');
    assert.equal($('[data-todo-attachments]')?.getAttribute('aria-label'), '3 attachment(s)');
    await renderTile(m, 'row', { ...IDEA, attachment_count: 2 });
    assert.equal($('[data-density="row"] [data-todo-attachments]')?.textContent, '2');
    await renderTile(m, 'card', { ...IDEA, attachment_count: 0 });
    assert.equal($('[data-todo-attachments]'), null);
    await renderTile(m, 'row', IDEA);
    assert.equal($('[data-todo-attachments]'), null, 'an older daemon without the count');
  } finally {
    await m.unmount();
  }
});
