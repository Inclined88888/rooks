/**
 * "Who receives this skill" mounted on its own: the attachments of every
 * scope, widest first; the controls the account may not use greyed with the
 * reason; a write sent with the body the daemon expects; an unknown target
 * answered by name. The daemon's own refusals are covered by
 * `skill-attachment-routes.test.ts`.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

type Call = { url: string; method: string; body: unknown };

const ATTACHMENTS = [
  { id: 1, skill: 'lint', scope: 'agent', target: 'zeus', mode: 'include', exclude: false },
  { id: 2, skill: 'lint', scope: 'project', target: 'alpha', mode: 'import', exclude: false },
  { id: 3, skill: 'lint', scope: 'role', target: 'reviewer', mode: 'include', exclude: true },
  { id: 4, skill: 'lint', scope: 'global', target: '', mode: 'include', exclude: false },
];

async function mount(ctx: TestContext, opts: { privileged: boolean; manage?: boolean; post?: { status: number; body: unknown } }) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/skills', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'MouseEvent', 'MutationObserver', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : Reflect.get(dom.window, key));
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const calls: Call[] = [];
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    if (method === 'POST') {
      const reply = opts.post ?? { status: 200, body: { id: 9 } };
      return Response.json(reply.body, { status: reply.status });
    }
    if (method === 'DELETE') return Response.json({ ok: true });
    if (url.startsWith('/api/ui/skill-attachments')) return Response.json({ attachments: ATTACHMENTS });
    if (url === '/api/ui/auth/me') return Response.json({ user: { id: 'u' }, can: { 'projects:manage': false, 'agents:manage': opts.manage ?? true, 'agents:privileged-config': opts.privileged } });
    if (url === '/api/ui/projects') return Response.json({ projects: [{ slug: 'alpha' }, { slug: 'beta' }] });
    if (url === '/api/ui/agent-roles') return Response.json({ roles: [{ id: 'coder', label: 'Coder' }, { id: 'reviewer', label: 'Reviewer' }] });
    if (url === '/api/ui/agents') return Response.json({ agents: [{ name: 'zeus' }, { name: 'athena' }] });
    return Response.json({}, { status: 404 });
  });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { SkillRecipients } = await import('./skill-recipients');
  const root = createRoot(document.getElementById('root')!);
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  const flush = () => act(async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0)); });
  ctx.after(async () => {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  await act(() => root.render(React.createElement(SkillRecipients, { skill: 'lint' })));
  await flush();
  const toggle = document.querySelector('button[aria-expanded]') as HTMLButtonElement;
  await act(() => { toggle.click(); });
  await flush();
  const select = (label: string) => document.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
  const choose = async (label: string, value: string) => {
    const el = select(label);
    await act(() => {
      el.value = value;
      el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await flush();
  };
  const button = (text: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
  return { calls, act, flush, select, choose, button, toggle };
}

test('every scope is listed widest first, each attachment with its mode or its exclusion', async (t) => {
  const w = await mount(t, { privileged: true });
  assert.equal(w.toggle.textContent, 'Who receives this skill4');
  const text = document.body.textContent ?? '';
  const order = ['Every agent', 'Project', 'Agent role', 'Agent'].map((s) => text.indexOf(s));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'global, project, role, agent');
  assert.match(text, /All agents/);
  assert.match(text, /Reviewer/, 'a role is named by its label');
  assert.match(text, /the next time the agents it reaches start/);
  assert.equal(w.select('Mode for alpha').value, 'import');
  assert.equal(w.select('Mode for Reviewer').value, 'exclude');
  assert.deepEqual(Array.from(w.select('Mode for All agents').options).map((o) => o.value), ['include', 'import'], 'nothing to exclude at the widest scope');
});

test('without agents:privileged-config, only the agent scope can be written, and the section says why', async (t) => {
  const w = await mount(t, { privileged: false });
  assert.match(document.body.textContent ?? '', /needs the agents:privileged-config permission/);
  for (const label of ['Mode for All agents', 'Mode for alpha', 'Mode for Reviewer']) assert.equal(w.select(label).disabled, true, label);
  assert.equal(w.select('Mode for zeus').disabled, false);
  const scopes = Array.from(w.select('Scope').options);
  assert.deepEqual(scopes.filter((o) => !o.disabled).map((o) => o.value), ['agent']);
  const remove = document.querySelector('button[aria-label="Remove the attachment of alpha"]') as HTMLButtonElement;
  assert.equal(remove.disabled, true);
  assert.match(remove.title, /agents:privileged-config/);
});

// TODO #693: every attachment write needs agents:manage, the agent scope too.
test('without agents:manage, nothing can be written, and the section says why', async (t) => {
  const w = await mount(t, { privileged: true, manage: false });
  const text = document.body.textContent ?? '';
  assert.match(text, /needs the agents:manage permission/);
  assert.doesNotMatch(text, /agents:privileged-config/, 'the missing grant is the one named');
  for (const label of ['Mode for All agents', 'Mode for alpha', 'Mode for Reviewer', 'Mode for zeus']) assert.equal(w.select(label).disabled, true, label);
  assert.deepEqual(Array.from(w.select('Scope').options).filter((o) => !o.disabled).map((o) => o.value), []);
  assert.equal(w.select('Target').disabled, true);
  const attach = w.button('Attach');
  assert.equal(attach.disabled, true);
  assert.match(attach.title, /agents:manage/);
  const remove = document.querySelector('button[aria-label="Remove the attachment of zeus"]') as HTMLButtonElement;
  assert.equal(remove.disabled, true);
  assert.match(remove.title, /agents:manage/);
  await w.act(() => { attach.click(); remove.click(); });
  await w.flush();
  assert.equal(w.calls.filter((c) => c.method !== 'GET').length, 0, 'no write leaves the section');
});

test('an attachment is added with the body the daemon expects, then the list is read again', async (t) => {
  const w = await mount(t, { privileged: true });
  await w.choose('Scope', 'project');
  assert.deepEqual(Array.from(w.select('Target').options).map((o) => o.value), ['', 'beta'], 'alpha already holds the skill');
  await w.choose('Target', 'beta');
  await w.choose('Mode', 'exclude');
  const reads = w.calls.filter((c) => c.url.startsWith('/api/ui/skill-attachments') && c.method === 'GET').length;
  await w.act(() => { w.button('Attach').click(); });
  await w.flush();
  const post = w.calls.find((c) => c.method === 'POST');
  assert.deepEqual(post, { url: '/api/ui/skill-attachments', method: 'POST', body: { skill: 'lint', scope: 'project', target: 'beta', mode: 'include', exclude: true } });
  assert.equal(w.calls.filter((c) => c.url.startsWith('/api/ui/skill-attachments') && c.method === 'GET').length, reads + 1);
});

test('a target the daemon does not know is named in the section', async (t) => {
  const w = await mount(t, { privileged: true, post: { status: 404, body: { error: 'role not found: coder (see agent roles)' } } });
  await w.choose('Scope', 'role');
  await w.choose('Target', 'coder');
  await w.act(() => { w.button('Attach').click(); });
  await w.flush();
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /The agent role “coder” does not exist/);
});

test('a row is removed by its id', async (t) => {
  const w = await mount(t, { privileged: true });
  const remove = document.querySelector('button[aria-label="Remove the attachment of zeus"]') as HTMLButtonElement;
  await w.act(() => { remove.click(); });
  await w.flush();
  assert.ok(w.calls.some((c) => c.method === 'DELETE' && c.url === '/api/ui/skill-attachments/1'));
});
