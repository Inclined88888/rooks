import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * The outcome block of `@timon/todo-outcomes`, in the TO DO detail slot:
 * hidden while the daemon keeps outcomes off, and sending only what changed —
 * each new outcome is announced to the author.
 */
type Outcome = { resolution: string | null; public_note: string | null; duplicate_of: string | null };
type Call = { url: string; body?: Record<string, unknown> };

async function mount(opts: { enabled: boolean; outcome?: Outcome }) {
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
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const calls: Call[] = [];
  install('fetch', async (input: string, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (String(input).endsWith('/todo-outcomes/config')) return Response.json({ enabled: opts.enabled });
    if (String(input).includes('/todo-outcomes/outcome/')) {
      return Response.json({ outcome: opts.outcome ?? { resolution: null, public_note: null, duplicate_of: null } });
    }
    return Response.json({ item: {} });
  });
  const { declareSlot, register, slotKind } = await import('./plugin-host/slots');
  const { TodoDetailSlot } = await import('../plugins-client/kanban/todo-detail-slot');
  const { todoOutcomesClient } = await import('../plugins-client/todo-outcomes');
  const undo: Array<() => void> = [];
  if (slotKind('kanban.todo.detail') === null) undo.push(declareSlot('kanban.todo.detail', 'list'));
  todoOutcomesClient.apply({
    register: (o: { slot: string; order?: number }, C: React.ComponentType) => {
      const off = register({ ...o, pluginId: '@timon/todo-outcomes' }, C);
      undo.push(off);
      return off;
    },
  } as never);
  let saved = 0;
  const item = {
    id: 42, text: 'TIM-0042 · idea', project: 'timon', author: 'Robin', status: 'open', notes: null,
    created_at: 1, updated_at: 1, done_at: null, promoted_task_id: null, urgency: null, progress: 'todo',
  };
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(React.createElement(TodoDetailSlot, { item: item as never, saved: () => { saved += 1; } }));
  });
  const cleanup = async () => {
    await React.act(async () => { root.unmount(); });
    for (const fn of undo.reverse()) fn();
  };
  return { React, calls, cleanup, saved: () => saved };
}

/** Types into a React-controlled field the way a browser does. */
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}
function button(label: RegExp): HTMLButtonElement {
  const b = Array.from(document.querySelectorAll('button')).find((el) => label.test(el.textContent ?? ''));
  assert.ok(b, `button ${label}`);
  return b as HTMLButtonElement;
}

test('the block stays hidden while the daemon keeps outcomes off', async () => {
  const m = await mount({ enabled: false });
  assert.doesNotMatch(document.body.textContent!, /outcome|Discord/i);
  assert.equal(m.calls.some((c) => c.url.includes('/outcome/')), false, 'no outcome read when off');
  await m.cleanup();
});

test('the outcome, its public note and the duplicate reference are sent only once changed', async () => {
  const m = await mount({ enabled: true });
  assert.match(document.body.textContent!, /Visible to the author, wherever the idea came from/);
  assert.doesNotMatch(document.body.textContent!, /Discord/, 'the plugin speaks of the author and their channel, not of one connector');
  assert.ok(!document.querySelector('input[placeholder="TIM-0001"]'), 'no duplicate field before duplicate');
  assert.equal(button(/^Save outcome$/).disabled, true, 'nothing changed yet');
  await m.React.act(async () => { button(/^Duplicate$/).click(); });
  assert.match(document.body.textContent!, /also closes the idea/);
  const ref = document.querySelector('input[placeholder="TIM-0001"]') as HTMLInputElement;
  await m.React.act(async () => { type(ref, 'tim-12'); });
  assert.equal(button(/^Save outcome$/).disabled, true, 'an invalid reference blocks the save');
  await m.React.act(async () => { type(ref, 'tim-0007'); });
  const note = Array.from(document.querySelectorAll('textarea')).find((el) => el.placeholder.startsWith('A short word')) as HTMLTextAreaElement;
  await m.React.act(async () => { type(note, ' Tracked in TIM-0007. '); });
  await m.React.act(async () => { button(/^Save outcome$/).click(); });
  const patch = m.calls.at(-1)!;
  assert.equal(patch.url, '/api/ui/project-todo/42');
  assert.deepEqual(patch.body, { resolution: 'duplicate', duplicate_of: 'TIM-0007', public_note: 'Tracked in TIM-0007.' });
  assert.equal(m.saved(), 1, 'the notebook re-reads the idea');
  await m.cleanup();
});

test('an outcome already given is not resent with a note edit', async () => {
  const m = await mount({ enabled: true, outcome: { resolution: 'needs_info', public_note: 'Which OS?', duplicate_of: null } });
  assert.match(document.body.textContent!, /announced to the author/);
  const note = document.querySelector('textarea') as HTMLTextAreaElement;
  assert.equal(note.value, 'Which OS?');
  await m.React.act(async () => { type(note, 'Which OS and version?'); });
  await m.React.act(async () => { button(/^Save outcome$/).click(); });
  assert.deepEqual(m.calls.at(-1)!.body, { public_note: 'Which OS and version?' });
  await m.cleanup();
});

test('every outcome has a colour and a label in both locales; a duplicate points to a TIM or SUG item', async () => {
  const { RESOLUTION_CLASS, TODO_DUPLICATE_OF_RE, TODO_RESOLUTIONS } = await import('../plugins-client/todo-outcomes/vocabulary');
  const en = (await import('../locales/en/core.json')).default;
  const fr = (await import('../locales/fr/core.json')).default;
  for (const r of TODO_RESOLUTIONS) {
    assert.ok(RESOLUTION_CLASS[r], r);
    assert.ok(en.todoOutcomes.resolution[r], `en ${r}`);
    assert.ok(fr.todoOutcomes.resolution[r], `fr ${r}`);
  }
  for (const ok of ['TIM-0001', 'SUG-123456']) assert.ok(TODO_DUPLICATE_OF_RE.test(ok), ok);
  for (const bad of ['TIM-12', 'BUG-0001', 'tim-0001', 'TIM-0001 ']) assert.ok(!TODO_DUPLICATE_OF_RE.test(bad), bad);
});
