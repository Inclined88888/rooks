/**
 * TODO #887: the mobile list of the Agents page draws each row through
 * `AgentAvatar`, so it follows the agent's picked head (`config.avatar`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const LOOK = { shape: 'hex', color: '#7ed957', eyes: 'code', acc: 'coffee' };
const FULL = { emoji: '🦊', icon_url: '/api/uploads/nova.png', look: LOOK };

test('mobile list: each row draws the agent through AgentAvatar, picked head first', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/agents', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter',
    'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame',
  ] as const) install(key, key === 'self' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  install('EventSource', class { close() {} addEventListener() {} removeEventListener() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url === '/api/ui/agents') {
      return Response.json({ agents: [
        { name: 'alpha', main: true, role: 'orchestrator', ...FULL, avatar: 'mascot' },
        { name: 'beta', role: 'orchestrator', ...FULL, avatar: 'emoji' },
        { name: 'gamma', role: 'orchestrator', ...FULL },
      ] });
    }
    return Response.json({ agents: [] });
  });
  const React = await import('react');
  install('React', React);
  const { createElement } = React;
  const { createRoot } = await import('react-dom/client');
  const { MobileAgentList } = await import('./mobile-agent-list');
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await React.act(async () => { root.render(createElement(MobileAgentList)); });
    const opener = dom.window.document.querySelector<HTMLButtonElement>('button');
    assert.ok(opener, 'the floating button');
    await React.act(async () => { opener.click(); });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const rowOf = (name: string) => Array.from(dom.window.document.querySelectorAll<HTMLElement>('a'))
      .find((a) => a.textContent?.includes(name));
    assert.ok(rowOf('alpha')?.querySelector('[data-agent-mascot] svg'), 'alpha: its mascot');
    const beta = rowOf('beta');
    assert.ok(beta && !beta.querySelector('[data-agent-mascot], img') && beta.textContent?.includes('🦊'), 'beta: its emoji');
    assert.equal(rowOf('gamma')?.querySelector('img')?.getAttribute('src'), '/api/uploads/nova.png', 'gamma: no pick, its picture');
  } finally {
    await React.act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  }
});
