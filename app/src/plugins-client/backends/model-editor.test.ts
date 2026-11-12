import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '@/lib/i18n';
import '@/lib/i18n-test-locales';

test('model editor renders aligned persistent column headings only for model rows', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/settings', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver', 'Event']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { ModelEditor } = await import('./model-editor');
  const root = createRoot(document.getElementById('root')!);
  const render = async (models: { slug: string; label: string }[]) => {
    await React.act(async () => root.render(React.createElement(ModelEditor, {
      models,
      defaultModel: null,
      onChange: () => undefined,
    })));
  };

  try {
    await render([]);
    assert.ok(!document.querySelector('[data-model-column-headings]'));

    await render([{ slug: 'deepseek-chat', label: 'DeepSeek Chat' }]);
    const headings = document.querySelector('[data-model-column-headings]')!;
    assert.match(headings.textContent!, /Slug.*Label.*Context window/);
    assert.equal(headings.querySelector('[title="Default model"]')?.getAttribute('aria-label'), 'Default model');
    assert.equal(headings.querySelector('[title="Visible in model selectors"]')?.getAttribute('aria-label'), 'Visible in model selectors');
    assert.ok(headings.querySelector('.flex-\\[2\\]'));
    assert.ok(headings.querySelector('.flex-\\[3\\]'));
    assert.ok(headings.querySelector('.flex-\\[1\\.4\\]'));

    setLocale('fr');
    await render([{ slug: 'deepseek-chat', label: 'DeepSeek Chat' }]);
    assert.match(document.querySelector('[data-model-column-headings]')!.textContent!, /Slug.*Libellé.*Fenêtre de contexte/);
  } finally {
    setLocale('en');
    await React.act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
