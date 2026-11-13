/**
 * The backend stdout parsers kept every byte of a line that never ended in a
 * newline: one runaway tool output or a binary dump grew the daemon heap
 * without bound, since `buf` was only trimmed when a '\n' arrived.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLineSplitter } from './line-splitter.js';

function collect(maxLineChars: number) {
  const lines: string[] = [];
  let overflows = 0;
  const push = createLineSplitter((l) => lines.push(l), { maxLineChars, onOverflow: () => { overflows += 1; } });
  return { push, lines, overflows: () => overflows };
}

test('splits lines across chunks, strips \\r, skips blank lines', () => {
  const c = collect(1024);
  c.push('{"a":1}\r\n{"b"');
  c.push(':2}\n\n  \n{"c":3}');
  assert.deepEqual(c.lines, ['{"a":1}', '{"b":2}']);
  c.push('\n');
  assert.deepEqual(c.lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
  assert.equal(c.overflows(), 0);
});

test('a line that never ends is dropped once past the cap, not buffered forever', () => {
  const c = collect(100);
  for (let i = 0; i < 50; i++) c.push('x'.repeat(40));
  assert.equal(c.overflows(), 1, 'one overflow per runaway line, not one per chunk');
  assert.deepEqual(c.lines, []);
});

test('the stream resumes at the next newline after an overflow', () => {
  const c = collect(100);
  c.push('y'.repeat(150));
  c.push('y'.repeat(150));
  c.push('tail of the runaway\n{"ok":true}\n{"next":1}');
  assert.deepEqual(c.lines, ['{"ok":true}']);
  c.push('\n');
  assert.deepEqual(c.lines, ['{"ok":true}', '{"next":1}']);
  assert.equal(c.overflows(), 1);
});

test('a complete line longer than the cap in a single chunk is dropped too', () => {
  const c = collect(100);
  c.push(`${'z'.repeat(500)}\n{"ok":1}\n`);
  assert.deepEqual(c.lines, ['{"ok":1}']);
  assert.equal(c.overflows(), 1);
});

test('lines at exactly the cap pass', () => {
  const c = collect(100);
  c.push(`${'a'.repeat(100)}\n`);
  assert.equal(c.lines.length, 1);
  assert.equal(c.overflows(), 0);
});
