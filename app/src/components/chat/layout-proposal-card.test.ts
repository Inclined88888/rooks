/**
 * The card of a screen arrangement an agent proposes. Apply must claim the
 * proposal BEFORE it writes a single row, write the owner's rows through this
 * browser, and announce a recall so the mounted zones follow without a reload;
 * Ignore writes nothing; a refused claim (stale grants) writes nothing either;
 * a decided card shows its outcome, not its buttons.
 */
import assert from 'node:assert/strict';
import { waitUntil } from '../../lib/test-wait';
import test, { type TestContext } from 'node:test';
import type { LayoutProposalView } from '@/lib/layout-proposals';

const GIT = 'plugin:@timon/git:Git';
const proposal = (over: Partial<LayoutProposalView> = {}): LayoutProposalView => ({
  id: 'p1', kind: 'widgets', missionId: 'm1', agent: 'timon.coder',
  payload: { view: '/chat', project: 'timon', zones: { 'chat.left.widget': [GIT] }, columns: { names: { 'chat.left.widget': 'Ops' } } },
  note: 'Git beside the thread', project: 'timon', missionTitle: 'Arrange', taskId: null,
  status: 'pending', createdAt: 1, resolvedAt: null, ...over,
});

type Call = { method: string; url: string; body?: unknown };

async function mount(ctx: TestContext, resolveStatus = 200) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent']) {
    install(key, key === 'window' ? dom.window : Reflect.get(dom.window, key));
  }
  const calls: Call[] = [];
  install('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (url.includes('/resolve')) {
      if (resolveStatus !== 200) {
        return new Response(JSON.stringify({ error: 'stale', problems: [{ code: 'unknown_widget', message: 'Git is not available' }] }), { status: resolveStatus });
      }
      const { decision } = JSON.parse(String(init!.body)) as { decision: 'applied' | 'dismissed' };
      return new Response(JSON.stringify({ ok: true, proposal: proposal({ status: decision, resolvedAt: 2 }) }), { status: 200 });
    }
    if (url.startsWith('/api/ui/layout/proposals')) return new Response(JSON.stringify({ proposals: [] }), { status: 200 });
    if (method === 'PUT') return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (url.includes('.widgets')) {
      return new Response(JSON.stringify({ layout: [{ id: GIT, rail: 'chat.right.widget', rang: 0, hauteur: 200 }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ layout: null }), { status: 200 });
  });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  slots.declareSlot('chat.right.widget', 'list');
  slots.declareSlot('chat.left.widget', 'list');
  slots.register({ slot: 'chat.right.widget', pluginId: '@timon/git', key: 'Git', widget: { title: 'Git' } }, () => null);
  const { createRoot } = await import('react-dom/client');
  const { LayoutProposalCard } = await import('./layout-proposal-card');
  const root = createRoot(document.getElementById('root')!);
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  let recalls = 0;
  dom.window.addEventListener('timon:layout-recalled', () => { recalls += 1; });
  const render = (view: LayoutProposalView) => act(() => {
    root.render(React.createElement(LayoutProposalCard, { proposal: view, time: '12:00', owner: 'user-1' }));
  });
  ctx.after(async () => {
    await act(() => root.unmount());
    slots.resetSlotsForTests();
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-decision]')).map((b) => b.dataset.decision);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  // A click that must change nothing (a refused content) only lets one turn pass.
  const click = async (decision: string, done: () => boolean = () => true, what = `"${decision}" to take effect`) => {
    await act(() => { document.querySelector<HTMLButtonElement>(`button[data-decision="${decision}"]`)!.click(); });
    await until(done, what);
  };
  return { render, buttons, click, until, calls, recalls: () => recalls };
}

test('the preview names the zones and the cards; a pending card offers Apply and Ignore', async (t) => {
  const w = await mount(t);
  await w.render(proposal());
  assert.deepEqual(w.buttons(), ['applied', 'dismissed']);
  const text = document.body.textContent ?? '';
  assert.match(text, /Git beside the thread/);
  assert.match(text, /left column/);
  assert.match(document.querySelector('[data-zone="chat.left.widget"]')!.textContent ?? '', /Git/);
});

