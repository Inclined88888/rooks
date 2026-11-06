import assert from 'node:assert/strict';
import test from 'node:test';
import { waitUntil } from './test-wait';

test('agent editor: a checked skill set to Import is attached on save, inherited skills are listed', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/agents', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'DocumentFragment'] as const) {
    install(key, dom.window[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AgentEditorModal, openAgentEditor, closeAgentEditor } = await import('../components/agent-editor/agent-editor-modal');
  const { getLocale, setLocale } = await import('./i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const writes: Array<{ method: string; url: string; body: unknown }> = [];
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') writes.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === '/api/ui/agents' && method === 'POST') return Response.json({ ok: true });
    if (url === '/api/ui/skill-attachments' && method === 'POST') return Response.json({ id: 9 });
    if (url === '/api/ui/agents') return Response.json({ agents: [{ name: 'Zeus' }] });
    if (url === '/api/ui/agents/Zeus') return Response.json({ name: 'Zeus', skills: ['alpha'] });
    if (url.startsWith('/api/ui/skills')) {
      return Response.json({ skills: [{ id: 'alpha', source: 'timon' }, { id: 'beta', source: 'timon' }] });
    }
    if (url.startsWith('/api/ui/skill-attachments?')) return Response.json({ attachments: [] });
    if (url === '/api/ui/agents/Zeus/skills') {
      return Response.json({ skills: [{ id: 'alpha', mode: 'include', via: 'config' }, { id: 'house', mode: 'import', via: 'project' }] });
    }
    return Response.json({ agents: [], skills: [], servers: [], roles: [], projects: [], files: [], backends: [] });
  });
  const root = createRoot(document.getElementById('root')!);
  const button = (text: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);
  try {
    await React.act(async () => {
      root.render(React.createElement(AgentEditorModal));
      openAgentEditor({ agent: 'Zeus' });
    });
    await waitUntil(React.act, () => button('Skills') !== undefined, 'editor tabs loaded');
    await React.act(async () => { button('Skills')!.click(); });
    await waitUntil(React.act, () => document.querySelector('[aria-label="How alpha reaches the agent"]') !== null, 'mode picker shown');
    const picker = document.querySelector('[aria-label="How alpha reaches the agent"]')!;
    const include = Array.from(picker.querySelectorAll('button')).find((b) => b.textContent === 'Catalogue')!;
    assert.equal(include.getAttribute('aria-pressed'), 'true', 'a checked skill starts in the catalogue');
    assert.match(document.body.textContent!, /\/house/, 'a skill the project brings is listed');
    assert.ok(!document.querySelector('[aria-label="How beta reaches the agent"]'), 'an unchecked skill has no mode');
    await React.act(async () => {
      Array.from(picker.querySelectorAll('button')).find((b) => b.textContent === 'Import')!.click();
    });
    await React.act(async () => { button('Save')!.click(); });
    await waitUntil(React.act, () => writes.some((w) => w.url === '/api/ui/skill-attachments'), 'attachment written');
    const config = writes.find((w) => w.url === '/api/ui/agents')!.body as { config: Record<string, unknown> };
    assert.ok(!('skills' in config.config), 'checked skills are attachments, not config.skills');
    assert.deepEqual(writes.find((w) => w.url === '/api/ui/skill-attachments')!.body, {
      skill: 'alpha', scope: 'agent', target: 'Zeus', mode: 'import',
    });
  } finally {
    await React.act(async () => { closeAgentEditor(); root.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    setLocale(previousLocale);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

test('agent editor: the spawn total is the one the daemon resolves for the draft, whatever the boxes add up to', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/agents', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'DocumentFragment'] as const) {
    install(key, dom.window[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AgentEditorModal, openAgentEditor, closeAgentEditor } = await import('../components/agent-editor/agent-editor-modal');
  const { getLocale, setLocale } = await import('./i18n');
  const previousLocale = getLocale();
  setLocale('en');
  type Draft = { agent?: string; skills: { id: string; mode: string }[]; role: string };
  const previews: Draft[] = [];
  let previewFails = false;
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/ui/skill-attachments/preview') {
      const draft = JSON.parse(String(init!.body)) as Draft;
      previews.push(draft);
      if (previewFails) return Response.json({ error: 'nope' }, { status: 500 });
      const ids = draft.skills.map((s) => s.id);
      const imported = draft.skills.some((s) => s.id === 'alpha' && s.mode === 'import');
      // Figures the weights below cannot add up to: the client must only relay them.
      return Response.json({
        agent: 'Zeus',
        // Unchecking alpha brings back the one the project gives it; beta is excluded by the agent.
        skills: ids.includes('alpha')
          ? [{ id: 'alpha', mode: imported ? 'import' : 'include', via: 'agent' }]
          : [{ id: 'alpha', mode: 'import', via: 'project' }],
        excluded: ids.includes('beta') ? ['beta'] : [],
        skills_tokens: imported ? 7777 : 111,
        on_demand_tokens: imported ? 0 : 222,
        prompt_tokens: imported ? 55000 : 44000,
      });
    }
    if (url === '/api/ui/agents') return Response.json({ agents: [{ name: 'Zeus' }] });
    if (url === '/api/ui/agents/Zeus') return Response.json({ name: 'Zeus', skills: ['alpha'], role: 'coder' });
    if (url.startsWith('/api/ui/skills')) return Response.json({ skills: [{ id: 'alpha', source: 'timon' }, { id: 'beta', source: 'timon' }] });
    if (url === '/api/ui/skill-weights') {
      return Response.json({ weights: { alpha: { include: 20, import: 3000, on_demand: 3100 }, beta: { include: 15, import: 800, on_demand: 820 } } });
    }
    if (url.startsWith('/api/ui/skill-attachments?')) return Response.json({ attachments: [] });
    if (url === '/api/ui/agents/Zeus/skills') return Response.json({ skills: [{ id: 'alpha', mode: 'include', via: 'config' }] });
    return Response.json({ agents: [], skills: [], servers: [], roles: [], projects: [], files: [], backends: [] });
  });
  const root = createRoot(document.getElementById('root')!);
  const button = (text: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);
  const total = () => document.querySelector('[data-testid="spawn-context-total"]')?.textContent ?? '';
  try {
    await React.act(async () => {
      root.render(React.createElement(AgentEditorModal));
      openAgentEditor({ agent: 'Zeus' });
    });
    await waitUntil(React.act, () => button('Skills') !== undefined, 'editor tabs loaded');
    assert.equal(previews.length, 0, 'not asked before its tab is open');
    await React.act(async () => { button('Skills')!.click(); });
    await waitUntil(React.act, () => total() === '~44k tokens' && document.querySelector('[data-testid="skill-weight-alpha"]') !== null, 'daemon total shown');
    assert.equal(previews.at(-1)!.agent, 'Zeus');
    assert.deepEqual(previews.at(-1)!.skills, [{ id: 'alpha', mode: 'include' }]);
    assert.match(document.querySelector('[data-testid="skill-weight-alpha"]')!.textContent!, /~20 tokens · \+3\.1k if read/);
    assert.match(document.body.textContent!, /\/beta~15/, 'an unchecked box weighs the catalogue line checking it would add');
    assert.match(document.body.textContent!, /Skills: ~111 tokens of it/);
    assert.match(document.body.textContent!, /Catalogue skills cost ~222 more tokens/);

    const picker = document.querySelector('[aria-label="How alpha reaches the agent"]')!;
    await React.act(async () => {
      Array.from(picker.querySelectorAll('button')).find((b) => b.textContent === 'Import')!.click();
    });
    await waitUntil(React.act, () => total() === '~55k tokens', 'a mode change asks the daemon again');
    assert.deepEqual(previews.at(-1)!.skills, [{ id: 'alpha', mode: 'import' }]);
    assert.match(document.querySelector('[data-testid="skill-weight-alpha"]')!.textContent!, /^~3k tokens$/, 'an imported skill costs no read');
    assert.doesNotMatch(document.body.textContent!, /more tokens only when the agent reads them/, 'no catalogue skill left');

    // A box the agent excludes: said, and its weight is not shown as if it counted.
    assert.ok(!document.querySelector('[data-testid="spawn-context-excluded"]'));
    await React.act(async () => { button('/beta~15')!.click(); });
    await waitUntil(React.act, () => document.querySelector('[data-testid="spawn-context-excluded"]') !== null, 'exclusion said');
    assert.match(document.querySelector('[data-testid="spawn-context-excluded"]')!.textContent!, /not injected: \/beta/);
    assert.ok(!document.querySelector('[data-testid="skill-weight-beta"]'));

    // Unchecking a skill that narrowed an inherited one: the inherited one is listed again.
    assert.doesNotMatch(document.body.textContent!, /Inherited/i);
    await React.act(async () => { button('/alpha~3k')!.click(); });
    await waitUntil(React.act, () => /Inherited/i.test(document.body.textContent!), 'the inherited skill is back');

    // No figure rather than a wrong one.
    previewFails = true;
    await React.act(async () => { button('/beta~15')!.click(); });
    await waitUntil(React.act, () => total() === '', 'a refused preview shows no total');
  } finally {
    await React.act(async () => { closeAgentEditor(); root.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    setLocale(previousLocale);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
