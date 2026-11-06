import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_BACKGROUND, readBackground } from '../components/background/background-model';

test('fresh and legacy accounts get the plain shipped backdrop', () => {
  for (const raw of [null, undefined, {}, { variant: 'teal' }]) assert.deepEqual(readBackground(raw), DEFAULT_BACKGROUND);
  // Pinned, not derived: the backdrop of a new install is a product
  // decision, and the weave it replaced was never chosen by anyone.
  assert.equal(DEFAULT_BACKGROUND.pattern, 'none');
  assert.equal(DEFAULT_BACKGROUND.mode, 'pattern');
  assert.equal(DEFAULT_BACKGROUND.photo, null);
});
test('settings survive serialization, including a private local photo', () => {
  const value = { mode: 'photo', photo: '/api/ui/appearance/background-image/abc-123.jpg', colors: { dark: '#112233', light: null }, pattern: 'crosses', intensity: 0.18, veil: 0.72 };
  assert.deepEqual(readBackground(JSON.parse(JSON.stringify(value))), value);
});
test('untrusted settings cannot load a remote image or inject CSS', () => {
  for (const photo of ['https://example.com/photo.jpg', 'data:image/svg+xml,test', '/api/ui/appearance/background-image/../../other.jpg']) {
    const value = readBackground({ mode: 'photo', photo, color: 'red; background:url(https://example.com)', intensity: Infinity, veil: NaN, pattern: 'invalid' });
    assert.deepEqual(value, DEFAULT_BACKGROUND);
  }
});
test('photo removal and out-of-range controls keep a valid backdrop', () => {
  const value = readBackground({ mode: 'photo', photo: null, pattern: 'none', intensity: 100, veil: 0 });
  assert.equal(value.mode, 'pattern');
  assert.equal(value.pattern, 'none');
  assert.equal(value.intensity, 0.65);
  assert.equal(value.veil, 0.1);
});

test('legacy custom colours stay in their matching theme', () => {
  assert.deepEqual(readBackground({ color: '#ffffff' }).colors, { light: '#ffffff', dark: null });
  assert.deepEqual(readBackground({ color: '#112233' }).colors, { light: null, dark: '#112233' });
  assert.deepEqual(readBackground({ color: '#ffffff', colors: { light: null, dark: '#223344' } }).colors, { light: null, dark: '#223344' });
});
test('each theme keeps its own validated colour', () => {
  assert.deepEqual(readBackground({ colors: { light: '#fefefe', dark: '#181818' } }).colors, { light: '#fefefe', dark: '#181818' });
  assert.deepEqual(readBackground({ colors: { light: 'url(bad)', dark: 42 } }).colors, { light: null, dark: null });
});
