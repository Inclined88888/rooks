/**
 * Right-click on a mission of the rail: "Copy CLI session ID" copies the full
 * id of the backend CLI's session, shown shortened beside the label, and the
 * entry is absent while the mission has none (TODO #419).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from '../../lib/test-wait';

import type { MissionSummary } from './chat-types';

const SESSION = '0f1e2d3c-4b5a-6978-8a9b-acbdcedfe0f1';

const copied: string[] = [];

function install(key: string, value: unknown) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

async function setupDom() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter',
    'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'sessionStorage',
  ] as const) install(key, key === 'self' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => { copied.push(text); } },
  });
  // The rail's side reads (agents, stored layout) answer empty: nothing here
  // depends on them.
  install('fetch', async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }));
  return dom;
}
let domReady: ReturnType<typeof setupDom> | null = null;

async function mount(missions: MissionSummary[]) {
  const dom = await (domReady ??= setupDom());
  copied.length = 0;
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { MissionRail } = await import('./mission-rail');

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => {
    root.render(React.createElement(MissionRail, {
      agentId: 'demo.main',
      missions,
      currentMissionId: null,
      onPick: () => {},
      onNew: () => {},
    }));
  });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const rowOf = (missionTitle: string) => Array.from(document.querySelectorAll<HTMLElement>('[draggable], .group'))
    .find((node) => node.textContent?.includes(missionTitle));
  const items = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
  const rightClick = async (missionTitle: string) => {
    await until(() => !!rowOf(missionTitle), `the row of "${missionTitle}"`);
    const row = rowOf(missionTitle)!;
    await React.act(async () => {
      row.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    await until(() => items().length > 0, `the menu of "${missionTitle}" to open`);
  };
  const unmount = async () => { await React.act(async () => { root.unmount(); }); host.remove(); };
  return { copied, rightClick, items, until, unmount, React, dom };
}

function mission(id: string, title: string, session_id?: string | null): MissionSummary {
  return { id, mission: title, title, status: 'completed', running: false, started_at: 1, ended_at: 2, session_id };
}

test('the entry copies the full session id and shows it shortened, in the product font', async () => {
  const ui = await mount([mission('m-with', 'With a session', SESSION)]);
  try {
    await ui.rightClick('With a session');
    const entry = ui.items().find((b) => b.textContent?.includes('Copy CLI session ID'));
    if (!entry) assert.fail('the menu does not offer "Copy CLI session ID"');
    assert.ok(entry.textContent?.includes('0f1e2d3c…'), 'the shortened id is shown');
    assert.ok(!entry.textContent?.includes(SESSION), 'not the full id');
    assert.equal(entry.title, SESSION, 'the full id on hover');
    assert.ok(!entry.outerHTML.includes('font-mono'), 'rule 16: no monospace on a label');
    await ui.React.act(async () => { entry.click(); });
    await ui.until(() => ui.copied.length > 0, 'the session id to be copied');
    assert.deepEqual(ui.copied, [SESSION]);
  } finally {
    await ui.unmount();
  }
});

test('no entry while the mission has no session id', async () => {
  const ui = await mount([mission('m-none', 'Not started yet', null), mission('m-old', 'Older daemon')]);
  try {
    for (const title of ['Not started yet', 'Older daemon']) {
      await ui.rightClick(title);
      const labels = ui.items().map((b) => b.textContent ?? '');
      assert.ok(labels.some((l) => l.includes('Copy ID')), 'the menu did open');
      assert.ok(!labels.some((l) => l.includes('Copy CLI session ID')), `no session entry for "${title}"`);
      await ui.React.act(async () => { window.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'Escape' })); });
      await ui.until(() => ui.items().length === 0, 'Escape to close the menu');
      assert.equal(ui.items().length, 0, 'Escape closed the menu');
    }
  } finally {
    await ui.unmount();
  }
});

test('shortSessionId keeps a short id whole and cuts a uuid to its head', async () => {
  const { shortSessionId } = await import('@/lib/mission-session-id');
  assert.equal(shortSessionId(SESSION), '0f1e2d3c…');
  assert.equal(shortSessionId('thread-42'), 'thread-42');
});
