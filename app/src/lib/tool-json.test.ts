import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToolJson, tryRenderToolJson } from './tool-json';

test('JSON tables retain nested paths, empty containers and primitive values', () => {
  const html = renderToolJson({ users: [{ name: 'Robin', active: false }], empty: [], nil: null });
  assert.match(html, /<th scope="row">users\[0\].name<\/th>/);
  for (const value of ['Robin', 'false', '[]', 'null']) assert.ok(html.includes(`<td>${value}</td>`));
  assert.match(html, /data-copy=/);
});
test('keys and values are escaped and non-JSON stays outside the table renderer', () => {
  assert.doesNotMatch(renderToolJson({ '<script>': '<img onerror=alert(1)>' }), /<script>|<img/);
  assert.equal(tryRenderToolJson('ordinary output'), null);
  assert.match(tryRenderToolJson('[]')!, /<td>\[\]<\/td>/);
  assert.match(tryRenderToolJson('false')!, /<td>false<\/td>/);
});
test('a JSON payload carried inside a string is walked, not dumped raw', () => {
  const html = renderToolJson({ content: '{"results":[{"server":"timon"}]}', note: 'not json {' });
  assert.match(html, /<th scope="row">content.results\[0\].server<\/th><td>timon<\/td>/);
  assert.match(html, /<th scope="row">note<\/th><td>not json \{<\/td>/);
});
test('keys that are not identifiers keep their bracketed form', () => {
  assert.match(renderToolJson({ 'odd key': 1 }), /<th scope="row">\[&quot;odd key&quot;\]<\/th>/);
});
test('a deep path is elided in the middle, full value kept in the title', () => {
  const html = renderToolJson({ content: { results: [{ tools: [{ tool_name: 'x' }] }] } });
  assert.match(html, /<th scope="row" title="content\.results\[0\]\.tools\[0\]\.tool_name">content\.result…\[0\]\.tool_name<\/th>/);
});
