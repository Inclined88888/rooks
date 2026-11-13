#!/usr/bin/env node
/**
 * Generates `app/src/lib/emoji-data.ts` from the Unicode `emoji-test.txt`.
 *
 * The emoji picker needs a full, categorized, searchable list. Rather than
 * pulling an npm package into the distributed product for what is static data
 * (rule 7 of AGENTS.md), the list is generated once from the upstream file and
 * committed. Re-run after a Unicode release:
 *
 *   node scripts/gen-emoji-data.mjs [path-or-url-to-emoji-test.txt]
 *
 * Skin-tone variants are dropped: they multiply the list by six for a picker
 * that stores a single character.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DEFAULT_SOURCE = 'https://www.unicode.org/Public/emoji/15.1/emoji-test.txt';
const source = process.argv[2] ?? DEFAULT_SOURCE;

const text = /^https?:\/\//.test(source)
  ? await (await fetch(source)).text()
  : readFileSync(source, 'utf8');

/** Groups we never show: `Component` holds skin tones and hair styles alone. */
const SKIPPED_GROUPS = new Set(['Component']);

const groups = [];
let group = null;
let subgroup = '';
for (const line of text.split('\n')) {
  const groupMatch = /^# group: (.+)$/.exec(line);
  if (groupMatch) {
    group = SKIPPED_GROUPS.has(groupMatch[1]) ? null : { name: groupMatch[1], emojis: [] };
    if (group) groups.push(group);
    continue;
  }
  const subgroupMatch = /^# subgroup: (.+)$/.exec(line);
  if (subgroupMatch) {
    subgroup = subgroupMatch[1].replace(/-/g, ' ');
    continue;
  }
  if (!group || line.startsWith('#') || !line.trim()) continue;
  const entry = /^[0-9A-F ]+;\s*fully-qualified\s*#\s*(\S+)\s+E\d+\.\d+\s+(.+)$/.exec(line);
  if (!entry) continue;
  const [, char, name] = entry;
  if (name.includes('skin tone')) continue;
  group.emojis.push({ char, name, subgroup });
}

// The picker searches on words, so the subgroup is folded into the keywords
// instead of being kept as a third level of navigation nobody scrolls.
const serialized = groups.map((g) => ({
  name: g.name,
  emojis: g.emojis.map((e) => [
    e.char,
    e.name,
    Array.from(new Set(e.subgroup.split(' ').filter((w) => !e.name.includes(w)))).join(' '),
  ]),
}));

const total = serialized.reduce((n, g) => n + g.emojis.length, 0);
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'app', 'src', 'lib', 'emoji-data.ts');

writeFileSync(
  out,
  `/**
 * Unicode emoji list, generated — do not edit by hand.
 *
 * Source: ${source}
 * Regenerate with \`node scripts/gen-emoji-data.mjs\`.
 *
 * Each entry is \`[character, name, extra search keywords]\`; the tuple form
 * keeps the file three times smaller than named fields for ${total} entries,
 * and this module is only ever loaded through a dynamic import.
 */

export type EmojiEntry = readonly [char: string, name: string, keywords: string];

export type EmojiGroup = { readonly name: string; readonly emojis: readonly EmojiEntry[] };

export const EMOJI_GROUPS: readonly EmojiGroup[] = ${JSON.stringify(serialized, null, 0)
    .replace(/\{"name":/g, '\n{ name: ')
    .replace(/,"emojis":/g, ', emojis: ')} as const;
`,
  'utf8',
);
console.log(`${out}: ${total} emojis in ${serialized.length} groups`);
