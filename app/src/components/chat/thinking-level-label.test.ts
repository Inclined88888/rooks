/**
 * The reasoning level in the composer bar sits behind a brain icon (TODO #430).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('the reasoning level carries a brain icon', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'SVGElement'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React); // the component is compiled with the classic JSX runtime
  const { createRoot } = await import('react-dom/client');
  const { ThinkingLevelLabel } = await import('./thinking-level-label');
  const root = createRoot(document.getElementById('root')!);
  try {
    await React.act(async () => {
      root.render(React.createElement(ThinkingLevelLabel, { label: 'high', explicit: true, afterModel: true }));
    });
    const icon = document.querySelector('svg[role="img"]');
    assert.ok(icon, 'the icon is painted');
    assert.match(icon.getAttribute('class') ?? '', /lucide-brain/);
    assert.ok(icon.getAttribute('aria-label'), 'the icon is named for screen readers');
    assert.match(document.getElementById('root')!.textContent ?? '', /high/);
  } finally {
    await React.act(async () => { root.unmount(); });
  }
});
