import assert from 'node:assert/strict';
import test from 'node:test';

type Row = { key: string; type: string; group: string; label: string; description: null; unit: string | null;
  advanced: boolean; value: string | boolean | number; default: string | boolean | number;
  source: 'env' | 'config' | 'db' | 'default'; overridden: boolean };

function rows(over: Partial<Record<string, Partial<Row>>> = {}): Row[] {
  const base = (key: string, value: Row['value'], extra: Partial<Row> = {}): Row => ({
    key, type: typeof value === 'boolean' ? 'bool' : 'string', group: 'LLM fallback', label: key, description: null,
    unit: null, advanced: false, value, default: value, source: 'default', overridden: false, ...extra, ...over[key],
  });
  return [
    base('TIMON_FALLBACK_ENABLED', true),
    base('TIMON_FALLBACK_BACKEND', 'codex'),
    base('TIMON_FALLBACK_MODEL', ''),
  ];
}

test('fallback pane writes the backend/model pair in order and honours locks', async (suite) => {
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
  const { FallbackSettings } = await import('../components/fallback-settings');
  const originalFetch = globalThis.fetch;
  const root = createRoot(document.getElementById('root')!);

  let current = rows();
  const puts: { key: string; value: string | null }[] = [];
  let failKey: string | null = null;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === '/api/ui/backends/catalog') return Response.json({ defaultBackend: 'claude', backends: [{
      id: 'codex', label: 'Codex', brand: 'openai', defaultModel: 'gpt-6.1-sol',
      models: [{ slug: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }, { slug: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' }],
    }] });
    if (url === '/api/ui/settings' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { key: string; value: string | null };
      puts.push(body);
      if (body.key === failKey) return Response.json({ error: 'nope' }, { status: 403 });
      return Response.json({ ok: true });
    }
    if (url === '/api/ui/settings') return Response.json({ settings: current });
    throw new Error(`unexpected fetch ${url}`);
  };
  const button = (label: RegExp) => Array.from(document.querySelectorAll('button'))
    .find((b) => label.test(b.textContent ?? ''));
  const trigger = () => document.querySelector<HTMLButtonElement>('button[aria-label="Change the fallback model"]');
  const render = async () => {
    await React.act(async () => root.render(React.createElement(FallbackSettings)));
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };

  try {
    await suite.test('the control itself shows the current pair, without opening anything', async () => {
      await render();
      assert.match(trigger()!.textContent!, /GPT-6\.1 Sol/);
      assert.match(trigger()!.textContent!, /Codex · default model/);
      assert.equal(document.querySelectorAll('input').length, 0);
      assert.ok(!button(/^Default$/), 'nothing to reset while both keys are defaults');
    });

    await suite.test('"Remove" empties backend then model', async () => {
      puts.length = 0;
      await React.act(async () => button(/^Remove$/)!.click());
      assert.deepEqual(puts, [
        { key: 'TIMON_FALLBACK_BACKEND', value: '' },
        { key: 'TIMON_FALLBACK_MODEL', value: '' },
      ]);
    });

    await suite.test('a refused first write never writes the model alone', async () => {
      puts.length = 0;
      failKey = 'TIMON_FALLBACK_BACKEND';
      await React.act(async () => button(/^Remove$/)!.click());
      assert.deepEqual(puts.map((p) => p.key), ['TIMON_FALLBACK_BACKEND']);
      failKey = null;
    });

    await suite.test('an explicit model is named with its backend; a reset clears both keys', async () => {
      current = rows({
        TIMON_FALLBACK_BACKEND: { source: 'db', overridden: true },
        TIMON_FALLBACK_MODEL: { value: 'gpt-5.6-terra', source: 'db', overridden: true },
      });
      await React.act(async () => root.unmount());
      const again = createRoot(document.getElementById('root')!);
      await React.act(async () => again.render(React.createElement(FallbackSettings)));
      assert.match(trigger()!.textContent!, /GPT-5\.6 Terra\s*Codex/);
      puts.length = 0;
      const reset = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Default');
      assert.ok(reset, 'reset button present');
      await React.act(async () => reset!.click());
      assert.deepEqual(puts, [
        { key: 'TIMON_FALLBACK_BACKEND', value: null },
        { key: 'TIMON_FALLBACK_MODEL', value: null },
      ]);
      await React.act(async () => again.unmount());
    });

    await suite.test('an empty backend reads as no last resort', async () => {
      current = rows({ TIMON_FALLBACK_BACKEND: { value: '', source: 'db', overridden: true } });
      const empty = createRoot(document.getElementById('root')!);
      await React.act(async () => empty.render(React.createElement(FallbackSettings)));
      assert.match(trigger()!.textContent!, /No last resort/);
      await React.act(async () => empty.unmount());
    });

    await suite.test('a pair forced by the environment cannot be changed here', async () => {
      current = rows({ TIMON_FALLBACK_BACKEND: { value: 'grok', source: 'env' } });
      const locked = createRoot(document.getElementById('root')!);
      await React.act(async () => locked.render(React.createElement(FallbackSettings)));
      assert.match(document.body.textContent!, /forced by environment/);
      assert.equal(trigger()!.disabled, true);
      assert.ok(!button(/^Remove$/));
      await React.act(async () => locked.unmount());
    });
  } finally {
    globalThis.fetch = originalFetch;
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
