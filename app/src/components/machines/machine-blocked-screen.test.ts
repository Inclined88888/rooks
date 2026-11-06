/**
 * The screen a remote machine that cannot be used gets instead of a cockpit:
 * it names the machine and the reason, and its way back is answered locally.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

async function withDom(run: (env: { React: typeof import('react'); root: import('react-dom/client').Root; install: (key: string, value: unknown) => void }) => Promise<void>): Promise<void> {
  const { JSDOM } = await import('jsdom');
  // jsdom does not navigate: the reload that follows a successful switch only
  // logs "not implemented", which is not this test's business.
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('self', dom.window);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  try {
    await run({ React, root, install });
  } finally {
    await React.act(async () => { root.unmount(); });
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

const buttons = (label: RegExp) => Array.from(document.querySelectorAll('button')).filter((b) => label.test(b.textContent ?? ''));

test('each reason is named, with the machine, and the way back is always there', async () => {
  await withDom(async ({ React, root }) => {
    const { MachineBlockedScreen } = await import('./machine-blocked-screen');
    for (const [reason, title] of [
      ['unreachable', /VPS cannot be reached/],
      ['unauthorized', /VPS no longer accepts this computer/],
      ['incompatible', /VPS is too old for this interface/],
      ['unknown', /This machine is not in your fleet/],
      ['session_required', /Sign in on this computer/],
      ['unavailable', /VPS cannot be opened from here/],
    ] as const) {
      await React.act(async () => { root.render(React.createElement(MachineBlockedScreen, { name: 'VPS', reason, apiLevel: 0 })); });
      const text = document.body.textContent ?? '';
      assert.match(text, title, reason);
      assert.doesNotMatch(text, /machines\.blocked/, `${reason}: every key is translated`);
      assert.equal(buttons(/Back to this computer/).length, 1, reason);
    }
  });
});

test('an incompatible machine says which level it speaks and which one is needed', async () => {
  await withDom(async ({ React, root }) => {
    const { MachineBlockedScreen } = await import('./machine-blocked-screen');
    await React.act(async () => { root.render(React.createElement(MachineBlockedScreen, { name: null, reason: 'incompatible', apiLevel: 0 })); });
    const text = document.body.textContent ?? '';
    assert.match(text, /This machine is too old/);
    assert.match(text, /interface level 0, and this interface needs at least 1/);
    // Retrying would land on the same refusal: no Retry, only the way back.
    assert.equal(buttons(/Try again/).length, 0);
  });
});

test('going back posts the local switch to the app, never to the machine', async () => {
  await withDom(async ({ React, root, install }) => {
    const calls: Array<{ url: string; body: unknown }> = [];
    install('fetch', async (input: string, init?: RequestInit) => {
      calls.push({ url: input, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json({ id: 'local', warning: null });
    });
    const { MachineBlockedScreen } = await import('./machine-blocked-screen');
    await React.act(async () => { root.render(React.createElement(MachineBlockedScreen, { name: 'VPS', reason: 'unreachable', apiLevel: null })); });
    await React.act(async () => { buttons(/Back to this computer/)[0]!.click(); });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    assert.deepEqual(calls, [{ url: '/api/ui/machines/active', body: { id: 'local' } }]);
  });
});
