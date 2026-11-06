import assert from 'node:assert/strict';
import test from 'node:test';

test('deferred restart stays accessible after navigation, retries errors and disappears after relaunch', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('document', dom.window.document);
  install('navigator', dom.window.navigator);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { SetupRestartBanner } = await import('../components/setup-restart-banner');
  let root = createRoot(document.getElementById('root')!);
  const render = () => React.act(async () => { root.render(React.createElement(SetupRestartBanner)); });
  const remount = async () => {
    await React.act(async () => root.unmount());
    root = createRoot(document.getElementById('root')!);
    await render();
  };
  try {
    await render();
    assert.ok(!document.querySelector('button'), 'web has no restart capability');
    let pending = false;
    let attempts = 0;
    window.timonDesktop = {
      setupRestartPending: async () => pending,
      restartAfterSetup: async () => {
        attempts++;
        if (attempts === 1) throw new Error('handover failed');
      },
    };
    await remount();
    assert.ok(!document.querySelector('button'), 'no setup pending');
    pending = true;
    await remount();
    assert.match(document.querySelector('[role="status"]')!.textContent!, /finish setup/);
    dom.window.history.pushState(null, '', '/agents');
    await remount();
    assert.equal(document.querySelector('button')!.textContent, 'Restart Timon');
    await React.act(async () => document.querySelector('button')!.click());
    assert.ok(document.querySelector('[role="alert"]'));
    assert.equal(document.querySelector('button')!.disabled, false);
    await React.act(async () => {
      document.querySelector('button')!.click();
      document.querySelector('button')!.click();
    });
    assert.equal(attempts, 2, 'double clicks cannot request two restarts');
    assert.equal(document.querySelector('button')!.disabled, true);
    assert.equal(document.querySelector('button')!.textContent, 'Restarting…');
    pending = false;
    await remount();
    assert.ok(!document.querySelector('button'), 'successful relaunch clears the reminder');
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
