import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * The ending of the wizard, which is no longer a dialog.
 *
 * `/setup` used to confirm in a portal carrying a "restart later" button, and
 * that button was the normal way out: the cockpit then opened on a daemon still
 * running the configuration the wizard had just replaced. Saving now NAVIGATES —
 * to step 3 when the team steps are due, to step 5 (the restart) otherwise —
 * and step 5 is where the restart happens, for real, verified.
 */

type Dom = { window: Window & typeof globalThis; close: () => void };

/** One jsdom + React environment, restored whatever happens. */
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

const DOCTOR = {
  desktop: true, platform: 'linux', supervisor: 'systemd-user', linux: null, blockers: [],
  binaries: ['node', 'git', 'claude'].map((name) => ({
    name, ok: true, path: `/bin/${name}`, installCommand: null,
    ...(name === 'claude' ? { provider: { id: 'claude', label: 'Claude', brand: 'anthropic', order: 2, suggested: false, seedsMainAgent: true } } : {}),
  })),
};

test('where the wizard goes once the configuration is written', async () => {
  const { afterSetup } = await import('./setup-plan');
  assert.equal(afterSetup({ teamOnboarding: true }), '/setup/agent');
  // Step 3 not due: straight to the cockpit, where the banner offers the restart.
  assert.equal(afterSetup({ teamOnboarding: false }), '/');
  assert.equal(afterSetup({}), '/');
});

