/**
 * Files widget → Refresh button: reloads the listed directories and the
 * file that is open in the editor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from '../../lib/test-wait';

async function mount(calls: string[]) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter',
    'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame',
  ] as const) install(key, key === 'self' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const json = (body: unknown) => ({ ok: true, json: async () => body });
  // Electron implements no window.prompt(): a name asked that way never comes (TIM-0132).
  install('prompt', () => { calls.push('prompt()'); return null; });
  install('fetch', async (url: string, init?: { method?: string }) => {
    // Writes are logged with their verb; the listings and reads keep the bare URL the tests match.
    calls.push(init?.method && init.method !== 'GET' ? `${init.method} ${url}` : url);
    if (init?.method === 'POST') return json({ kind: 'renamed' });
    const q = new URL(url, 'http://localhost').searchParams.get('path');
    if (q === 'notes.txt') {
      return json({ kind: 'file', path: 'notes.txt', size: 2, modified: 0, binary: false, truncated: false, content: 'hi' });
    }
    return json({ kind: 'dir', path: '', abs: '/work', entries: [{ name: 'notes.txt', kind: 'file', size: 2, modified: 0, abs: '/work/notes.txt' }] });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { FileBrowser } = await import('./file-browser');
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => { root.render(React.createElement(FileBrowser, { agentId: 'demo' })); });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  await until(() => !!rowOf('notes.txt'), 'the root listing to render notes.txt');
  const click = async (target: HTMLElement, done: () => boolean, what: string) => {
    await React.act(async () => { target.click(); });
    await until(done, what);
  };
  const unmount = async () => { await React.act(async () => { root.unmount(); }); };
  return { click, unmount, act: React.act };
}

function rowOf(name: string) {
  return Array.from(document.querySelectorAll<HTMLElement>('button')).find((node) => node.textContent?.includes(name));
}

test('Refresh reloads the root listing', async () => {
  const calls: string[] = [];
  const ui = await mount(calls);
  try {
    const button = document.querySelector<HTMLElement>('button[aria-label="Refresh files"]');
    if (!button) assert.fail('the toolbar has no accessible Refresh button');
    assert.equal(button.getAttribute('title'), 'Refresh files');

    const row = rowOf('notes.txt');
    if (!row) assert.fail('the root listing did not render notes.txt');
    await ui.click(row, () => calls.some((u) => u.includes('path=notes.txt')), 'the file to open');

    calls.length = 0;
    await ui.click(button, () => calls.some((u) => u.endsWith('/files')), 'the root listing to reload');
    assert.ok(calls.some((u) => u.endsWith('/files')), 'root listing reloaded');
  } finally {
    await ui.unmount();
  }
});

test('the row menu copies the absolute and the relative path', async () => {
  const written: string[] = [];
  const ui = await mount([]);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => { written.push(t); } }, configurable: true });
  try {
    const row = rowOf('notes.txt');
    if (!row) assert.fail('the root listing did not render notes.txt');
    for (const [label, expected] of [['Copy path', '/work/notes.txt'], ['Copy relative path', 'notes.txt']] as const) {
      await ui.act(async () => { row.dispatchEvent(new Event('contextmenu', { bubbles: true, cancelable: true })); });
      const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((n) => n.textContent === label);
      if (!item) assert.fail(`the menu has no "${label}" entry`);
      const before = written.length;
      await ui.click(item, () => written.length > before, `"${label}" to write the clipboard`);
      assert.equal(written.at(-1), expected);
    }
  } finally {
    await ui.unmount();
  }
});

async function openMenuItem(ui: Awaited<ReturnType<typeof mount>>, name: string, label: string) {
  const row = rowOf(name);
  if (!row) assert.fail(`the listing did not render ${name}`);
  await ui.act(async () => { row.dispatchEvent(new Event('contextmenu', { bubbles: true, cancelable: true })); });
  const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((n) => n.textContent === label);
  if (!item) assert.fail(`the menu has no "${label}" entry`);
  await ui.act(async () => { item.click(); });
}

function nameField(): HTMLInputElement {
  const field = document.querySelector<HTMLInputElement>('input[aria-label]');
  if (!field) assert.fail('no name field is open in the tree');
  return field;
}

async function type(ui: Awaited<ReturnType<typeof mount>>, field: HTMLInputElement, value: string, key: string) {
  await ui.act(async () => {
    field.value = value;
    field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

test('Rename edits the name in place, its stem selected, and sends it on Enter (TIM-0132)', async () => {
  const calls: string[] = [];
  const ui = await mount(calls);
  try {
    await openMenuItem(ui, 'notes.txt', 'Rename');
    const field = nameField();
    assert.equal(field.getAttribute('aria-label'), 'New name for "notes.txt"');
    assert.equal(document.activeElement, field, 'the field takes the focus');
    assert.equal(field.value, 'notes.txt');
    assert.deepEqual([field.selectionStart, field.selectionEnd], [0, 'notes'.length], 'the stem is selected, not the extension');

    await type(ui, field, ' draft.txt ', 'Enter');
    assert.ok(!document.querySelector('input[aria-label]'), 'the field closes');
    const sent = calls.filter((u) => u.startsWith('POST '));
    assert.deepEqual(sent, ['POST /api/ui/agents/demo/files?path=notes.txt&action=rename&name=draft.txt']);
    assert.ok(!calls.includes('prompt()'), 'window.prompt() is never asked');
  } finally {
    await ui.unmount();
  }
});

test('Escape, a blank name or the same name renames nothing (TIM-0132)', async () => {
  const calls: string[] = [];
  const ui = await mount(calls);
  try {
    for (const [value, key] of [['other.txt', 'Escape'], ['   ', 'Enter'], ['notes.txt', 'Enter']] as const) {
      await openMenuItem(ui, 'notes.txt', 'Rename');
      await type(ui, nameField(), value, key);
      assert.ok(!document.querySelector('input[aria-label]'), `${key} on "${value}" closes the field`);
    }
    assert.deepEqual(calls.filter((u) => u.startsWith('POST ')), [], 'nothing was sent');
    assert.ok(rowOf('notes.txt'), 'the row is back');
  } finally {
    await ui.unmount();
  }
});

test('New file and New folder ask their name in the tree, not in window.prompt() (TIM-0132)', async () => {
  const calls: string[] = [];
  const ui = await mount(calls);
  try {
    for (const [button, name, expected] of [
      ['New file', 'todo.md', 'POST /api/ui/agents/demo/files?path=todo.md'],
      ['New folder', 'notes', 'POST /api/ui/agents/demo/files?path=notes&action=mkdir'],
    ] as const) {
      const trigger = document.querySelector<HTMLElement>(`button[aria-label="${button}"]`);
      if (!trigger) assert.fail(`the toolbar has no ${button} button`);
      await ui.act(async () => { trigger.click(); });
      const field = nameField();
      assert.equal(document.activeElement, field);
      await type(ui, field, name, 'Enter');
      assert.equal(calls.filter((u) => u.startsWith('POST ')).at(-1), expected);
    }
    assert.ok(!calls.includes('prompt()'), 'window.prompt() is never asked');
  } finally {
    await ui.unmount();
  }
});
