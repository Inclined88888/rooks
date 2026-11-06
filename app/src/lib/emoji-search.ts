/**
 * Search over the generated emoji list — kept out of the picker component so
 * it can be tested without a DOM.
 */

import type { EmojiEntry, EmojiGroup } from '@/lib/emoji-data';

/** Unicode group name → i18n key suffix. The group names are not display text. */
export const EMOJI_GROUP_KEYS: Record<string, string> = {
  'Smileys & Emotion': 'smileys',
  'People & Body': 'people',
  'Animals & Nature': 'nature',
  'Food & Drink': 'food',
  'Travel & Places': 'travel',
  Activities: 'activities',
  Objects: 'objects',
  Symbols: 'symbols',
  Flags: 'flags',
};

/** One representative face per group, used as the category tab. */
export const EMOJI_GROUP_TABS: Record<string, string> = {
  'Smileys & Emotion': '😀',
  'People & Body': '👋',
  'Animals & Nature': '🐻',
  'Food & Drink': '🍔',
  'Travel & Places': '✈️',
  Activities: '⚽',
  Objects: '💡',
  Symbols: '❤️',
  Flags: '🏳️',
};

/** Results are capped: nobody scrolls past a few hundred faces. */
export const EMOJI_SEARCH_LIMIT = 300;

const HAYSTACKS = new WeakMap<EmojiEntry, string>();

export function tokenizeEmojiQuery(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Every token must appear in the name or the extra keywords, so typing
 * `cat face` narrows instead of widening. Categories are flattened: a search
 * answers "which emoji", not "which category".
 */
export function searchEmojis(
  groups: readonly EmojiGroup[],
  query: string,
  limit = EMOJI_SEARCH_LIMIT,
): EmojiEntry[] {
  const tokens = tokenizeEmojiQuery(query);
  if (tokens.length === 0) return [];
  const found: EmojiEntry[] = [];
  for (const group of groups) {
    for (const entry of group.emojis) {
      // Names carry capitals ("flag: France"); folded once per entry and kept,
      // because this runs on ~1900 entries at every keystroke.
      let haystack = HAYSTACKS.get(entry);
      if (haystack === undefined) {
        haystack = `${entry[1]} ${entry[2]}`.toLowerCase();
        HAYSTACKS.set(entry, haystack);
      }
      if (tokens.every((token) => haystack.includes(token))) found.push(entry);
      if (found.length >= limit) return found;
    }
  }
  return found;
}
