import test from 'node:test';
import assert from 'node:assert/strict';

import { EMOJI_GROUPS } from './emoji-data';
import {
  EMOJI_GROUP_KEYS,
  EMOJI_GROUP_TABS,
  searchEmojis,
  tokenizeEmojiQuery,
} from './emoji-search';

test('the generated list covers every Unicode group with entries', () => {
  assert.ok(EMOJI_GROUPS.length >= 9);
  for (const group of EMOJI_GROUPS) {
    assert.ok(group.emojis.length > 0, `${group.name} is empty`);
  }
  const total = EMOJI_GROUPS.reduce((n, g) => n + g.emojis.length, 0);
  assert.ok(total > 1500, `only ${total} emojis`);
});

test('every group has a label key and a tab face', () => {
  for (const group of EMOJI_GROUPS) {
    assert.ok(EMOJI_GROUP_KEYS[group.name], `no i18n key for ${group.name}`);
    assert.ok(EMOJI_GROUP_TABS[group.name], `no tab face for ${group.name}`);
  }
});

test('skin-tone variants are excluded — one entry per emoji', () => {
  const chars = new Set<string>();
  for (const group of EMOJI_GROUPS) {
    for (const [char, name] of group.emojis) {
      assert.ok(!name.includes('skin tone'), name);
      assert.ok(!chars.has(char), `duplicate ${char}`);
      chars.add(char);
    }
  }
});

test('search matches names', () => {
  const found = searchEmojis(EMOJI_GROUPS, 'rocket');
  assert.ok(found.some(([char]) => char === '🚀'));
});

test('search matches the folded subgroup keywords', () => {
  // "cat" is a subgroup word, not part of "grinning cat" for every face.
  assert.ok(searchEmojis(EMOJI_GROUPS, 'flag france').some(([char]) => char === '🇫🇷'));
});

test('every token must match — extra words narrow the result', () => {
  const wide = searchEmojis(EMOJI_GROUPS, 'face');
  const narrow = searchEmojis(EMOJI_GROUPS, 'face tears');
  assert.ok(narrow.length > 0);
  assert.ok(narrow.length < wide.length);
});

test('search is case-insensitive and tolerates padding', () => {
  const a = searchEmojis(EMOJI_GROUPS, '  ROCKET ');
  const b = searchEmojis(EMOJI_GROUPS, 'rocket');
  assert.deepEqual(a, b);
});

test('an empty query yields nothing rather than everything', () => {
  assert.deepEqual(tokenizeEmojiQuery('   '), []);
  assert.deepEqual(searchEmojis(EMOJI_GROUPS, '   '), []);
});

test('results are capped at the limit', () => {
  assert.equal(searchEmojis(EMOJI_GROUPS, 'a', 10).length, 10);
});
