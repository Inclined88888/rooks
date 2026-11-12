/**
 * The search field and its results, over a small layout: typing narrows the
 * list live, a section opens its tab, a row is editable where it stands and
 * the cross empties the field.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

async function withDom(run: (env: {
  React: typeof import('react');
  root: import('react-dom/client').Root;
  dom: import('jsdom').JSDOM;
}) => Promise<void>): Promise<void> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    const value = (dom.window as unknown as Record<string, unknown>)[key];
    install(key, key === 'window' ? dom.window : typeof value === 'function' && /^[a-z]/.test(key) ? value.bind(dom.window) : value);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  try {
    await run({ React, root, dom });
  } finally {
    await React.act(async () => { root.unmount(); });
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

async function harness(env: Parameters<Parameters<typeof withDom>[0]>[0]) {
  const { SettingsSearchField, SettingsSearchResultsView } = await import('./settings-search');
  const { buildSettingsLayout } = await import('@/lib/settings-layout');
  const { searchSettings, searchTerms } = await import('@/lib/settings-search');
  const rows = [
    { key: 'ROOKS_MAX_LIVE_MISSIONS', group: 'Missions', advanced: false, label: 'Max live missions', description: 'How many missions run at once.' },
    { key: 'ROOKS_LOG_SYSTEM_PROMPT', group: 'Misc', advanced: true, label: 'Log the system prompt', description: 'Verbose, for debugging.' },
    { key: 'ROOKS_FALLBACK_COOLDOWN_MS', group: 'LLM fallback', advanced: true, label: 'Fallback cooldown', description: null },
  ];
  const layout = buildSettingsLayout({
    rows, includeAdvanced: true, pluginStates: new Map(), pluginLabels: new Map(), plugins: [], graftedGroups: new Set(), desktop: false,
  });
  const opened: unknown[] = [];
  const { React } = env;
  function Harness() {
    const [query, setQuery] = React.useState('');
    const results = searchTerms(query).length > 0
      ? searchSettings({
        query, layout, rows,
        categoryLabel: (id) => id,
        tabLabel: (_c, tab) => tab.id,
        rowKeywords: (key) => (key === 'ROOKS_MAX_LIVE_MISSIONS' ? ['concurrency'] : []),
        tabKeywords: () => [],
      })
      : null;
    return React.createElement(
      'div', null,
      React.createElement(SettingsSearchField, { value: query, onChange: setQuery }),
      results && React.createElement(SettingsSearchResultsView, {
        query, results, categoryLabel: (id: string) => id, tabLabel: (_c: string, tab: { id: string }) => tab.id,
        onOpen: (target: unknown) => { opened.push(target); setQuery(''); },
        renderRow: (key: string) => React.createElement('div', { 'data-row': key }, key),
      }),
    );
  }
  await env.React.act(async () => { env.root.render(env.React.createElement(Harness)); });
  const input = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  const type = async (value: string) => {
    await env.React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(env.dom.window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, value);
      input.dispatchEvent(new env.dom.window.Event('input', { bubbles: true }));
    });
  };
  const rowsShown = () => Array.from(document.querySelectorAll('[data-row]')).map((el) => el.getAttribute('data-row'));
  return { input, type, rowsShown, opened };
}

test('typing lists matching rows live, including a row that used to be advanced', async () => {
  await withDom(async (env) => {
    const { input, type, rowsShown } = await harness(env);
    assert.equal(input.getAttribute('aria-label'), 'Search settings');
    assert.deepEqual(rowsShown(), [], 'nothing before a query');
    await type('debug');
    assert.deepEqual(rowsShown(), ['ROOKS_LOG_SYSTEM_PROMPT']);
    assert.equal(document.querySelector('[role="status"]')?.textContent, '1 result', 'one result is singular');
    await type('missions');
    assert.ok(rowsShown().includes('ROOKS_MAX_LIVE_MISSIONS'));
    await type('zzz');
    assert.deepEqual(rowsShown(), []);
    assert.match(document.body.textContent ?? '', /No setting matches “zzz”/);
  });
});

test('a hidden keyword finds a row by a word the screen never shows', async () => {
  await withDom(async (env) => {
    const { type, rowsShown } = await harness(env);
    await type('concurrency');
    assert.deepEqual(rowsShown(), ['ROOKS_MAX_LIVE_MISSIONS']);
  });
});

test('a section result opens its tab; the cross clears the field and the results', async () => {
  await withDom(async (env) => {
    const { input, type, opened } = await harness(env);
    await type('cooldown');
    const section = Array.from(document.querySelectorAll('section button')).find((b) => /fallback/.test(b.textContent ?? ''));
    assert.ok(section, 'the Auto switch pane is offered');
    await env.React.act(async () => { (section as HTMLElement).click(); });
    assert.deepEqual(opened, [{ category: 'models', tab: 'fallback' }]);
    assert.equal(input.value, '');

    await type('live');
    const clear = document.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]');
    assert.ok(clear, 'a clear button once there is text');
    await env.React.act(async () => { clear.click(); });
    assert.equal(input.value, '');
    assert.equal(document.querySelectorAll('[data-row]').length, 0);
    assert.equal(document.querySelectorAll('button[aria-label="Clear search"]').length, 0);
  });
});
