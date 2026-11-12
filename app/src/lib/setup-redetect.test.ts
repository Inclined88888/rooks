import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * SUG-0006: a tester installed a prerequisite by hand while `/setup` was open
 * and had to close the window and restart the daemon for it to be seen,
 * losing what they had chosen. The screen now offers Re-detect at all times,
 * reads the machine again when the window comes back, and keeps its draft.
 */

type Dom = { window: Window & typeof globalThis };

async function withDom<T>(url: string, run: (dom: Dom, react: typeof import('react')) => Promise<T>): Promise<T> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url, pretendToBeVisual: true });
  const globals = globalThis as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'NodeFilter', 'MutationObserver', 'Event', 'CustomEvent', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  try {
    return await run(dom as unknown as Dom, React);
  } finally {
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
  }
}

const CLAUDE = { id: 'claude', label: 'Claude', brand: 'anthropic', order: 2, suggested: false, seedsMainAgent: true };

function doctor(nodeInstalled: boolean) {
  return {
    desktop: false, platform: 'linux', supervisor: 'systemd-user', linux: null, blockers: [],
    binaries: [
      { name: 'node', ok: nodeInstalled, path: nodeInstalled ? '/usr/local/bin/node' : null, installCommand: null },
      { name: 'git', ok: true, path: '/usr/bin/git', installCommand: null },
      { name: 'claude', ok: true, path: '/usr/bin/claude', installCommand: null, provider: CLAUDE },
    ],
  };
}

test('Re-detect stays on screen, the window coming back reads the machine, the draft survives a reload', async () => {
  await withDom('http://localhost/setup', async (dom, React) => {
    const { createRoot } = await import('react-dom/client');
    const { default: SetupPage } = await import('../app/setup/page');
    const originalFetch = globalThis.fetch;
    let nodeInstalled = false;
    let doctorReads = 0;
    globalThis.fetch = (async (input: string) => {
      switch (String(input)) {
        case '/api/ui/doctor': doctorReads++; return Response.json(doctor(nodeInstalled));
        case '/api/ui/onboarding': return Response.json({ ok: true, installed: true });
        case '/api/ui/setup/resume': return Response.json({ present: false, agents: 0, projects: 0, missions: 0 });
        default: throw new Error(`Unexpected request: ${input}`);
      }
    }) as typeof globalThis.fetch;
    // What the user had ticked before reloading the page.
    dom.window.sessionStorage.setItem('rooks.setupDraft', JSON.stringify({ binaries: {}, appEnabled: true }));
    const root = createRoot(document.getElementById('root')!);
    const redetect = () => Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Re-detect');
    try {
      await React.act(async () => { root.render(React.createElement(SetupPage)); });
      const appBox = () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      assert.equal(appBox().checked, true, 'the draft is restored');
      assert.match(document.body.textContent!, /node/);
      assert.ok(redetect(), 'offered while a prerequisite is missing');

      // node installed by hand in a terminal, then Re-detect.
      nodeInstalled = true;
      const before = doctorReads;
      await React.act(async () => { redetect()!.click(); });
      assert.equal(doctorReads, before + 1);
      assert.match(document.body.textContent!, /Everything this machine needs was found/);
      assert.ok(redetect(), 'still offered once nothing is missing');

      // Coming back to the window right after a read: no second request.
      await React.act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
      assert.equal(doctorReads, before + 1);
      await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_100)); });
      await React.act(async () => { window.dispatchEvent(new dom.window.Event('focus')); });
      assert.equal(doctorReads, before + 2, 'the window coming back reads the machine again');

      // Unticking is a choice too: the draft follows it.
      await React.act(async () => { appBox().click(); });
      assert.equal(dom.window.sessionStorage.getItem('rooks.setupDraft'), null);
    } finally {
      await React.act(async () => { root.unmount(); });
      globalThis.fetch = originalFetch;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
});
