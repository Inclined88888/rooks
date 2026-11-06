import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { answerConfirmsForTests } from '@/components/confirm-dialog/confirm-dialog-context';
import { waitUntil } from './test-wait';
import type { IslandContent } from './island-tree';
import type { ResolvedSkill, SkillAttachment } from './skill-attachments';

const INHERITED: ResolvedSkill[] = [
  { id: 'house', mode: 'import', via: 'project' },
  { id: 'shared', mode: 'include', via: 'global' },
  { id: 'review', mode: 'include', via: 'role' },
];

async function mount(ctx: TestContext) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/agents', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'DocumentFragment'] as const) install(key, dom.window[key]);
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AgentEditorModal, openAgentEditor, closeAgentEditor } = await import('../components/agent-editor/agent-editor-modal');
  const { announceIslandWorkspace } = await import('./island-bus');
  const { getLocale, setLocale } = await import('./i18n');
  const locale = getLocale();
  setLocale('en');
  const state = { status: 200, error: {} as unknown, confirm: true, available: true, network: false, can: undefined as Record<string, boolean> | undefined };
  answerConfirmsForTests(() => state.confirm);
  const writes: { url: string; body: Record<string, unknown> }[] = [];
  const own: SkillAttachment[] = [];
  const opened: IslandContent[] = [];
  const release = announceIslandWorkspace({
    open(content) { if (!state.available) return false; opened.push(content); return true; },
    activate() {}, close() {},
  });
  const previews: Record<string, unknown>[] = [];
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/ui/skill-attachments/preview') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      previews.push(body);
      const skills = INHERITED.filter((s) => !own.some((a) => a.skill === s.id && a.exclude));
      return Response.json({ skills, excluded: [], skills_tokens: skills.length * 100, on_demand_tokens: 10, prompt_tokens: 1000 + skills.length * 100 });
    }
    if (method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      writes.push({ url, body });
      if (url === '/api/ui/skill-attachments') {
        if (state.network) throw new Error('offline');
        if (state.status !== 200) return Response.json(state.error, { status: state.status });
        const row = { ...body, id: own.length + 1 } as SkillAttachment;
        own.push(row);
        return Response.json(row);
      }
      return Response.json({ ok: true });
    }
    if (url === '/api/ui/auth/me') return Response.json({ user: { id: 'u' }, can: state.can });
    if (url === '/api/ui/skill-weights') {
      return Response.json({ weights: { house: { include: 10, import: 2000, on_demand: 2100, pasted: 3000, left_out: ['data/big.csv'] } } });
    }
    if (url === '/api/ui/agents') return Response.json({ agents: [{ name: 'Zeus' }] });
    if (url === '/api/ui/agents/Zeus') return Response.json({ name: 'Zeus', skills: ['alpha'] });
    if (url === '/api/ui/agents/Zeus/skills') return Response.json({ skills: INHERITED });
    if (url.startsWith('/api/ui/skill-attachments?')) return Response.json({ attachments: own });
    if (url.startsWith('/api/ui/skills')) return Response.json({ skills: ['alpha', 'house', 'shared', 'review'].map((id) => ({ id, source: 'timon' })) });
    return Response.json({ agents: [], skills: [], servers: [], roles: [], projects: [], files: [], backends: [] });
  });
  const root = createRoot(document.getElementById('root')!);
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  ctx.after(async () => {
    await act(() => { closeAgentEditor(); root.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    setLocale(locale);
    answerConfirmsForTests(null);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const button = (label: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)!;
  const labelled = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  await act(() => { root.render(React.createElement(AgentEditorModal)); openAgentEditor({ agent: 'Zeus' }); });
  await waitUntil(React.act, () => Boolean(button('Skills')), 'editor loaded');
  await act(() => button('Skills').click());
  await waitUntil(React.act, () => Boolean(labelled('Who receives /house')) && previews.length > 0, 'inherited skills and preview loaded');
  return { act, button, labelled, state, own, writes, opened, previews, refreshMe: (await import('../hooks/use-me')).refreshMe };
}

test('inherited skills of all three scopes open the Timon skill recipients; a missing workspace keeps the editor', async (ctx) => {
  const w = await mount(ctx);
  for (const id of ['house', 'shared', 'review']) assert.ok(w.labelled(`Who receives /${id}`));
  w.state.available = false;
  await w.act(() => w.labelled('Who receives /house').click());
  assert.ok(w.button('Save'));
  w.state.available = true;
  await w.act(() => w.labelled('Who receives /review').click());
  assert.deepEqual(w.opened[0]?.params, { id: 'review', mode: 'preview', source: 'timon', section: 'recipients' });
  assert.ok(!document.querySelector('[role="dialog"]'), 'the editor no longer traps focus over the skill popup');
});

test('an inherited skill names no left-out file on a backend that reads on demand', async (ctx) => {
  const w = await mount(ctx);
  await waitUntil(w.act, () => /~2k tokens/.test(w.labelled('Who receives /house')?.textContent ?? ''), 'weights loaded');
  assert.ok(!document.querySelector('[data-testid="skill-left-out-house"]'), 'the agent can open its files');
});

test('an agent exclusion recalculates the total and preserves other draft modes on Save', async (ctx) => {
  const w = await mount(ctx);
  const picker = document.querySelector('[aria-label="How alpha reaches the agent"]')!;
  await w.act(() => Array.from(picker.querySelectorAll('button')).find((b) => b.textContent === 'Import')!.click());
  const exclude = w.labelled('Exclude /house for this agent');
  assert.equal(exclude.disabled, false, 'a daemon that does not answer agents:manage leaves the route to judge');
  await w.act(() => exclude.click());
  await waitUntil(w.act, () => document.querySelector('[data-testid="spawn-context-total"]')?.textContent === '~1.2k tokens', 'the saved exclusion was re-previewed');
  assert.deepEqual(w.writes[0]?.body, { skill: 'house', scope: 'agent', target: 'Zeus', mode: 'include', exclude: true });
  assert.ok(!w.labelled('Who receives /house'));
  assert.ok(w.labelled('Who receives /shared'), 'other scopes are untouched');
  assert.equal(picker.querySelector('[aria-pressed="true"]')?.textContent, 'Import', 'draft mode kept');
  await w.act(() => w.button('Save').click());
  await waitUntil(w.act, () => w.writes.some((r) => r.body.skill === 'alpha'), 'draft saved');
  assert.ok(w.writes.some((r) => r.body.skill === 'alpha' && r.body.mode === 'import'));
  assert.equal(w.writes.filter((r) => r.body.skill === 'house').length, 1, 'Save never overwrites the exclusion');
  await waitUntil(w.act, () => w.button('Save')?.disabled === false, 'Save completed');
});

test('refused exclusions show 403 reasons, 404 targets and network errors without removing the skill', async (ctx) => {
  const w = await mount(ctx);
  for (const [status, error, expected] of [
    [403, { reason: 'agents:manage is required' }, /agents:manage is required/],
    [404, { error: 'agent not found: Zeus' }, /Zeus/],
    [401, {}, /sign in/i],
  ] as const) {
    w.state.status = status;
    w.state.error = error;
    await w.act(() => w.labelled('Exclude /house for this agent').click());
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', expected);
    assert.ok(w.labelled('Who receives /house'));
    assert.equal(w.own.length, 0);
  }
  w.state.network = true;
  await w.act(() => w.labelled('Exclude /house for this agent').click());
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /reach|network|connect/i);
});

test('opening recipients respects the modal discard guard', async (ctx) => {
  const w = await mount(ctx);
  const picker = document.querySelector('[aria-label="How alpha reaches the agent"]')!;
  await w.act(() => Array.from(picker.querySelectorAll('button')).find((b) => b.textContent === 'Import')!.click());
  w.state.confirm = false;
  await w.act(() => w.labelled('Who receives /shared').click());
  assert.equal(w.opened.length, 0);
  assert.ok(document.querySelector('[role="dialog"]'));
  w.state.confirm = true;
  await w.act(() => w.labelled('Who receives /shared').click());
  assert.equal(w.opened.length, 1);
  assert.ok(!document.querySelector('[role="dialog"]'));
});

// TODO #693: the exclusion is an agent-scope attachment, whose route needs agents:manage.
test('without agents:manage, the exclusion is greyed with the reason and nothing is written', async (ctx) => {
  const w = await mount(ctx);
  try {
    w.state.can = { 'projects:manage': true, 'agents:manage': false, 'agents:privileged-config': true };
    await w.act(async () => { await w.refreshMe(); });
    const exclude = w.labelled('Exclude /house for this agent');
    assert.equal(exclude.disabled, true);
    assert.match(exclude.title, /agents:manage/);
    await w.act(() => exclude.click());
    assert.equal(w.writes.length, 0);
    assert.ok(w.labelled('Who receives /house'), 'opening the recipients stays a read');

    w.state.can = { 'projects:manage': false, 'agents:manage': true, 'agents:privileged-config': false };
    await w.act(async () => { await w.refreshMe(); });
    assert.equal(w.labelled('Exclude /house for this agent').disabled, false, 'agents:manage alone is enough at the agent scope');
  } finally {
    // The account is cached for the module: hand the next test the daemon that does not say.
    w.state.can = undefined;
    await w.act(async () => { await w.refreshMe(); });
  }
});
