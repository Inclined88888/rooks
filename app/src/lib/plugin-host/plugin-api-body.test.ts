import assert from 'node:assert/strict';
import test from 'node:test';
import { typedBinaryInit } from './plugin-api-body';

const typeOf = (init: RequestInit | undefined): string | null => new Headers(init?.headers).get('content-type');

test('an untyped buffer, view or Blob goes out as application/octet-stream', () => {
  for (const body of [new ArrayBuffer(4), new Uint8Array(4), new DataView(new ArrayBuffer(2)), new Blob([new Uint8Array(3)])]) {
    assert.equal(typeOf(typedBinaryInit({ method: 'POST', body })), 'application/octet-stream');
  }
});

test('a typed File or Blob keeps its own type', () => {
  const file = new File([new Uint8Array(3)], 'agents.zip', { type: 'application/zip' });
  const init = { method: 'POST', body: file };
  assert.equal(typedBinaryInit(init), init);
});

test('a type the plugin set is never replaced', () => {
  const init = { method: 'POST', body: new Uint8Array(2), headers: { 'Content-Type': 'application/zip' } };
  assert.equal(typedBinaryInit(init), init);
});

test('no body, a string or a form is left alone', () => {
  assert.equal(typedBinaryInit(undefined), undefined);
  for (const init of [{ method: 'POST' }, { method: 'PUT', body: '{"a":1}' }, { method: 'POST', body: new URLSearchParams('a=1') }]) {
    assert.equal(typedBinaryInit(init), init);
  }
});

test('the other headers of the call are kept', () => {
  const out = typedBinaryInit({ method: 'POST', body: new ArrayBuffer(1), headers: { 'x-trace': '7' } });
  assert.equal(new Headers(out?.headers).get('x-trace'), '7');
  assert.equal(typeOf(out), 'application/octet-stream');
});
