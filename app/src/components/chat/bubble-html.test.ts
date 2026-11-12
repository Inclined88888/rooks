/**
 * A bubble's HTML is built when it is drawn, not when the thread is replayed:
 * the same HTML as before, one conversion per drawn message, none for the
 * messages above the mounted window, and a redraw once the highlight.js
 * grammars land after a replay.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentTextHtml, createMarkdownHtmlCache, createObjectHtmlCache, type HighlighterSource } from './bubble-html';
import { currentHighlighterVersion, loadHighlighter, mdToSafeHtml } from '@/lib/markdown';
import { THREAD_WINDOW, threadWindowStart } from '@/lib/thread-window';

const SAMPLES = [
  'Plain **bold** and `code`, a [link](https://example.test/a).',
  '## Steps\n\n1. one\n2. two\n\n| A | B |\n|---|---|\n| 1 | 2 |',
  '```ts\nconst answer: number = 42;\n```',
  '<img src=x onerror=alert(1)> stays inert',
];

test('the HTML is the one the replay used to store: each block through the same pipe, concatenated', async () => {
  await loadHighlighter();
  const before = SAMPLES.map((md) => mdToSafeHtml(md, { copyLinks: true })).join('');
  assert.equal(agentTextHtml(SAMPLES, currentHighlighterVersion()), before);
  // From the cache this time: still identical.
  assert.equal(agentTextHtml(SAMPLES, currentHighlighterVersion()), before);
  assert.match(before, /hljs-/, 'the code block is coloured once the grammars are in');
});

test('a block is converted once per highlighter version, and the cache stays bounded', () => {
  const seen: string[] = [];
  const render = createMarkdownHtmlCache((md) => { seen.push(md); return `<p>${md}</p>`; }, 3);
  assert.equal(render(['a', 'b'], 1), '<p>a</p><p>b</p>');
  assert.equal(render(['a', 'b', 'c'], 1), '<p>a</p><p>b</p><p>c</p>');
  assert.deepEqual(seen, ['a', 'b', 'c'], 'a bubble growing by one block converts that block only');
  render(['a'], 2);
  assert.deepEqual(seen, ['a', 'b', 'c', 'a'], 'the grammars landed: converted again');
  // Size 3: `a@1`, least recently used, went out when `a@2` came in.
  render(['b', 'c'], 1);
  assert.equal(seen.length, 4, '`b` and `c` are still cached');
  render(['a'], 1);
  assert.deepEqual(seen.slice(4), ['a']);
});

test('a tool call renders once per object: a result landing elsewhere in the bubble re-renders nothing', () => {
  let renders = 0;
  const view = createObjectHtmlCache((tool: { id: string }) => { renders += 1; return `<p>${tool.id}</p>`; });
  const first = { id: 'one' };
  const second = { id: 'two' };
  view(first, 1); view(second, 1);
  view(first, 1); view({ ...second }, 1);
  assert.equal(renders, 3);
  view(first, 2);
  assert.equal(renders, 4, 'a new highlighter version redraws it');
});

async function mountDom() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, v: unknown) => Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { useAgentTextHtml } = await import('./bubble-html');
  const root = createRoot(document.getElementById('root')!);
  const close = async () => { await React.act(async () => { root.unmount(); }); dom.window.close(); };
  return { React, root, useAgentTextHtml, close };
}

/** Stands in for `lib/markdown`'s grammar load, which a test cannot replay. */
function fakeHighlighter() {
  let version = 0;
  const listeners = new Set<() => void>();
  const source: HighlighterSource = {
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    version: () => version,
  };
  return { source, land: () => { version += 1; for (const listener of listeners) listener(); } };
}

test('a replayed thread converts the mounted window only, once each, and redraws when the grammars land', async () => {
  const { React, root, useAgentTextHtml, close } = await mountDom();
  try {
    const conversions: string[] = [];
    const render = createMarkdownHtmlCache((md) => {
      conversions.push(md);
      return `<p data-v="${highlighter.source.version()}">${md}</p>`;
    });
    const highlighter = fakeHighlighter();
    const thread = Array.from({ length: 150 }, (_, i) => ({ id: `m${i}`, text: [`message ${i}`] }));
    const Bubble = React.memo(function Bubble({ text }: { text: string[] }) {
      const html = useAgentTextHtml(text, render, highlighter.source);
      return React.createElement('div', { className: 'bubble', dangerouslySetInnerHTML: { __html: html } });
    });
    const Thread = ({ messages }: { messages: typeof thread }) => React.createElement(
      React.Fragment, null,
      messages.slice(threadWindowStart(messages, null)).map((m) => React.createElement(Bubble, { key: m.id, text: m.text })),
    );

    await React.act(async () => { root.render(React.createElement(Thread, { messages: thread })); });
    assert.equal(conversions.length, THREAD_WINDOW, 'one conversion per mounted message');
    assert.ok(!conversions.includes('message 0'), 'nothing above the window is converted');
    assert.equal(document.querySelectorAll('.bubble').length, THREAD_WINDOW);
    assert.equal(document.querySelector('.bubble p')!.getAttribute('data-v'), '0');

    // A new message on the live turn: only it is converted.
    const grown = [...thread, { id: 'm150', text: ['message 150'] }];
    await React.act(async () => { root.render(React.createElement(Thread, { messages: grown })); });
    assert.equal(conversions.length, THREAD_WINDOW + 1);

    // The grammars land after the replay: every mounted bubble redraws, coloured.
    await React.act(async () => { highlighter.land(); });
    assert.equal(conversions.length, 2 * THREAD_WINDOW + 1);
    assert.equal(document.querySelector('.bubble p')!.getAttribute('data-v'), '1');
  } finally {
    await close();
  }
});
