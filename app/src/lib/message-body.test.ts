import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { isLongFieldSet, parseMessageBody } from './message-body';

test('free text stays free text, nothing tabulated', () => {
  const r = parseMessageBody('hello\nworld');
  assert.equal(r.text, 'hello\nworld');
  assert.equal(r.textKey, null);
  assert.deepEqual(r.fields, []);
  assert.equal(r.json, null);
  assert.equal(r.raw, 'hello\nworld');
});

test('invalid JSON that starts with a brace is shown raw, never throws', () => {
  const r = parseMessageBody('{not json');
  assert.equal(r.text, '{not json');
  assert.equal(r.json, null);
});

test('JSON arrays and scalars are not objects: raw text', () => {
  assert.equal(parseMessageBody('[1,2]').json, null);
  assert.equal(parseMessageBody('42').text, '42');
});

test('daemon notification: body is the prose, the rest is fields', () => {
  const r = parseMessageBody(JSON.stringify({ kind: 'wake_recap', title: 'T', body: '# Recap\n- a', task_id: 'x' }));
  assert.equal(r.text, '# Recap\n- a');
  assert.equal(r.textKey, 'body');
  assert.deepEqual(r.fields.map(([k]) => k), ['kind', 'title', 'task_id']);
  assert.ok(r.raw.includes('\n  "kind"'));
});

test('task return: done_comment is the prose; blocked_reason when there is no comment', () => {
  const done = parseMessageBody(JSON.stringify({ kind: 'task_closed', done_comment: 'merged', blocked_reason: null }));
  assert.equal(done.text, 'merged');
  const blocked = parseMessageBody(JSON.stringify({ kind: 'task_closed', done_comment: null, blocked_reason: 'conflict' }));
  assert.equal(blocked.text, 'conflict');
  assert.equal(blocked.textKey, 'blocked_reason');
});

test('agent-to-agent JSON with text/message', () => {
  assert.equal(parseMessageBody('{"text":"hi","priority":2}').text, 'hi');
  assert.equal(parseMessageBody('{"message":"yo"}').textKey, 'message');
});

test('no text-bearing field: text is null and every field is tabulated', () => {
  const r = parseMessageBody('{"a":1,"body":"   "}');
  assert.equal(r.text, null);
  assert.deepEqual(r.fields, [['a', 1], ['body', '   ']]);
});

test('long field sets collapse: many keys, nested values, or lots of text', () => {
  assert.equal(isLongFieldSet([['a', 1], ['b', 'x']]), false);
  assert.equal(isLongFieldSet([['a', { nested: true }]]), true);
  assert.equal(isLongFieldSet([['a', 'x'.repeat(500)]]), true);
  assert.equal(isLongFieldSet(Array.from({ length: 7 }, (_, i) => [`k${i}`, i] as [string, unknown])), true);
});
