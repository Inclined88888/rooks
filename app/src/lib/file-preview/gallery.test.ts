import { test } from 'node:test';
import assert from 'node:assert/strict';
import { galleryPosition, imagePathsIn, neighbourImage } from './gallery';

const entries = [
  { name: 'a.png', kind: 'file' },
  { name: 'notes.md', kind: 'file' },
  { name: 'b.JPG', kind: 'file' },
  { name: 'clip.mp4', kind: 'file' },
  { name: 'shots.png', kind: 'dir' },
  { name: 'logo.svg', kind: 'file' },
  { name: 'c.webp', kind: 'symlink' },
];

test('only the images of the folder are kept, in listing order', () => {
  assert.deepEqual(imagePathsIn('', entries), ['a.png', 'b.JPG', 'c.webp']);
  assert.deepEqual(imagePathsIn('pics/2026', entries), ['pics/2026/a.png', 'pics/2026/b.JPG', 'pics/2026/c.webp']);
});

test('a folder not listed yet has no gallery', () => {
  assert.deepEqual(imagePathsIn('x', undefined), []);
});

test('the gallery stops at both ends instead of wrapping', () => {
  const paths = ['a.png', 'b.png', 'c.png'];
  assert.equal(neighbourImage(paths, 'b.png', 1), 'c.png');
  assert.equal(neighbourImage(paths, 'b.png', -1), 'a.png');
  assert.equal(neighbourImage(paths, 'c.png', 1), null);
  assert.equal(neighbourImage(paths, 'a.png', -1), null);
  assert.equal(neighbourImage(paths, 'gone.png', 1), null);
});

test('the counter is 1-based and absent when there is nothing to browse', () => {
  const paths = ['a.png', 'b.png', 'c.png'];
  assert.deepEqual(galleryPosition(paths, 'c.png'), { index: 3, total: 3 });
  assert.equal(galleryPosition(['a.png'], 'a.png'), null);
  assert.equal(galleryPosition(paths, 'gone.png'), null);
});
