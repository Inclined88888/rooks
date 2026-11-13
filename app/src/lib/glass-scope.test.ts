import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_GLASS_SCOPE, readGlassScope, resolveGlassScope } from './glass-scope';

test('the account default is the whole island', () => {
  assert.equal(DEFAULT_GLASS_SCOPE, 'island');
});

test('a stored scope is read without trust', () => {
  assert.equal(readGlassScope('island'), 'island');
  assert.equal(readGlassScope('widgets'), 'widgets');
  for (const raw of [undefined, null, '', 'Widgets', 'cards', 1, {}]) assert.equal(readGlassScope(raw), null);
});

test('an island\'s own choice wins over the default; none follows it', () => {
  assert.equal(resolveGlassScope('island', 'widgets'), 'widgets');
  assert.equal(resolveGlassScope('widgets', 'island'), 'island');
  assert.equal(resolveGlassScope('widgets', null), 'widgets');
  assert.equal(resolveGlassScope('island', undefined), 'island');
});
