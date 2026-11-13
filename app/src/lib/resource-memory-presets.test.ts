import assert from 'node:assert/strict';
import test from 'node:test';

test('memory preset controls show the daemon facts, save once, refresh and handle failures', async (suite) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/settings', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { NativeSettingsContext } = await import('./plugin-host/settings-graft');
  const { ResourceMemoryPresets } = await import('../plugins-client/settings/resource-memory-presets');
  const originalFetch = globalThis.fetch;
  const root = createRoot(document.getElementById('root')!);
  const resourceMemory = {
    detectedRamGb: 12,
    autoClassGb: 8,
    presets: [
      { ramGb: 8, missionGb: 2, dayGb: 3, nightGb: 4 },
      { ramGb: 16, missionGb: 4, dayGb: 6, nightGb: 8 },
      { ramGb: 32, missionGb: 8, dayGb: 10, nightGb: 16 },
      { ramGb: 64, missionGb: 12, dayGb: 16, nightGb: 24 },
    ],
  };
  let refreshes = 0;
  let refreshOk = true;
  const refresh = async () => { refreshes++; return refreshOk; };
  const render = async (info: typeof resourceMemory | null = resourceMemory) => {
    await React.act(async () => root.render(React.createElement(NativeSettingsContext.Provider,
      { value: { resourceMemory: info, refresh } }, React.createElement(ResourceMemoryPresets))));
  };
  try {
    await suite.test('no facts from an older daemon means no misleading controls', async () => {
      await render(null);
      assert.ok(!document.querySelector('button'));
    });
    await suite.test('the preview shows detected RAM, automatic class and all four choices', async () => {
      await render();
      assert.match(document.body.textContent!, /12\.0 GB/);
      assert.match(document.body.textContent!, /8 GB class/);
      assert.deepEqual(Array.from(document.querySelectorAll('button')).map((b) => b.textContent), ['8 GB', '16 GB', '32 GB', '64 GB']);
      assert.match(document.body.textContent!, /Environment and configuration values keep priority/);
    });
    await suite.test('pending writes disable every button; success refreshes the editable values', async () => {
      let finish!: (response: Response) => void;
      let requests = 0;
      globalThis.fetch = async (input, init) => {
        requests++;
        assert.equal(String(input), '/api/ui/settings/resource-memory-preset');
        assert.equal(init?.method, 'POST');
        assert.deepEqual(JSON.parse(String(init?.body)), { ramGb: 16 });
        return new Promise<Response>((resolve) => { finish = resolve; });
      };
      await React.act(async () => document.querySelectorAll('button')[1]!.click());
      assert.ok(Array.from(document.querySelectorAll('button')).every((button) => button.disabled));
      await React.act(async () => document.querySelectorAll('button')[0]!.click());
      assert.equal(requests, 1);
      await React.act(async () => finish(Response.json({ ok: true })));
      assert.equal(refreshes, 1);
      assert.match(document.querySelector('[role="status"]')!.textContent!, /Preset saved/);
      assert.ok(Array.from(document.querySelectorAll('button')).every((button) => !button.disabled));
    });
    await suite.test('HTTP and network errors remain visible and allow retry', async () => {
      for (const failure of [async () => Response.json({}, { status: 403 }), async (): Promise<Response> => { throw new Error('offline'); }]) {
        globalThis.fetch = failure;
        await React.act(async () => document.querySelector('button')!.click());
        assert.match(document.querySelector('[role="alert"]')!.textContent!, /Could not apply/);
        assert.ok(!document.querySelector('[role="status"]'));
        assert.equal(refreshes, 1);
        assert.ok(Array.from(document.querySelectorAll('button')).every((button) => !button.disabled));
      }
    });
    await suite.test('failed refresh does not announce stale fields as updated', async () => {
      refreshOk = false;
      globalThis.fetch = async () => Response.json({ ok: true });
      await React.act(async () => document.querySelector('button')!.click());
      assert.ok(document.querySelector('[role="alert"]'));
      assert.ok(!document.querySelector('[role="status"]'));
    });
  } finally {
    await React.act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
