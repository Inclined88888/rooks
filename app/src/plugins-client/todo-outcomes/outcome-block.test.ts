import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * OutcomeBlock warns when only the public note changes on an already-announced
 * resolution: the daemon fires todo_resolved on resolution changes only, so a
 * note-only save reaches no one.
 */

type StoredOutcome = { resolution: string | null; public_note: string | null; duplicate_of: string | null };
type Ctx = { React: typeof import('react'); root: import('react-dom/client').Root };

async function montrer(stored: StoredOutcome, run: (ctx: Ctx) => void | Promise<void>) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement',
    'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver',
    'CustomEvent', 'Event', 'KeyboardEvent', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame',
  ] as const) install(key, key === 'self' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  install('fetch', async (input: string) => {
    if (String(input).includes('config')) return Response.json({ enabled: true });
    if (String(input).includes('outcome')) return Response.json({ outcome: stored });
    return Response.json({});
  });

  const { declareSlot, register, slotKind } = await import('@/lib/plugin-host/slots');
  const { OutcomeBlock } = await import('./outcome-block');
  const { TodoFormModal } = await import('../kanban/todo-form-modal');
  const undo: Array<() => void> = [];
  if (slotKind('kanban.todo.detail') === null) undo.push(declareSlot('kanban.todo.detail', 'list'));
  undo.push(register({ slot: 'kanban.todo.detail', pluginId: 'test/outcome-block' }, OutcomeBlock));

  const item = {
    id: 42, text: 'an idea', project: 'rooks', author: 'Robin', status: 'promoted', notes: null,
    created_at: 1, updated_at: 1, done_at: null, promoted_task_id: null, urgency: null, progress: 'todo',
  };
  const root = createRoot(document.getElementById('root')!);
  try {
    await React.act(async () => {
      root.render(React.createElement(TodoFormModal, {
        item, onClose: () => {}, onSaved: () => {},
      } as never));
    });
    await run({ React, root });
  } finally {
    await React.act(async () => { root.unmount(); });
    // Flush any remaining async microtasks before restoring globals and closing
    // the jsdom window: pending fetch continuations would use a stale Event class.
    await new Promise<void>((r) => setTimeout(r, 20));
    for (const fn of undo.reverse()) fn();
    const globals = globalThis as Record<string, unknown>;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
    dom.window.close();
  }
}

// The detail dialog's title is a textarea too, and comes first: select the
// outcome's public note by its placeholder, never the first textarea.
function noteTextarea(): HTMLTextAreaElement {
  const textarea = document.querySelector<HTMLTextAreaElement>('textarea[placeholder^="A short word for the author"]');
  assert.ok(textarea, 'the public note textarea is rendered');
  return textarea;
}

function changeTextarea(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    (globalThis as unknown as { HTMLTextAreaElement: typeof HTMLTextAreaElement }).HTMLTextAreaElement.prototype,
    'value',
  )!.set!;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

test('note only change on existing resolution shows warning', async () => {
  await montrer({ resolution: 'fixed', public_note: 'hello', duplicate_of: null }, async ({ React }) => {
    const textarea = noteTextarea();
    await React.act(async () => { changeTextarea(textarea, 'changed note'); });
    assert.match(document.body.textContent!, /not announced to the author/);
  });
});

test('no warning before any change', async () => {
  await montrer({ resolution: 'fixed', public_note: 'hello', duplicate_of: null }, () => {
    assert.doesNotMatch(document.body.textContent!, /not announced to the author/);
  });
});

test('no warning when stored resolution is null', async () => {
  await montrer({ resolution: null, public_note: null, duplicate_of: null }, async ({ React }) => {
    const textarea = noteTextarea();
    await React.act(async () => { changeTextarea(textarea, 'some note'); });
    assert.doesNotMatch(document.body.textContent!, /not announced to the author/);
  });
});

test('no warning when resolution also changes', async () => {
  await montrer({ resolution: 'fixed', public_note: 'hello', duplicate_of: null }, async ({ React }) => {
    const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('Declined'));
    assert.ok(button, 'Declined chip is rendered');
    await React.act(async () => { button.click(); });
    const textarea = noteTextarea();
    await React.act(async () => { changeTextarea(textarea, 'changed note'); });
    assert.doesNotMatch(document.body.textContent!, /not announced to the author/);
  });
});
