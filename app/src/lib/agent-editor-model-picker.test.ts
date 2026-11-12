/**
 * The agent editor's LLM tab on the shared ModelPicker (`agent-editor.tsx`),
 * against a stubbed daemon. An agent pinned on an account the catalogue no
 * longer lists keeps that pin through a save, shown disabled; an account to
 * sign in again stays browsable but not pickable; an empty model reads as the
 * backend's default; a picked row is what Save sends.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { answerConfirmsForTests } from '@/components/confirm-dialog/confirm-dialog-context';
import { waitUntil } from './test-wait';
import type { BackendCatalog } from './backends';

const CATALOG: BackendCatalog = {
  defaultBackend: 'claude',
  backends: [
    {
      id: 'claude', label: 'Claude', vendor: 'Anthropic', brand: 'anthropic', defaultModel: 'opus',
      models: [
        { slug: 'opus', label: 'Opus', presetRank: 1 },
        { slug: 'haiku', label: 'Haiku', presetRank: 2 },
      ],
    },
    {
      id: 'claude@krz', label: 'Claude', vendor: 'Anthropic', brand: 'anthropic', defaultModel: 'opus',
      instanceOf: 'claude', account: { id: 'krz', name: 'KRZDIGITAL', state: 'reauth' },
      models: [{ slug: 'opus', label: 'Opus', presetRank: 1 }],
    },
    {
      id: 'codex', label: 'Codex', vendor: 'OpenAI', brand: 'openai', defaultModel: 'gpt-5.5',
      models: [{ slug: 'gpt-5.5', label: 'GPT-5.5' }],
    },
  ],
};

const AGENTS: Record<string, Record<string, unknown>> = {
  Zeus: { name: 'Zeus', backend: 'claude@gone', model: 'opus' },
  Hera: { name: 'Hera', backend: 'claude', model: '' },
};

test('the agent editor picks its pair on the ModelPicker and never swaps a gone account', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/agents', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'NodeFilter',
    'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'DocumentFragment'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  answerConfirmsForTests(() => true);
  const posts: Array<{ name: string; config: Record<string, unknown> }> = [];
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/ui/agents' && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return Response.json({ ok: true });
    }
    if (url.includes('/api/ui/backends/catalog')) return Response.json(CATALOG);
    if (url.endsWith('/api/ui/prefs/model-favorites')) return Response.json({ favorites: [] });
    if (url === '/api/ui/agents') return Response.json({ agents: Object.values(AGENTS) });
    const one = /^\/api\/ui\/agents\/([^/]+)$/.exec(url);
    if (one && AGENTS[decodeURIComponent(one[1]!)]) return Response.json(AGENTS[decodeURIComponent(one[1]!)]);
    return Response.json({ agents: [], skills: [], servers: [], roles: [], projects: [], files: [] });
  });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AgentEditorModal, openAgentEditor, closeAgentEditor } = await import('../components/agent-editor/agent-editor-modal');
  const { invalidateBackendCatalog } = await import('./backends');
  const { resetModelFavoritesForTest } = await import('../hooks/use-model-favorites');
  const { getLocale, setLocale } = await import('./i18n');
  const previousLocale = getLocale();
  setLocale('en');
  invalidateBackendCatalog();
  resetModelFavoritesForTest();

  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const rows = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-picker-row]'));
  const row = (text: string) => rows().find((el) => el.textContent?.includes(text));
  const rail = (label: string) => document.querySelector<HTMLButtonElement>(`nav button[aria-label="${label}"]`);
  const button = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === text);
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
  };
  const openLlmTab = async (agent: string) => {
    await React.act(async () => { openAgentEditor({ agent }); });
    await until(() => document.querySelector<HTMLInputElement>('[role="tabpanel"] input')?.value === agent, `${agent} loaded`);
    await click(Array.from(document.querySelectorAll('[role="tab"]')).find((b) => b.textContent === 'LLM'));
    await until(() => rows().length > 0, 'picker rows painted');
  };
  try {
    await React.act(async () => { root.render(React.createElement(AgentEditorModal)); });

    await openLlmTab('Zeus');
    const orphan = row('opus · ');
    assert.ok(orphan, 'the pinned pair on a gone account is shown');
    assert.equal(orphan.disabled, true);
    assert.equal(orphan.getAttribute('aria-pressed'), 'true');
    assert.equal(rows().filter((r) => r.getAttribute('aria-pressed') === 'true').length, 1, 'no other account lights up instead');
    await click(button('Save'));
    assert.equal(posts[0]?.config.backend, 'claude@gone', 'the pin survives a save');
    assert.equal(posts[0]?.config.model, 'opus');
    await React.act(async () => { closeAgentEditor(); });

    await openLlmTab('Hera');
    assert.equal(row('Opus')?.getAttribute('aria-pressed'), 'true', 'an empty model reads as the backend default');
    await click(rail('Anthropic · KRZDIGITAL'));
    assert.ok(rows().length > 0 && rows().every((r) => r.disabled), 'an account to sign in again is shown, not pickable');
    await click(rail('OpenAI'));
    await click(row('GPT-5.5'));
    assert.equal(row('GPT-5.5')?.getAttribute('aria-pressed'), 'true');
    await click(button('Save'));
    assert.equal(posts[1]?.config.backend, 'codex');
    assert.equal(posts[1]?.config.model, 'gpt-5.5');
  } finally {
    await React.act(async () => { closeAgentEditor(); root.unmount(); });
    // Radix restores focus on a timer; keep DOM globals alive until it finishes.
    await new Promise((resolve) => setTimeout(resolve, 0));
    invalidateBackendCatalog();
    resetModelFavoritesForTest();
    setLocale(previousLocale);
    answerConfirmsForTests(null);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