test('Apply claims first, then writes the owner\'s rows and announces a recall', async (t) => {
  const w = await mount(t);
  await w.render(proposal());
  await w.click('applied', () => w.recalls() > 0 && w.buttons().length === 0, 'Apply to write and announce a recall');
  const resolveAt = w.calls.findIndex((c) => c.url.includes('/resolve'));
  const firstPut = w.calls.findIndex((c) => c.method === 'PUT');
  assert.ok(resolveAt >= 0 && firstPut > resolveAt, 'the claim precedes every write');
  const widgets = w.calls.find((c) => c.method === 'PUT' && c.url.includes('.widgets'));
  const placed = (widgets?.body as { layout: Array<{ id: string; rail: string; removed?: boolean }> }).layout;
  assert.equal(placed.find((e) => e.id === GIT)?.rail, 'chat.left.widget');
  const columns = w.calls.find((c) => c.method === 'PUT' && c.url.includes('.columns'));
  assert.equal((columns?.body as { layout: { noms?: Record<string, string> } }).layout.noms?.['chat.left.widget'], 'Ops');
  assert.equal(w.recalls(), 1);
  assert.deepEqual(w.buttons(), [], 'a decided card shows its outcome');
  assert.match(document.body.textContent ?? '', /Applied/);
});

test('Ignore writes nothing', async (t) => {
  const w = await mount(t);
  await w.render(proposal());
  await w.click('dismissed', () => /Ignored/.test(document.body.textContent ?? ''), 'Ignore to be recorded');
  assert.equal(w.calls.filter((c) => c.method === 'PUT').length, 0);
  assert.match(document.body.textContent ?? '', /Ignored/);
});

test('a stale claim writes nothing and leaves the card pending', async (t) => {
  const stale = await mount(t, 409);
  await stale.render(proposal({ id: 'p2' }));
  // The refused claim is the last thing to happen: once it is answered,
  // nothing else may follow.
  await stale.click('applied', () => stale.calls.some((c) => c.url.includes('/resolve')), 'the claim to be refused');
  await stale.until(() => true, 'the refused claim to settle');
  assert.equal(stale.calls.filter((c) => c.method === 'PUT').length, 0);
  assert.equal(stale.recalls(), 0);
  assert.deepEqual(stale.buttons(), ['applied', 'dismissed'], 'the card stays pending');
});

test('a trigger proposal shows every action in full, and Approve writes nothing from the browser', async (t) => {
  const w = await mount(t);
  await w.render(proposal({
    id: 'p-trigger', kind: 'trigger', note: 'X watcher',
    payload: {
      name: 'Veille X', source: 'schedule', config: { cron: '*/5 7-22 * * *', tz: 'Europe/Paris' },
      actions: [
        { type: 'script', command: 'python3', args: ['scripts/watch.py', 'poll'], cwd: '/home/me/projects/growth', env: ['TREG_API_KEY'], timeout_s: 120 },
        { type: 'notify', title: 'tick' },
      ],
    },
  }));
  const text = document.body.textContent ?? '';
  assert.match(text, /asks to run a script/);
  assert.match(text, /python3 scripts\/watch\.py poll/);
  assert.match(text, /In \/home\/me\/projects\/growth/);
  assert.match(text, /Secrets: TREG_API_KEY/);
  assert.match(text, /\*\/5 7-22 \* \* \* \(Europe\/Paris\)/);
  assert.match(text, /"title": "tick"/, 'a second action is shown, not hidden behind the script');
  assert.match(text, /Approve and create/);
  // The daemon creates the trigger: the browser's part ends with the claim.
  await w.click('applied', () => w.calls.some((c) => c.url.includes('/resolve')), 'the trigger proposal to be claimed');
  await w.until(() => true, 'the claim to settle');
  assert.equal(w.calls.filter((c) => c.url.includes('/resolve')).length, 1);
  assert.equal(w.calls.filter((c) => c.method === 'PUT').length, 0);
});
