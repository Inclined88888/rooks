import assert from 'node:assert/strict';
import test from 'node:test';
import type { WebUiAccessReport } from './webui-access';

/** What the daemon answers on a machine behind Traefik, tailnet up. */
const REPORT: WebUiAccessReport = {
  app: { servedByDaemon: false, host: '127.0.0.1', port: 3100, loopbackOnly: true, publicUrl: 'http://rooks.localhost' },
  addresses: [{ iface: 'enp6s0', address: '192.168.1.50', family: 'ipv4' }],
  tailscale: {
    installed: true,
    platform: 'linux',
    installCommand: 'curl -fsSL https://tailscale.com/install.sh | sudo sh',
    state: 'Running',
    dnsName: 'my-laptop.tail0000.ts.net',
    addresses: ['100.64.0.1'],
    serve: [{ host: 'my-laptop.tail0000.ts.net:443', target: 'http://127.0.0.1:80' }],
  },
  security: {
    daemon: { host: '127.0.0.1', port: 3001, loopbackOnly: true, auth: 'auto', authEnforced: false },
    behindTlsProxy: false,
    trustedProxies: [],
    users: 1,
  },
};

test('the WebUI tab reads the daemon, and answers the PWA question per origin', async (suite) => {
  const { JSDOM } = await import('jsdom');
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  const originalFetch = globalThis.fetch;

  const render = async (url: string, answer: () => Response, panel = false) => {
    const dom = new JSDOM('<div id="root"></div>', { url, pretendToBeVisual: true });
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'NodeFilter', 'MutationObserver', 'Event', 'CustomEvent', 'getComputedStyle']) {
      install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
    }
    install('IS_REACT_ACT_ENVIRONMENT', true);
    const React = await import('react');
    // The compiled JSX references `React` as a global here, exactly as the
    // setup-page render test does.
    install('React', React);
    const { createRoot } = await import('react-dom/client');
    const { WebUiSettings } = await import('../components/webui-settings');
    const { RemoteAccess } = await import('../components/remote-access-panel');
    globalThis.fetch = async (input) => {
      assert.equal(String(input), '/api/ui/webui-access');
      return answer();
    };
    const root = createRoot(document.getElementById('root')!);
    await React.act(async () => { root.render(React.createElement(panel ? RemoteAccess : WebUiSettings)); });
    if (panel) {
      await React.act(async () => { document.querySelector('button')!.click(); });
    }
    const text = document.getElementById('root')!.textContent ?? '';
    await React.act(async () => { root.unmount(); });
    return text;
  };

  try {
    await suite.test('on rooks.localhost: installable, and the facts come from the daemon', async () => {
      const text = await render('http://rooks.localhost/?settings=network%2Fwebui', () => Response.json(REPORT));
      // The origin, not a detected address: the one witness that cannot be wrong.
      assert.match(text, /This screenhttp:\/\/rooks\.localhost/);
      // Served outside the daemon — the config bind is reported as such.
      assert.match(text, /Served outside the daemon/);
      assert.match(text, /192\.168\.1\.50/);
      assert.match(text, /enp6s0/);
      assert.match(text, /my-laptop\.tail0000\.ts\.net/);
      // The serve chain, shown without a reachability verdict.
      assert.match(text, /http:\/\/127\.0\.0\.1:80/);
      // The localhost exception: a secure context without any TLS.
      assert.match(text, /is a secure context/);
      assert.doesNotMatch(text, /is not a secure context/);
      // Posture, read-only.
      assert.match(text, /not enforced/);
      assert.doesNotMatch(text, /tailscale serve --bg/);
      assert.match(text, /local web address is unknown/);
      assert.match(text, /A handler already exists/);
      // Tailnet up and a handler published: the tile says so.
      assert.match(text, /Remote accessReady/);
      assert.match(text, /No trusted proxy/);
    });

    await suite.test('on a LAN address in plain HTTP: no PWA, and the tab says why', async () => {
      const text = await render('http://192.168.1.50:3100/?settings=network%2Fwebui', () => Response.json(REPORT));
      assert.match(text, /is not a secure context/);
      // Even an explicit browser port may be a proxy port.
      assert.doesNotMatch(text, /tailscale serve --bg/);
    });

    await suite.test('both panels suppress unknown Docker targets and follow an enabled daemon on 3101', async () => {
      for (const panel of [false, true]) {
        const external = { ...REPORT, app: { ...REPORT.app, port: 3101 } };
        const text = await render('https://rooks.localhost', () => Response.json(external), panel);
        assert.doesNotMatch(text, /tailscale serve --bg/);
        assert.match(text, /local web address is unknown/);
        const enabled = { ...external, app: { ...external.app, servedByDaemon: true } };
        const ready = await render('https://rooks.localhost', () => Response.json(enabled), panel);
        assert.match(ready, /tailscale serve --bg --https=443 http:\/\/127\.0\.0\.1:3101/);
        assert.doesNotMatch(ready, /127\.0\.0\.1:3100/);
      }
    });

    await suite.test('setup remains usable without a diagnostic response', async () => {
      for (const answer of [
        () => Response.json({}, { status: 401 }),
        () => Response.json({}, { status: 403 }),
        () => Response.json({}, { status: 500 }),
        () => new Response('invalid json'),
        () => { throw new Error('offline'); },
      ]) {
        const text = await render('https://rooks.localhost', answer, true);
        assert.doesNotMatch(text, /tailscale serve --bg/);
        assert.match(text, /local web address is unknown/);
      }
    });

    await suite.test('tailscale absent: the command names the HOST\'s OS, not the browser\'s', async () => {
      const absent = {
        ...REPORT,
        tailscale: { ...REPORT.tailscale, installed: false, state: null, dnsName: null, addresses: [], serve: [] },
      };
      // Read from a phone, on a daemon hosted by a Mac: the install command
      // must be the Mac's, and say so — installing Tailscale on the phone
      // never puts the HOST on the tailnet.
      const mac = { ...absent, tailscale: { ...absent.tailscale, platform: 'darwin', installCommand: 'brew install --cask tailscale' } };
      const text = await render('http://rooks.localhost/?settings=network%2Fwebui', () => Response.json(mac));
      assert.match(text, /Tailscale not installed/);
      assert.match(text, /machine hosting Rooks \(macOS\)/);
      assert.match(text, /brew install --cask tailscale/);
      assert.match(text, /Mac App Store/);

      // A platform we know no command for: an honest blank, never an invented
      // package name.
      const unknown = { ...absent, tailscale: { ...absent.tailscale, platform: 'freebsd', installCommand: null } };
      const blank = await render('http://rooks.localhost/?settings=network%2Fwebui', () => Response.json(unknown));
      assert.match(blank, /No install command is known/);
      assert.doesNotMatch(blank, /install\.sh/);
    });

    await suite.test('a refused read says so instead of showing an empty tab', async () => {
      const text = await render('http://rooks.localhost/?settings=network%2Fwebui', () => Response.json({ error: 'nope' }, { status: 403 }));
      assert.match(text, /requires an administrator account/);
      assert.doesNotMatch(text, /secure context/);
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
