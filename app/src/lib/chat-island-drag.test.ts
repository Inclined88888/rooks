/**
 * Agent and mission sources of the island workspace (ISLAND-WORKSPACE.md §6,
 * §11): one drag the multichat and the workspace both read, and the "Open in
 * a split" entries of their menus.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { DropRegion, IslandContent } from './island-tree';

class FakeDataTransfer {
  private data = new Map<string, string>();
  effectAllowed = 'uninitialized';
  get types(): string[] { return [...this.data.keys()]; }
  setData(type: string, value: string) { this.data.set(type, value); }
  getData(type: string) { return this.data.get(type) ?? ''; }
}

async function setup(t: TestContext) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('', { url: 'http://localhost/kanban' });
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true });
  const bus = await import('./island-bus');
  const drag = await import('./island-drag');
  const sources = await import('./chat-island-drag');
  const opened: { content: IslandContent; edge: DropRegion }[] = [];
  const handle = { open: (content: IslandContent, edge: DropRegion) => { opened.push({ content, edge }); return true; }, activate() {}, close() {} };
  t.after(() => {
    drag.resetIslandDragForTests();
    dom.window.close();
    if (saved) Object.defineProperty(globalThis, 'window', saved); else Reflect.deleteProperty(globalThis, 'window');
  });
  return { bus, drag, sources, handle, opened };
}

test('no workspace on screen: no drag, no menu entry', async (t) => {
  const { sources } = await setup(t);
  const snap = { present: false, narrow: false, tabs: [] };
  assert.equal(sources.canDragToIsland(snap), false);
  assert.deepEqual(sources.chatSplitActions(snap, 'a'), []);
});

test('one entry per edge, a single "open" below 768 px; each opens the chat', async (t) => {
  const { bus, sources, handle, opened } = await setup(t);
  const withdraw = bus.announceIslandWorkspace(handle);
  t.after(withdraw);
  const wide = sources.chatSplitActions({ present: true, narrow: false, tabs: [] }, 'initech.coder', 'm-1');
  assert.deepEqual(wide.map((a) => a.key), ['island-right', 'island-left', 'island-bottom', 'island-top', 'island-center', 'island-float']);
  wide[0]!.onSelect();
  assert.deepEqual(opened.at(-1), {
    content: { type: '@timon/missions:chat', params: { agent: 'initech.coder', missionId: 'm-1', fresh: false } },
    edge: 'right',
  });
  wide[5]!.onSelect();
  assert.equal(opened.at(-1)!.edge, 'float', 'the last entry is a popup');
  const narrow = sources.chatSplitActions({ present: true, narrow: true, tabs: [] }, 'initech.coder');
  assert.equal(narrow.length, 1);
  narrow[0]!.onSelect();
  assert.equal(opened.at(-1)!.edge, 'center', 'below 768 px it adds a tab');
  assert.equal(sources.canDragToIsland({ present: true, narrow: true, tabs: [] }), false);
});

test('a drag carries the multichat type first, then ours, with the chat as content', async (t) => {
  const { drag, sources } = await setup(t);
  const dataTransfer = new FakeDataTransfer();
  dataTransfer.effectAllowed = 'move';
  sources.startChatIslandDrag({ dataTransfer } as unknown as DragEvent, 'initech.coder', 'm-1');
  assert.deepEqual(dataTransfer.types, ['text/agent-name', drag.ISLAND_DRAG_TYPE]);
  assert.equal(dataTransfer.getData('text/agent-name'), 'initech.coder');
  assert.equal(dataTransfer.effectAllowed, 'move', 'what the source allowed is kept');
  const dropped = drag.readIslandDrop(dataTransfer as unknown as DataTransfer);
  assert.ok(dropped);
  assert.deepEqual(dropped.source, {
    kind: 'content',
    content: { type: '@timon/missions:chat', params: { agent: 'initech.coder', missionId: 'm-1', fresh: false } },
  });
});

test('the multichat holds its grid: the workspace rises only outside it, and a cell gives its chat away', async (t) => {
  const { drag, sources } = await setup(t);
  const doc = window.document;
  const grid = doc.createElement('div');
  doc.body.appendChild(grid);
  grid.getBoundingClientRect = () => ({ left: 200, top: 0, right: 1000, bottom: 800, width: 800, height: 800, x: 200, y: 0, toJSON() {} });
  const dataTransfer = new FakeDataTransfer();
  let given = 0;
  sources.startChatIslandDrag({ dataTransfer } as unknown as DragEvent, 'initech.coder', 'm-1', { hold: grid, onDropped: () => { given += 1; } });
  const over = (x: number, y: number) => {
    const event = new window.Event('dragover');
    Object.assign(event, { clientX: x, clientY: y });
    window.dispatchEvent(event);
  };
  over(500, 400);
  assert.equal(drag.raisedIslandDrag(), null, 'over the grid, the cells take the drop');
  over(100, 400);
  const raised = drag.raisedIslandDrag();
  assert.ok(raised, 'over the rail, the workspace does');
  assert.equal(raised.label, 'initech.coder', 'the label still defaults to the chat title');
  raised.onDropped?.();
  assert.equal(given, 1);
  over(600, 400);
  assert.equal(drag.raisedIslandDrag(), null);
});

test('a multichat cell empties only once the workspace took its chat', async (t) => {
  const { bus, sources } = await setup(t);
  let accept = false;
  const withdraw = bus.announceIslandWorkspace({ open: () => accept, activate() {}, close() {} });
  t.after(withdraw);
  let cleared = 0;
  const [right] = sources.chatSplitActions({ present: true, narrow: false, tabs: [] }, 'initech.coder', 'm-1', () => { cleared += 1; });
  right!.onSelect();
  assert.equal(cleared, 0, 'refused (a limit): the cell keeps its chat');
  accept = true;
  right!.onSelect();
  assert.equal(cleared, 1);
});
