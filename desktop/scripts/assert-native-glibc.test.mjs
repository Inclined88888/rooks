import assert from 'node:assert/strict';
import test from 'node:test';
import { glibcVersions, maxGlibc, newerThan } from './assert-native-glibc.mjs';

test('2.31 is allowed and 2.32 is not', () => {
  assert.equal(newerThan('2.31'), false);
  assert.equal(newerThan('2.29'), false);
  assert.equal(newerThan('2.32'), true);
  assert.equal(newerThan('2.42'), true);
  assert.equal(newerThan('3.0'), true);
});

test('the highest GLIBC symbol is the one that must load', () => {
  const dump = 'GLIBC_2.2.5 GLIBC_2.29 GLIBC_2.34 (GLIBC_2.14)';
  assert.deepEqual(glibcVersions(dump), ['2.2.5', '2.29', '2.34', '2.14']);
  assert.equal(maxGlibc(glibcVersions(dump)), '2.34');
  assert.equal(newerThan(maxGlibc(glibcVersions(dump))), true);
});
