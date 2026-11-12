/**
 * The drop target of a multichat cell (`app/multichat/slot-drop-zone.tsx`).
 *
 * The cell itself mounts `ChatClient`, which needs the Next router and the
 * whole chat runtime; the drop contract lives in the zone, so the zone is
 * mounted here around a stand-in for the chat — deep children, and a composer
 * that takes file drops of its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

type FakeTransfer = { types: string[]; getData: (type: string) => string; dropEffect: string };

function transfer(types: string[], data: Record<string, string> = {}): FakeTransfer {
  return { types, getData: (type) => data[type] ?? '', dropEffect: 'none' };
}

async function mount(props: { draggingAgent?: string | null; occupant?: string | null; swap?: boolean } = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { SlotDropZone } = await import('../app/multichat/slot-drop-zone');

  const dropped: Array<[string, number]> = [];
  const filesDropped: string[] = [];
  const h = React.createElement;
  // The composer's own file drop, as `components/chat/composer.tsx` does it.
  const composer = h('div', {
    id: 'composer',
    onDragOver: (e: { dataTransfer: FakeTransfer; preventDefault: () => void }) => {
      if (e.dataTransfer.types.includes('Files')) e.preventDefault();
    },
    onDrop: (e: { dataTransfer: FakeTransfer; preventDefault: () => void }) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      filesDropped.push('file');
    },
  }, h('textarea', { id: 'input' }));
  const chat = h('div', { id: 'chat' }, h('div', null, h('p', null, h('span', { id: 'deep' }, 'a message'))), composer);

  const root = createRoot(document.getElementById('root')!);
  const render = async (next: typeof props) => {
    await React.act(async () => {
      root.render(h(SlotDropZone, {
        slotIndex: 3,
        draggingAgent: next.draggingAgent ?? null,
        occupant: next.occupant ?? null,
        swap: next.swap ?? false,
        onDropAgent: (name: string, index: number) => { dropped.push([name, index]); },
        className: 'relative',
        children: chat,
      }));
    });
  };
  await render(props);

  const fire = async (target: Element, type: string, dataTransfer: FakeTransfer) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    await React.act(async () => { target.dispatchEvent(event); });
    return event;
  };
  const layer = () => document.querySelector('[data-slot-drop-layer]');
  const byId = (id: string) => document.getElementById(id)!;
  const unmount = async () => { await React.act(async () => { root.unmount(); }); dom.window.close(); };
  return { fire, layer, byId, dropped, filesDropped, render, unmount };
}

test('an agent dropped on a deep child of an occupied cell lands on that cell', async () => {
  const { fire, byId, dropped, unmount } = await mount({ occupant: 'rooks.coder' });
  try {
    const agent = transfer(['text/agent-name'], { 'text/agent-name': 'rooks.reviewer' });
    await fire(byId('deep'), 'dragenter', agent);
    const over = await fire(byId('input'), 'dragover', agent);
    assert.equal(over.defaultPrevented, true, 'dragover accepted, or the browser refuses the drop');
    const drop = await fire(byId('input'), 'drop', agent);
    assert.equal(drop.defaultPrevented, true);
    assert.deepEqual(dropped, [['rooks.reviewer', 3]]);
  } finally {
    await unmount();
  }
});

test('an agent drag raises the layer and names what the drop will do', async () => {
  const { fire, layer, byId, dropped, render, unmount } = await mount({ occupant: 'rooks.coder' });
  try {
    const agent = transfer(['text/agent-name'], { 'text/agent-name': 'rooks.reviewer' });
    assert.equal(layer(), null, 'no layer before any drag');

    await fire(byId('deep'), 'dragenter', agent);
    assert.ok(layer(), 'the layer covers the cell');
    assert.ok(layer()!.hasAttribute('data-over'));
    assert.match(layer()!.textContent ?? '', /rooks\.coder/);

    // The layer now sits under the pointer: the drop reaches the cell through it.
    await fire(layer()!, 'drop', agent);
    assert.deepEqual(dropped, [['rooks.reviewer', 3]]);
    assert.equal(layer(), null, 'the layer goes away with the drop');

    // A drag the page saw start raises a quiet layer on every cell.
    await render({ occupant: 'rooks.coder', draggingAgent: 'rooks.reviewer' });
    assert.ok(layer());
    assert.equal(layer()!.hasAttribute('data-over'), false, 'no highlight until the pointer is over the cell');
    await render({ occupant: 'rooks.coder', draggingAgent: null });
    assert.equal(layer(), null);
  } finally {
    await unmount();
  }
});

test('the agent already in the cell is not dropped on itself', async () => {
  const { fire, byId, dropped, unmount } = await mount({ occupant: 'rooks.coder', draggingAgent: 'rooks.coder' });
  try {
    const agent = transfer(['text/agent-name'], { 'text/agent-name': 'rooks.coder' });
    await fire(byId('deep'), 'dragenter', agent);
    await fire(byId('deep'), 'drop', agent);
    assert.deepEqual(dropped, []);
  } finally {
    await unmount();
  }
});

test('a file drag leaves the layer down and still reaches the composer', async () => {
  const { fire, layer, byId, dropped, filesDropped, unmount } = await mount({ occupant: 'rooks.coder' });
  try {
    const files = transfer(['Files']);
    await fire(byId('input'), 'dragenter', files);
    assert.equal(layer(), null, 'a file drag never raises the agent layer');
    const over = await fire(byId('input'), 'dragover', files);
    assert.equal(over.defaultPrevented, true, 'the composer accepts it');
    await fire(byId('input'), 'drop', files);
    assert.deepEqual(filesDropped, ['file']);
    assert.deepEqual(dropped, []);
  } finally {
    await unmount();
  }
});
