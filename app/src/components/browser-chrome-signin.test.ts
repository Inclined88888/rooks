import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * The sign-in dialog of the embedded browser: it says plainly when no Chrome is
 * installed, never offers to open one then, and drives start/finish otherwise.
 */
async function withDom<T>(run: (env: { React: typeof import('react'); root: import('react-dom/client').Root; install: (key: string, value: unknown) => void }) => Promise<T>): Promise<T> {
  const { JSDOM } = await import('jsdom');
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
    return await run({ React, root, install });
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

test('without Chrome the dialog gives the reason and opens nothing', async () => {
  await withDom(async ({ React, root, install }) => {
    install('fetch', async () => Response.json({ available: true, chrome: { available: false, reason: 'none', message: 'No Google Chrome, Microsoft Edge or Chromium was found on this computer.' } }));
    const sent: string[] = [];
    const { BrowserChromeSignin } = await import('./browser-chrome-signin');
    await React.act(async () => {
      root.render(React.createElement(BrowserChromeSignin, {
        controlled: true, close: () => {},
        command: (async (action: string) => { sent.push(action); return { state: 'idle' }; }) as never,
      }));
    });
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /No Google Chrome, Microsoft Edge or Chromium was found/);
    const open = buttons(/Open Chrome/)[0]!;
    assert.equal(open.disabled, true);
    await React.act(async () => { open.click(); });
    assert.deepEqual(sent.filter((action) => action !== 'chromeSigninStatus'), []);
  });
});

test('with Chrome: open, then done copies the sign-in and reports how many cookies', async () => {
  await withDom(async ({ React, root, install }) => {
    install('fetch', async () => Response.json({ available: true, chrome: { available: true, name: 'Google Chrome' } }));
    const sent: string[] = [];
    let state: Record<string, unknown> = { state: 'idle' };
    const { BrowserChromeSignin } = await import('./browser-chrome-signin');
    await React.act(async () => {
      root.render(React.createElement(BrowserChromeSignin, {
        controlled: true, close: () => {},
        command: (async (action: string) => {
          sent.push(action);
          if (action === 'chromeSigninStart') state = { state: 'open' };
          if (action === 'chromeSigninFinish') state = { state: 'finished', imported: 12, skipped: 1 };
          return state;
        }) as never,
      }));
    });
    const open = buttons(/Open Chrome \(Google Chrome\)/)[0]!;
    assert.equal(open.disabled, false);
    await React.act(async () => { open.click(); });
    assert.match(document.body.textContent ?? '', /Chrome is open on the computer running Rooks/);
    assert.equal(buttons(/Open Chrome/).length, 0, 'a window already open is not opened twice');
    await React.act(async () => { buttons(/Done, copy the sign-in/)[0]!.click(); });
    assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /12 cookie\(s\) copied/);
    assert.deepEqual(sent.filter((action) => action !== 'chromeSigninStatus'), ['chromeSigninStart', 'chromeSigninFinish']);
  });
});

test('a control held by another device keeps the button off', async () => {
  await withDom(async ({ React, root, install }) => {
    install('fetch', async () => Response.json({ available: true, chrome: { available: true, name: 'Microsoft Edge' } }));
    const { BrowserChromeSignin } = await import('./browser-chrome-signin');
    await React.act(async () => {
      root.render(React.createElement(BrowserChromeSignin, { controlled: false, close: () => {}, command: (async () => ({ state: 'idle' })) as never }));
    });
    assert.equal(buttons(/Open Chrome/)[0]!.disabled, true);
  });
});
