/**
 * An Orchestration selection that was picked but not applied is a pending
 * edit like any other field of the agent editor: closing the editor asks
 * before dropping it, and Apply puts the warning out.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { answerConfirmsForTests } from '@/components/confirm-dialog/confirm-dialog-context';
import { waitUntil } from './test-wait';

test('closing the editor warns about an unapplied orchestration selection, and Apply clears the warning', async () => {
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
  const asked: string[] = [];
  let answer = false;
  answerConfirmsForTests(({ title }) => { asked.push(title); return answer; });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AgentEditorModal, openAgentEditor, closeAgentEditor } = await import('../components/agent-editor/agent-editor-modal');
  const { getLocale, setLocale } = await import('./i18n');
  const previousLocale = getLocale();
  setLocale('en');

  const zeus = { name: 'Zeus', orchestrates: null, effective_orchestrates: ['Hera'], orchestrates_source: 'reports_to' };
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/ui/agents/Zeus/orchestrates' && init?.method === 'PUT') {
      return Response.json({ name: 'Zeus', orchestrates: ['Apollo', 'Hera'], effective_orchestrates: ['Apollo', 'Hera'], orchestrates_source: 'explicit' });
    }
    if (url === '/api/ui/agents') return Response.json({ agents: [zeus, { name: 'Hera' }, { name: 'Apollo' }] });
    if (url === '/api/ui/agents/Zeus') return Response.json(zeus);
    return Response.json({ agents: [], skills: [], servers: [], roles: [], projects: [], files: [], backends: [], teams: [] });
  });

  const root = createRoot(document.getElementById('root')!);
  const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
  const click = (el: HTMLElement | null | undefined) => React.act(async () => { assert.ok(el); el.click(); });
  const closeButton = () => document.querySelector<HTMLElement>('button[aria-label="Close"]');
  try {
    await React.act(async () => {
      root.render(React.createElement(AgentEditorModal));
      openAgentEditor({ agent: 'Zeus' });
    });
    // The form is fetched on first open (next/dynamic).
    await waitUntil(React.act, () => document.querySelector('[role="tab"]') !== null, 'editor form loaded');
    await click(Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).find((b) => /orchestration/i.test(b.textContent ?? '')));
    assert.ok($('[data-orchestration]'), 'the Orchestration tab shows the list');

    // Untouched: closing asks nothing.
    await click($('[data-orchestration-none]'));
    await click($('[data-orchestration-restore]'));
    assert.equal($('[data-orchestration-state]')!.getAttribute('data-orchestration-state'), 'inherited');
    await click(closeButton());
    assert.deepEqual(asked, [], 'nothing pending, nothing asked');
    assert.equal($('[data-orchestration]'), null, 'the editor closed');

    // Picked, not applied: closing warns, and answering no keeps the editor.
    await React.act(async () => { openAgentEditor({ agent: 'Zeus' }); });
    await click(Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).find((b) => /orchestration/i.test(b.textContent ?? '')));
    await click($('[data-orchestration-all]'));
    await click(closeButton());
    assert.deepEqual(asked, ['Discard unsaved changes?']);
    assert.ok($('[data-orchestration]'), 'declining keeps the editor open and the selection');
    assert.equal($('[data-orchestration-state]')!.getAttribute('data-orchestration-state'), 'unsaved');

    // Applied: the warning is out.
    await click($('[data-orchestration-all]'));
    await click($('[data-orchestration-apply]'));
    assert.equal($('[data-orchestration-state]')!.getAttribute('data-orchestration-state'), 'explicit');
    await click(closeButton());
    assert.equal(asked.length, 1, 'no second warning after Apply');
    assert.equal($('[data-orchestration]'), null, 'the editor closed');

    // Picked, then the tab is left: the selection is dropped with the tab, so closing asks nothing.
    await React.act(async () => { openAgentEditor({ agent: 'Zeus' }); });
    const orchestrationTab = () => Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).find((b) => /orchestration/i.test(b.textContent ?? ''));
    await click(orchestrationTab());
    await click($('[data-orchestration-all]'));
    assert.equal($('[data-orchestration-state]')!.getAttribute('data-orchestration-state'), 'unsaved');
    await click(Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).find((b) => /identity/i.test(b.textContent ?? '')));
    assert.equal($('[data-orchestration]'), null, 'the Orchestration tab unmounted');
    await click(closeButton());
    assert.equal(asked.length, 1, 'a selection dropped with its tab no longer warns');
    assert.equal($('[data-orchestration]'), null, 'the editor closed');
  } finally {
    await React.act(async () => { closeAgentEditor(); root.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    setLocale(previousLocale);
    answerConfirmsForTests(null);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