test('saving the configuration never ends on a dialog', async (suite) => {
  await withDom('http://localhost/setup', async (dom, React) => {
    const { createRoot } = await import('react-dom/client');
    const { default: SetupPage } = await import('../app/setup/page');
    const originalFetch = globalThis.fetch;
    try {
      for (const mode of ['failed-save', 'saved'] as const) {
        await suite.test(mode, async () => {
          delete (window as { novaDesktop?: unknown }).novaDesktop;
          globalThis.fetch = (async (input: string) => {
            switch (String(input)) {
              case '/api/ui/doctor': return Response.json(DOCTOR);
              case '/api/ui/onboarding': return Response.json({ ok: false, installed: true });
              case '/api/ui/setup/resume': return Response.json({ present: false, agents: 0, projects: 0, missions: 0 });
              case '/api/ui/setup': return mode === 'failed-save'
                ? Response.json({ error: 'disk full' }, { status: 500 })
                : Response.json({ path: '/tmp/existing-instance/rooks.config.json', teamOnboarding: false });
              default: throw new Error(`Unexpected request: ${input}`);
            }
          }) as typeof globalThis.fetch;
          const root = createRoot(document.getElementById('root')!);
          try {
            await React.act(async () => { root.render(React.createElement(SetupPage)); });
            // Nothing pops up any more, at any point.
            assert.ok(!document.querySelector('[role="dialog"]'));
            await React.act(async () => {
              document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
            });
            assert.ok(!document.querySelector('[role="dialog"]'));
            if (mode === 'failed-save') {
              // A failed save stays on the screen, with the daemon's own words.
              assert.match(document.querySelector('[role="alert"]')!.textContent!, /disk full/);
              return;
            }
            // Saved: no confirmation, no "restart later", nothing to dismiss —
            // the navigation is `afterSetup`, tested above (jsdom will not let a
            // test observe one).
            assert.ok(!document.querySelector('[role="dialog"]'));
            assert.equal(Array.from(document.querySelectorAll('button')).some((b) => /Later|Next steps/.test(b.textContent ?? '')), false);
          } finally {
            await React.act(async () => { root.unmount(); });
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('on the desktop, saving hands over to the service before step 3', async () => {
  await withDom('http://localhost/setup', async (dom, React) => {
    const { createRoot } = await import('react-dom/client');
    const { default: SetupPage } = await import('../app/setup/page');
    const originalFetch = globalThis.fetch;
    const asked: string[] = [];
    (window as { novaDesktop?: unknown }).novaDesktop = {
      restartAfterSetup: async () => {},
      // The shell takes the window and never answers the page.
      handOverToService: (route: string) => { asked.push(route); return new Promise<string>(() => {}); },
    };
    globalThis.fetch = (async (input: string) => {
      switch (String(input)) {
        case '/api/ui/doctor': return Response.json(DOCTOR);
        case '/api/ui/onboarding': return Response.json({ ok: true, installed: true });
        case '/api/ui/setup/resume': return Response.json({ present: false, agents: 0, projects: 0, missions: 0 });
        case '/api/ui/setup': return Response.json({ path: '/tmp/existing-instance/rooks.config.json', teamOnboarding: true });
        default: throw new Error(`Unexpected request: ${input}`);
      }
    }) as typeof globalThis.fetch;
    const root = createRoot(document.getElementById('root')!);
    try {
      await React.act(async () => { root.render(React.createElement(SetupPage)); });
      if (asked.length === 0) {
        await React.act(async () => {
          document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
        });
      }
      assert.deepEqual([...new Set(asked)], ['/setup/agent']);
      // Said while the shell swaps daemons, rather than a page that stops answering.
      const submit = document.querySelector('button[type="submit"]')!;
      assert.match(submit.textContent ?? '', /Restarting Rooks/);
      assert.equal((submit as HTMLButtonElement).disabled, true);
    } finally {
      await React.act(async () => { root.unmount(); });
      globalThis.fetch = originalFetch;
      delete (window as { novaDesktop?: unknown }).novaDesktop;
    }
  });
});

test('step 5 restarts the daemon, waits for a NEW one, and cannot be walked past', async (suite) => {
  await withDom('http://localhost/setup/restart', async (_dom, React) => {
    const { createRoot } = await import('react-dom/client');
    const { default: RestartPage } = await import('../app/setup/restart/page');
    const originalFetch = globalThis.fetch;
    const click = async (label: string) => {
      const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(label));
      assert.ok(button, `button ${label}`);
      await React.act(async () => { button.click(); });
    };
    try {
      await suite.test('the daemon restarts itself', async () => {
        delete (window as { novaDesktop?: unknown }).novaDesktop;
        let pending = true;
        let restarts = 0;
        globalThis.fetch = (async (input: string, init?: RequestInit) => {
          assert.equal(String(input), '/api/ui/setup/restart');
          if (init?.method === 'POST') { restarts++; pending = false; return Response.json({ restarting: true }); }
          return Response.json({ pending, supervisor: 'systemd-user', canSelfRestart: true, command: 'systemctl --user restart rooks-orchestrator' });
        }) as typeof globalThis.fetch;
        const root = createRoot(document.getElementById('root')!);
        try {
          await React.act(async () => { root.render(React.createElement(RestartPage)); });
          // Pending: no way into the product is offered.
          assert.ok(!document.querySelector('a[href="/"]'));
          await click('Restart now');
          assert.equal(restarts, 1);
          // The new daemon is detected by polling, not by trusting the click.
          await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 1700)); });
          assert.ok(document.querySelector('a[href="/"]'), 'the way in opens once a new process answers');
          assert.match(document.body.textContent!, /Rooks is ready/);
        } finally {
          await React.act(async () => { root.unmount(); });
        }
      });

      await suite.test('the desktop client restarts the daemon it owns, and gives the button back when it refuses', async () => {
        let restarts = 0;
        (window as { novaDesktop?: unknown }).novaDesktop = {
          restartAfterSetup: async () => {
            restarts++;
            // First launch of the package: the embedded daemon still holds the
            // port and the shell refuses. The button must come back.
            if (restarts === 1) throw new Error('daemon still running');
          },
        };
        let pending = true;
        globalThis.fetch = (async (_input: string, init?: RequestInit) => {
          assert.notEqual(init?.method, 'POST', 'the client owns the restart, not the daemon');
          return Response.json({ pending, supervisor: 'systemd-user', canSelfRestart: true, command: 'systemctl --user restart rooks-orchestrator' });
        }) as typeof globalThis.fetch;
        const root = createRoot(document.getElementById('root')!);
        try {
          await React.act(async () => { root.render(React.createElement(RestartPage)); });
          await click('Restart now');
          assert.equal(restarts, 1);
          const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('Restart now'));
          assert.ok(button, 'the button is back, not stuck on "Restarting…"');
          assert.equal(button.disabled, false);
          assert.match(document.querySelector('[role="alert"]')!.textContent!, /could not be started/);
          pending = false;
          await click('Restart now');
          assert.equal(restarts, 2);
          await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 1700)); });
          assert.ok(document.querySelector('a[href="/"]'));
        } finally {
          await React.act(async () => { root.unmount(); });
          delete (window as { novaDesktop?: unknown }).novaDesktop;
        }
      });

      await suite.test('a daemon that cannot restart itself shows the command', async () => {
        delete (window as { novaDesktop?: unknown }).novaDesktop;
        globalThis.fetch = (async (_input: string, init?: RequestInit) => (init?.method === 'POST'
          ? Response.json({ restarting: false, command: 'launchctl kickstart -k gui/$(id -u)/com.rooks.daemon' }, { status: 409 })
          : Response.json({ pending: true, supervisor: 'launchd', canSelfRestart: false, command: 'launchctl kickstart -k gui/$(id -u)/com.rooks.daemon' }))) as typeof globalThis.fetch;
        const root = createRoot(document.getElementById('root')!);
        try {
          await React.act(async () => { root.render(React.createElement(RestartPage)); });
          assert.match(document.body.textContent!, /launchctl kickstart/);
          // No automatic button at all, and still no way into the product.
          assert.equal(Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.includes('Restart now')), false);
          assert.ok(!document.querySelector('a[href="/"]'));
        } finally {
          await React.act(async () => { root.unmount(); });
        }
      });

      await suite.test('a machine with no supervisor may continue', async () => {
        delete (window as { novaDesktop?: unknown }).novaDesktop;
        let skipped = 0;
        globalThis.fetch = (async (input: string, init?: RequestInit) => {
          if (String(input) === '/api/ui/setup/restart/skip') {
            skipped++;
            return Response.json({ pending: false, supervisor: null, canSelfRestart: false, command: null });
          }
          assert.notEqual(init?.method, 'POST', 'nothing to restart here');
          return Response.json({ pending: true, supervisor: null, canSelfRestart: false, command: null });
        }) as typeof globalThis.fetch;
        const root = createRoot(document.getElementById('root')!);
        try {
          await React.act(async () => { root.render(React.createElement(RestartPage)); });
          await click('Continue without restarting');
          assert.equal(skipped, 1);
          assert.ok(document.querySelector('a[href="/"]'));
        } finally {
          await React.act(async () => { root.unmount(); });
        }
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});


test('TIM-0018: installed CLI without login shows the searched path and clears after recheck', async () => {
  await withDom('http://localhost/setup', async (_dom, React) => {
    const { createRoot } = await import('react-dom/client');
    const { default: SetupPage } = await import('../app/setup/page');
    const originalFetch = globalThis.fetch;
    let connected = false;
    const authPath = 'test-credentials/auth.json';
    globalThis.fetch = (async (input: string) => {
      switch (String(input)) {
        // Codex alone: with a working Claude next to it the backend block is hidden.
        case '/api/ui/doctor': return Response.json({ ...DOCTOR,
          binaries: [...DOCTOR.binaries.filter((b) => b.name !== 'claude'), {
            name: 'codex', ok: true, path: 'codex', installCommand: null,
            provider: { id: 'codex', label: 'GPT', brand: 'openai', order: 1, suggested: true, seedsMainAgent: true },
          }],
          auth: [{ provider: 'codex', binary: 'codex', ok: connected, detail: 'd', signInCommand: connected ? null : 'codex login', path: authPath }],
        });
        case '/api/ui/onboarding': return Response.json({ ok: true, installed: true });
        case '/api/ui/setup/resume': return Response.json({ present: false });
        default: throw new Error(`Unexpected request: ${input}`);
      }
    }) as typeof globalThis.fetch;
    const root = createRoot(document.getElementById('root')!);
    try {
      await React.act(async () => { root.render(React.createElement(SetupPage)); });
      const alert = Array.from(document.querySelectorAll('[role="alert"]')).find((node) => node.textContent?.includes(authPath));
      assert.ok(alert, 'missing credentials must be visible even though the binary is installed');
      assert.match(alert.textContent!, /codex login/);
      const recheck = alert.querySelector(':scope > button') as HTMLButtonElement;
      connected = true;
      await React.act(async () => { recheck.click(); });
      assert.ok(!document.body.textContent?.includes(authPath));
    } finally {
      await React.act(async () => root.unmount());
      globalThis.fetch = originalFetch;
    }
  });
});

test('neither the first run nor a resume sends a working folder', async () => {
  await withDom('http://localhost/setup', async (dom, React) => {
    const { createRoot } = await import('react-dom/client');
    const { default: SetupPage } = await import('../app/setup/page');
    const originalFetch = globalThis.fetch;
    const sent: Record<string, Record<string, unknown>> = {};
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url !== '/api/ui/onboarding') sent[url] = JSON.parse(String(init.body)) as Record<string, unknown>;
      switch (url) {
        case '/api/ui/doctor': return Response.json(DOCTOR);
        case '/api/ui/onboarding': return Response.json({ ok: true, installed: true });
        case '/api/ui/setup/resume': return init?.method === 'POST'
          ? Response.json({ error: 'stop here' }, { status: 409 })
          : Response.json({ present: true, agents: 2, projects: 1, missions: 3, workspacesRoot: '/home/u/old-projects' });
        case '/api/ui/setup': return Response.json({ error: 'stop here' }, { status: 500 });
        default: throw new Error(`Unexpected request: ${input}`);
      }
    }) as typeof globalThis.fetch;
    const root = createRoot(document.getElementById('root')!);
    try {
      await React.act(async () => { root.render(React.createElement(SetupPage)); });
      // Nothing on screen asks for a folder any more.
      assert.ok(!document.querySelector('input:not([type="checkbox"])'));
      await React.act(async () => {
        document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      });
      assert.ok(sent['/api/ui/setup']);
      assert.equal('workspacesRoot' in sent['/api/ui/setup'], false);
      assert.equal(sent['/api/ui/setup'].vaultPath, '');
      const resume = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Resume where I left off')!;
      await React.act(async () => { resume.click(); });
      assert.ok(sent['/api/ui/setup/resume']);
      assert.equal('workspacesRoot' in sent['/api/ui/setup/resume'], false);
    } finally {
      await React.act(async () => root.unmount());
      globalThis.fetch = originalFetch;
    }
  });
});
