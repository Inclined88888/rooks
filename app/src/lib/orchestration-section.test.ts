/**
 * The "Orchestration" tab of the agent editor
 * (`components/agent-editor/orchestration-section.tsx`), mounted in jsdom:
 * the inherited list shown as such, the override, "all" / "none", and the
 * daemon's refusal put on screen. The daemon is a stubbed `fetch`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import en from '../locales/en/core.json';
import fr from '../locales/fr/core.json';

type Raw = string[] | '*' | null;
type Agent = { name: string; orchestrates?: Raw; effective_orchestrates?: string[] | '*'; orchestrates_source?: 'explicit' | 'main' | 'orchestrator' | 'reports_to' };

const ROSTER = [
  { name: 'boss', project: 'timon', role: 'orchestrator' },
  { name: 'alice', project: 'timon', role: 'coder' },
  { name: 'bob', project: 'timon', role: 'reviewer' },
  { name: 'carol', project: null, role: null },
];

type Call = { url: string; method: string; body: unknown };

async function mount(agent: Agent | null, reply?: (call: Call) => Response, extra: { roster?: typeof ROSTER; teams?: { id: string; name: string; color: string | null }[]; onDirtyChange?: (dirty: boolean) => void } = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/agents', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const calls: Call[] = [];
  const realFetch = globalThis.fetch;
  install('fetch', async (url: string, init?: RequestInit) => {
    const call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return reply ? reply(call) : new Response('{}', { status: 200 });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { OrchestrationSection } = await import('../components/agent-editor/orchestration-section');

  const saved: unknown[] = [];
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(React.createElement(OrchestrationSection, { agent, roster: extra.roster ?? ROSTER, teams: extra.teams ?? [], onDirtyChange: extra.onDirtyChange, onSaved: (a: unknown) => { saved.push(a); } }));
  });

  const rerender = (next: Agent | null) => React.act(async () => {
    root.render(React.createElement(OrchestrationSection, { agent: next, roster: extra.roster ?? ROSTER, teams: extra.teams ?? [], onDirtyChange: extra.onDirtyChange, onSaved: (a: unknown) => { saved.push(a); } }));
  });
  const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
  const $$ = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));
  const rows = () => $$('[data-orchestration-row]').map((el) => el.getAttribute('data-orchestration-row'));
  const options = () => $$('[data-orchestration-option]').map((el) => el.getAttribute('data-orchestration-option'));
  const click = (el: HTMLElement) => React.act(async () => { el.click(); });
  const search = async (text: string) => {
    const input = $('[data-orchestration-search]') as HTMLInputElement;
    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, text);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  const add = async (name: string) => { await search(name); await click($(`[data-orchestration-option="${name}"]`)!); };
  const remove = (name: string) => click($(`[data-orchestration-remove="${name}"]`)!);
  const state = () => $('[data-orchestration-state]')!.getAttribute('data-orchestration-state');
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    dom.window.close();
    install('fetch', realFetch);
  };
  return { $, $$, rows, options, search, add, remove, click, state, calls, saved, rerender, unmount };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('an inherited list is shown as such, from the daemon\'s answer, with nothing to apply', async () => {
  const r = await mount({ name: 'boss', orchestrates: null, effective_orchestrates: ['alice', 'bob'], orchestrates_source: 'reports_to' });
  try {
    assert.equal(r.state(), 'inherited');
    assert.deepEqual(r.rows(), ['alice', 'bob']);
    assert.match(document.body.textContent!, /Inherited: the agents that report to it/);
    await r.search('boss');
    assert.deepEqual(r.options(), [], 'an agent is never offered itself');
    assert.equal((r.$('[data-orchestration-apply]') as HTMLButtonElement).disabled, true);
    assert.equal((r.$('[data-orchestration-restore]') as HTMLButtonElement).disabled, true);
  } finally { await r.unmount(); }
});

test('adding an agent from the search overrides the inheritance, and Apply writes the list through the protected route', async () => {
  const r = await mount(
    { name: 'boss', orchestrates: null, effective_orchestrates: ['alice'], orchestrates_source: 'reports_to' },
    () => json({ name: 'boss', orchestrates: ['alice', 'carol'], effective_orchestrates: ['alice', 'carol'], orchestrates_source: 'explicit' }),
  );
  try {
    await r.add('carol');
    assert.equal(r.state(), 'unsaved');
    assert.deepEqual(r.rows(), ['alice', 'carol']);
    await r.click(r.$('[data-orchestration-apply]')!);
    assert.deepEqual(r.calls, [{ url: '/api/ui/agents/boss/orchestrates', method: 'PUT', body: { orchestrates: ['alice', 'carol'] } }]);
    assert.equal(r.saved.length, 1);
    assert.equal(r.state(), 'explicit');
    assert.match(document.body.textContent!, /Set by hand/);
    assert.equal((r.$('[data-orchestration-restore]') as HTMLButtonElement).disabled, false);
  } finally { await r.unmount(); }
});

test('the delete button at the end of a row takes the agent out', async () => {
  const r = await mount({ name: 'boss', orchestrates: ['alice', 'bob'], effective_orchestrates: ['alice', 'bob'], orchestrates_source: 'explicit' });
  try {
    await r.remove('alice');
    assert.deepEqual(r.rows(), ['bob']);
    assert.equal(r.state(), 'unsaved');
    await r.search('alice');
    assert.deepEqual(r.options(), ['alice'], 'it can be found again');
  } finally { await r.unmount(); }
});

test('an orchestrator inheriting "everybody" shows no list; None then lets one choose one by one', async () => {
  const r = await mount({ name: 'boss', orchestrates: null, effective_orchestrates: '*', orchestrates_source: 'orchestrator' });
  try {
    assert.ok(r.$('[data-orchestration-everyone]'));
    assert.deepEqual(r.rows(), []);
    assert.match(document.body.textContent!, /An orchestrator orchestrates every agent/);
    await r.click(r.$('[data-orchestration-none]')!);
    assert.ok(!r.$('[data-orchestration-everyone]'));
    await r.add('bob');
    assert.deepEqual(r.rows(), ['bob']);
    assert.equal(r.state(), 'unsaved');
  } finally { await r.unmount(); }
});

test('"All" writes "*", "None" writes an empty list, and restoring the inheritance writes null', async () => {
  const r = await mount(
    { name: 'boss', orchestrates: ['alice'], effective_orchestrates: ['alice'], orchestrates_source: 'explicit' },
    (call) => json({ name: 'boss', orchestrates: (call.body as { orchestrates: Raw }).orchestrates, effective_orchestrates: [], orchestrates_source: 'explicit' }),
  );
  try {
    await r.click(r.$('[data-orchestration-all]')!);
    assert.ok(r.$('[data-orchestration-everyone]'));
    await r.click(r.$('[data-orchestration-apply]')!);
    await r.click(r.$('[data-orchestration-none]')!);
    assert.deepEqual(r.rows(), []);
    assert.match(document.body.textContent!, /Nobody/);
    await r.click(r.$('[data-orchestration-apply]')!);
    await r.click(r.$('[data-orchestration-restore]')!);
    assert.equal(r.state(), 'unsaved', 'back on the default, still to be written');
    await r.click(r.$('[data-orchestration-apply]')!);
    assert.deepEqual(r.calls.map((c) => c.body), [{ orchestrates: '*' }, { orchestrates: [] }, { orchestrates: null }]);
  } finally { await r.unmount(); }
});

test('a refusal from the daemon is shown with its reason, and the edit stays pending', async () => {
  const r = await mount(
    { name: 'boss', orchestrates: null, effective_orchestrates: [], orchestrates_source: 'reports_to' },
    () => json({ error: 'forbidden', reason: 'an agent cannot change who orchestrates whom' }, 403),
  );
  try {
    await r.add('alice');
    await r.click(r.$('[data-orchestration-apply]')!);
    const alert = r.$('[role="alert"]')!;
    assert.match(alert.textContent!, /The daemon refused the change: an agent cannot change who orchestrates whom/);
    assert.equal(r.state(), 'unsaved');
    assert.equal(r.saved.length, 0);
    assert.equal((r.$('[data-orchestration-apply]') as HTMLButtonElement).disabled, false, 'can be retried');
  } finally { await r.unmount(); }
});

test('another failure, or an answer without a reason, is not passed off as a refusal', async () => {
  const r = await mount(
    { name: 'boss', orchestrates: null, effective_orchestrates: [], orchestrates_source: 'reports_to' },
    () => new Response('not json', { status: 500 }),
  );
  try {
    await r.add('alice');
    await r.click(r.$('[data-orchestration-apply]')!);
    assert.match(r.$('[role="alert"]')!.textContent!, /Could not update the list: no reason given/);
  } finally { await r.unmount(); }
});

test('a new agent has nothing to write to, and a restricted view gets no list', async () => {
  const fresh = await mount(null);
  try {
    assert.match(document.body.textContent!, /Save the agent first/);
    assert.ok(!fresh.$('[data-orchestration]'));
  } finally { await fresh.unmount(); }

  const restricted = await mount({ name: 'boss' });
  try {
    assert.match(document.body.textContent!, /not available to your account/);
    assert.ok(!restricted.$('[data-orchestration]'));
  } finally { await restricted.unmount(); }
});

test('the search finds by name, role or project, and offers only agents not chosen yet', async () => {
  const r = await mount({ name: 'boss', orchestrates: ['carol'], effective_orchestrates: ['carol'], orchestrates_source: 'explicit' });
  try {
    await r.search('reviewer');
    assert.deepEqual(r.options(), ['bob']);
    await r.search('carol');
    assert.deepEqual(r.options(), [], 'carol is already in');
    await r.search('zzz');
    assert.match(document.body.textContent!, /No agent matches/);
    await r.add('bob');
    await r.click(r.$('[data-orchestration-apply]')!);
    assert.deepEqual(r.calls[0]!.body, { orchestrates: ['bob', 'carol'] });
  } finally { await r.unmount(); }
});

test('an unapplied selection is reported as dirty, and Apply or another agent clears it', async () => {
  const reports: boolean[] = [];
  const r = await mount(
    { name: 'boss', orchestrates: null, effective_orchestrates: ['alice'], orchestrates_source: 'reports_to' },
    () => json({ name: 'boss', orchestrates: ['alice', 'carol'], effective_orchestrates: ['alice', 'carol'], orchestrates_source: 'explicit' }),
    { onDirtyChange: (d) => { reports.push(d); } },
  );
  try {
    assert.equal(reports.at(-1), false, 'nothing picked yet');
    await r.add('carol');
    assert.equal(reports.at(-1), true);
    await r.click(r.$('[data-orchestration-apply]')!);
    assert.equal(reports.at(-1), false, 'a successful Apply clears it');

    await r.remove('carol');
    assert.equal(reports.at(-1), true);
    await r.rerender({ name: 'alice', orchestrates: ['bob'], effective_orchestrates: ['bob'], orchestrates_source: 'explicit' });
    assert.equal(reports.at(-1), false, 'another agent starts clean');
    assert.deepEqual(r.rows(), ['bob']);
  } finally { await r.unmount(); }
});

test('a refused Apply keeps the selection dirty', async () => {
  const reports: boolean[] = [];
  const r = await mount(
    { name: 'boss', orchestrates: null, effective_orchestrates: [], orchestrates_source: 'reports_to' },
    () => json({ error: 'forbidden', reason: 'no' }, 403),
    { onDirtyChange: (d) => { reports.push(d); } },
  );
  try {
    await r.add('alice');
    await r.click(r.$('[data-orchestration-apply]')!);
    assert.equal(reports.at(-1), true);
  } finally { await r.unmount(); }
});

test('the host re-sending the same agent with other fields does not drop a pending selection', async () => {
  const reports: boolean[] = [];
  const agent = { name: 'boss', orchestrates: null, effective_orchestrates: ['alice'], orchestrates_source: 'reports_to' as const };
  const r = await mount(agent, undefined, { onDirtyChange: (d) => { reports.push(d); } });
  try {
    await r.add('carol');
    await r.rerender({ ...agent, model: 'other' } as Agent);
    assert.equal(reports.at(-1), true);
    assert.deepEqual(r.rows(), ['alice', 'carol']);
  } finally { await r.unmount(); }
});

test('every orchestration string exists in both languages', () => {
  const keys = (node: unknown, prefix = ''): string[] =>
    Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
      typeof v === 'string' ? [prefix + k] : keys(v, `${prefix}${k}.`));
  assert.deepEqual(keys(fr.orchestration).sort(), keys(en.orchestration).sort());
});

const CANVAS_ROSTER = [
  { name: 'boss', project: 'timon', role: 'orchestrator', team: 't1' },
  { name: 'alice', project: 'timon', role: 'coder', reports_to: 'boss', team: 't1' },
  { name: 'bob', project: 'timon', role: 'reviewer', reports_to: 'alice' },
  { name: 'carol', project: null, role: null },
  { name: 'dave', project: null, role: null, team: 't2' },
  { name: 'zed', project: null, role: null, emoji: 'Z' },
];
const TEAMS = [{ id: 't1', name: 'Alpha', color: '#ff0000' }, { id: 't2', name: 'Beta', color: null }];

test('the canvas reports come first in the list, tagged, and their button adds them', async () => {
  const r = await mount({ name: 'boss', orchestrates: ['zed', 'dave'], effective_orchestrates: ['zed', 'dave'], orchestrates_source: 'explicit' }, undefined, { roster: CANVAS_ROSTER, teams: TEAMS });
  try {
    assert.deepEqual(r.rows(), ['dave', 'zed']);
    await r.click(r.$('[data-orchestration-canvas]')!);
    assert.deepEqual(r.rows(), ['alice', 'bob', 'dave', 'zed'], 'the canvas reports lead, then the rest by name');
    assert.deepEqual(r.$$('[data-orchestration-canvas-tag]').map((el) => el.textContent), ['reports to it', 'below it']);
    assert.deepEqual(r.$$('[data-orchestration-team-tag]').map((el) => el.textContent), ['Alpha', 'Beta']);
    assert.equal(r.state(), 'unsaved');
  } finally { await r.unmount(); }
});

test('the team button adds the teammates', async () => {
  const roster = [...CANVAS_ROSTER, { name: 'erin', project: null, role: null, team: 't1' }];
  const r = await mount({ name: 'boss', orchestrates: [], effective_orchestrates: [], orchestrates_source: 'explicit' }, undefined, { roster, teams: TEAMS });
  try {
    await r.click(r.$('[data-orchestration-team]')!);
    assert.deepEqual(r.rows(), ['alice', 'erin']);
  } finally { await r.unmount(); }
});

test('an agent with no canvas reports and no team gets neither button', async () => {
  const r = await mount({ name: 'carol', orchestrates: null, effective_orchestrates: [], orchestrates_source: 'reports_to' }, undefined, { roster: CANVAS_ROSTER, teams: TEAMS });
  try {
    assert.ok(!r.$('[data-orchestration-canvas]'));
    assert.ok(!r.$('[data-orchestration-team]'));
  } finally { await r.unmount(); }
});
