import assert from 'node:assert/strict';
import test from 'node:test';
import { createStreamingMarkdownRenderer, loadHighlighter } from './markdown';

test('headings, lists, emphasis and tables render before the message is finished', () => {
  const render = createStreamingMarkdownRenderer();
  assert.match(render('# Heading\n')[0]!.html, /<h1>Heading<\/h1>/);
  const blocks = render('# Heading\n\n- **One**\n- Two\n\n| A | B |\n|---|---|\n|1|2|');
  assert.match(blocks[1]!.html, /<ul>/);
  assert.match(blocks[1]!.html, /<strong>One<\/strong>/);
  assert.equal(blocks[2]!.table, true);
  assert.match(blocks[2]!.html, /<table>/);
  assert.doesNotMatch(blocks[2]!.html, /markdown-table-scroll/, 'React owns the persistent scroll container');
});

test('completed blocks retain object identity while the trailing block grows', () => {
  const render = createStreamingMarkdownRenderer();
  const first = render('# Stable\n\nGrowing');
  const second = render('# Stable\n\nGrowing paragraph');
  assert.equal(second[0], first[0]);
  assert.notEqual(second[1], first[1]);
  assert.equal(second[1]!.key, first[1]!.key);
});

test('late reference definitions invalidate cached links', () => {
  const render = createStreamingMarkdownRenderer();
  const first = render('[Guide][docs]\n\nWaiting');
  const second = render('[Guide][docs]\n\nWaiting\n\n[docs]: https://example.test/guide');
  assert.notEqual(first[0], second[0]);
  assert.match(second[0]!.html, /href="https:\/\/example.test\/guide"/);
  assert.match(second[0]!.html, /url-copy/);
});

test('open code fences render as safe code without repeatedly highlighting partial syntax', async () => {
  await loadHighlighter();
  const render = createStreamingMarkdownRenderer();
  const pending = render('```html\n<script>alert(1)</script>');
  assert.match(pending[0]!.html, /<pre><code>/);
  assert.match(pending[0]!.html, /&lt;script&gt;/);
  assert.doesNotMatch(pending[0]!.html, /<script>|hljs-/);
  const complete = render('```html\n<div>Hello</div>\n```');
  assert.match(complete[0]!.html, /hljs-/);
});

test('every incremental prefix stays safe and replacements do not retain old blocks', () => {
  const render = createStreamingMarkdownRenderer();
  const text = '# Title\n\n<a href="javascript:alert(1)">Bad</a><script>alert(1)</script>\n\n**Bold**';
  for (let i = 1; i <= text.length; i++) {
    const html = render(text.slice(0, i)).map((b) => b.html).join('');
    assert.doesNotMatch(html, /<script\b|<a\b[^>]*\bhref="javascript:/i);
  }
  const replacement = render('New answer');
  assert.equal(replacement.length, 1);
  assert.match(replacement[0]!.html, /New answer/);
  assert.doesNotMatch(replacement[0]!.html, /Title|Bold/);
});
