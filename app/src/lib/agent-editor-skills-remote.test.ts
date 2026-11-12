import assert from 'node:assert/strict';
import test from 'node:test';
import { waitUntil } from './test-wait';

// In its own file: the backend catalogue is cached per process.
test('agent editor: on a backend that cannot read a skill on demand, every skill shows whole and the saved choice is left alone', async () => {
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
    if (url === '/api/ui/skill-attachments/preview') {
      return Response.json({
        agent: 'Zeus',
        // `alpha` loses a file only because of the budget it shares; `house` answers as an older daemon does.
        skills: [{ id: 'alpha', mode: 'import', via: 'agent', tokens: 3000, left_out: ['diagram.png', 'references/big.md'] }, { id: 'house', mode: 'import', via: 'project' }],
        excluded: [],
        skills_tokens: 6005,
        on_demand_tokens: 0,
        prompt_tokens: 11005,
      });
    }
    if (url === '/api/ui/agents' && method === 'POST') return Response.json({ ok: true });
    if (url === '/api/ui/skill-attachments' && method === 'POST') return Response.json({ id: 9 });
    if (url === '/api/ui/agents') return Response.json({ agents: [{ name: 'Zeus', backend: 'gateway' }] });
    if (url === '/api/ui/agents/Zeus') return Response.json({ name: 'Zeus', backend: 'gateway', skills: ['alpha'] });
    if (url.startsWith('/api/ui/backends/catalog')) {
      return Response.json({
        defaultBackend: 'gateway',
        backends: [{ id: 'gateway', label: 'Gateway', models: [], defaultModel: null, capabilities: { worktree: false, rooksMcp: false, attachments: false } }],
      });
    }
    if (url.startsWith('/api/ui/skills')) return Response.json({ skills: [{ id: 'alpha', source: 'rooks' }, { id: 'beta', source: 'rooks' }] });
    if (url === '/api/ui/skill-weights') {
      return Response.json({
        weights: {
          alpha: { include: 20, import: 3000, on_demand: 3100, pasted: 4000, left_out: ['diagram.png'] },
          beta: { include: 15, import: 800, on_demand: 820 },
          house: { include: 10, import: 2000, on_demand: 2100, pasted: 2000, left_out: ['data/big.csv'] },
        },
        headings: { include: 80, import: 5 },
      });
    }
    if (url.startsWith('/api/ui/skill-attachments?')) return Response.json({ attachments: [] });
    if (url === '/api/ui/agents/Zeus/skills') {
      return Response.json({ skills: [{ id: 'alpha', mode: 'include', via: 'config' }, { id: 'house', mode: 'include', via: 'project' }] });
    }
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
    await React.act(async () => { button('Skills')!.click(); });
    await waitUntil(React.act, () => document.querySelector('[data-testid="skills-whole-only"]') !== null && total() !== '', 'notice and total shown');
    assert.match(document.querySelector('[data-testid="skills-whole-only"]')!.textContent!, /cannot read a skill later/);

    // What the spawn sends: alpha and house whole with the files next to them, one import heading, no catalogue.
    assert.equal(total(), '~11k tokens', 'the prompt\'s own total');
    await waitUntil(React.act, () => /^~3k tokens$/.test(document.querySelector('[data-testid="skill-weight-alpha"]')?.textContent ?? ''), 'the weight the prompt really pays, not the 4k measured alone');
    assert.match(document.querySelector('[data-testid="skills-whole-only"]')!.textContent!, /text files next to each SKILL\.md are pasted too/);
    // The files the body may cite and this backend does not get are named, checked and inherited alike.
    assert.match(document.querySelector('[data-testid="skill-left-out-alpha"]')!.textContent!, /Not sent to this backend \(2\): diagram\.png, references\/big\.md/);
    assert.match(document.querySelector('[data-testid="skill-left-out-house"]')!.textContent!, /data\/big\.csv/);
    assert.ok(!document.querySelector('[data-testid="skill-left-out-beta"]'), 'unchecked, nothing to warn about');
    assert.doesNotMatch(document.body.textContent!, /more tokens only when the agent reads them/);
    assert.match(document.body.textContent!, /\/beta~800/, 'an unchecked box weighs what checking it would really add');
    assert.match(document.body.textContent!, /\/house\s*imported · project/, 'an inherited skill too');

    const picker = document.querySelector('[aria-label="How alpha reaches the agent"]')!;
    const of = (label: string) => Array.from(picker.querySelectorAll('button')).find((b) => b.textContent === label)!;
    assert.equal(of('Import').getAttribute('aria-pressed'), 'true');
    assert.equal(of('Catalogue').getAttribute('aria-pressed'), 'false');
    assert.ok(of('Catalogue').disabled && of('Import').disabled, 'the choice is not this backend\'s to offer');

    await React.act(async () => { button('Save')!.click(); });
    await waitUntil(React.act, () => writes.some((w) => w.url === '/api/ui/skill-attachments'), 'attachment written');
    assert.deepEqual(writes.find((w) => w.url === '/api/ui/skill-attachments')!.body, {
      skill: 'alpha', scope: 'agent', target: 'Zeus', mode: 'include',
    }, 'saving never turns the choice into an import');
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
