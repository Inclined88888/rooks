import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { formatJson } from './format-json';

test('minified JSON is re-indented, with empty containers kept on one line', () => {
  assert.equal(
    formatJson('{"private":true,"scripts":{"test":"a, b: {c}"},"files":[],"o":{},"n":[1,2]}'),
    '{\n  "private": true,\n  "scripts": {\n    "test": "a, b: {c}"\n  },\n  "files": [],\n  "o": {},\n  "n": [\n    1,\n    2\n  ]\n}',
  );
});

test('strings with escaped quotes and backslashes are copied verbatim', () => {
  const src = '{"a":"x\\"y\\\\","b":1}';
  assert.equal(formatJson(src), '{\n  "a": "x\\"y\\\\",\n  "b": 1\n}');
});

test('numbers are not rewritten, and invalid JSON comes back untouched', () => {
  assert.ok(formatJson('{"n":12345678901234567890}').includes('12345678901234567890'));
  assert.equal(formatJson('{"a":1,}'), '{"a":1,}');
  assert.equal(formatJson('// c\n{"a":1}'), '// c\n{"a":1}');
  assert.equal(formatJson('[1,2]'), '[\n  1,\n  2\n]');
});
