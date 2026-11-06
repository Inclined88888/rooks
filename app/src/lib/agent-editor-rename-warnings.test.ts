import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { renameFollowUps } from './agent-rename';
import { waitUntil } from './test-wait';

test('renameFollowUps reads the answer and survives a malformed one', () => {
  assert.deepEqual(renameFollowUps({ ok: true }), { triggers: [], warnings: [] });
  assert.deepEqual(renameFollowUps(null), { triggers: [], warnings: [] });
  assert.deepEqual(renameFollowUps({ triggers_to_check: 'x', warnings: 3 }), { triggers: [], warnings: [] });
  assert.deepEqual(
    renameFollowUps({ triggers_to_check: [{ id: '1', name: 'nightly' }, { id: '2' }, null], warnings: ['profile', 1] }),
    { triggers: ['nightly'], warnings: ['profile'] },
  );
});

test('renaming from the agent form shows the triggers to check, and is quiet when there are none', async (t) => {
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
  // The CommonJS copy of sonner: the one the compiled component resolves.
  const { toast } = createRequire(join(process.cwd(), 'package.json'))('sonner') as typeof import('sonner');
  const { AgentEditorModal, openAgentEditor, closeAgentEditor } = await import('../components/agent-editor/agent-editor-modal');
  const { getLocale, setLocale } = await import('./i18n');
  const previousLocale = getLocale();
  setLocale('en');

  const warned: Array<{ message: string; action?: { label: string } }> = [];
  t.mock.method(toast, 'warning', ((message: string, options?: { action?: { label: string } }) => {
    warned.push({ message, action: options?.action });
    return 1;
  }) as typeof toast.warning);

  let renameAnswer: Record<string, unknown> = {};
  let renamed: { from: string; body: unknown } | null = null;
  let current = 'Zeus';
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const rename = /^\/api\/ui\/agents\/([^/]+)\/rename$/.exec(url);
    if (rename) {
      renamed = { from: decodeURIComponent(rename[1]!), body: JSON.parse(String(init?.body)) };
      return Response.json({ ok: true, ...renameAnswer });
    }
    if (url === '/api/ui/agents' && init?.method === 'POST') {
      current = (JSON.parse(String(init.body)) as { name: string }).name;
      return Response.json({ ok: true });
    }
    if (url === '/api/ui/agents') return Response.json({ agents: [{ name: current }] });
    if (url === `/api/ui/agents/${current}`) return Response.json({ name: current });
    return Response.json({ agents: [], skills: [], servers: [], roles: [], projects: [], files: [], backends: [] });
  });

  const root = createRoot(document.getElementById('root')!);
  const nameInput = () => document.querySelector<HTMLInputElement>('[role="tabpanel"] input');
  const renameTo = async (name: string) => {
    await waitUntil(React.act, () => nameInput()?.value === current, 'editor shows the agent');
    const input = nameInput()!;
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, name);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await React.act(async () => {
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Save')!.click();
    });
    await waitUntil(React.act, () => current === name, 'the save reached the daemon');
  };
  try {
    await React.act(async () => {
      root.render(React.createElement(AgentEditorModal));
      openAgentEditor({ agent: 'Zeus' });
    });
    renameAnswer = {
      triggers_to_check: [{ id: 't1', name: 'nightly watch', reason: 'r' }, { id: 't2', name: 'deploy watch', reason: 'r' }],
      warnings: ['browser profile "x": still targets "Zeus"'],
    };
    await renameTo('Jupiter');
    assert.deepEqual(renamed, { from: 'Zeus', body: { newName: 'Jupiter' } });
    assert.equal(warned.length, 2);
    assert.match(warned[0]!.message, /Zeus is now Jupiter/);
    assert.match(warned[0]!.message, /2 trigger\(s\)/);
    assert.match(warned[0]!.message, /nightly watch, deploy watch/);
    assert.equal(warned[0]!.action?.label, 'Open triggers');
    assert.equal(warned[1]!.message, 'browser profile "x": still targets "Zeus"');

    warned.length = 0;
    renameAnswer = {};
    await renameTo('Ammon');
    assert.deepEqual(warned, [], 'nothing left to check: no warning');
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
