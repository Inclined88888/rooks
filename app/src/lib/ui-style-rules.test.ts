import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * UI rules set by the maintainer (08/10/2026, amended 14/10/2026), AGENTS.md rule 16:
 *
 * - **No monospace type** outside code (code blocks, editors, terminals,
 *   command lines). Not for titles, labels, timers, counts or badges:
 *   `tabular-nums` keeps digits steady in the product font.
 * - **No hard horizontal separator lines**: no `divide-y`, no `border-t` /
 *   `border-b` rule between two blocks, no `<hr>`, no `<Separator>`, no element
 *   one pixel tall (`h-px`, `h-[1px]`). Space, grouping and surface contrast
 *   set things apart. Every `h-px` in the tree on 31/10/2026 was a separator
 *   (TODO #744), so that pattern has no exclusion.
 * - **No hard vertical separator lines** between two zones side by side: no
 *   `divide-x`, no `border-l` / `border-r` (nor `border-x`, `border-s`,
 *   `border-e`) drawn between a sidebar and its content, no element one pixel
 *   wide (`w-px`, `w-[1px]`). Split zones are islands on the chrome backdrop
 *   (`.rooks-island`, `.rooks-island-backdrop`, `--rooks-island-gap` in
 *   `styles/globals.css`), the gutter is the divider.
 *
 * The debt frozen in a per-file baseline when the rules came in (446
 * monospace, 113 horizontal, 16 vertical) was paid off on 30/10/2026 (TODO
 * #516), so the ratchet became a ban: no file may hold any of the three.
 *
 * Monospace that IS code carries `code-font: <reason>` on its line or on one
 * of the two lines above. There is no marker for separators.
 *
 * What the vertical count leaves out, because it is not a line between two
 * zones (the check reads one line at a time, so a `cn()` spread over several
 * lines escapes the exclusions as well as the count):
 * - a side's colour or style (`border-l-transparent`, `border-r-primary`):
 *   it only styles a border counted on its own, like the horizontal rule;
 * - an explicit width on the left / start side (`border-l-2`, `border-s-4`):
 *   that is an accent bar on a callout, a quote or a pending item;
 * - a line that also rounds the element (`rounded…`, not `rounded-none`):
 *   the outline of a card, a field or a button, not a rule across the page;
 * - a line that makes the side transparent (`border-l border-l-transparent`,
 *   the scrollbar track): nothing is drawn;
 * - focus-only borders (`focus:` / `focus-visible:` / `focus-within:`), the
 *   job of focus rings;
 * - CSS written as CSS (`border-left: …` in a stylesheet or a `<style>`);
 * - a timeline spine drawn on a `before:` pseudo-element (`before:w-px`): it
 *   threads the items of one list, it does not split two zones;
 * - a `w-px` on a resize handle's line (`cursor-col-resize`): the hairline is
 *   the visible part of a control the user drags (TODO #747).
 * A `rounded` class does not excuse `w-px`: a rounded one-pixel bar is still a
 * bar, and that class may belong to another element of the line.
 * Everything else counts, spines drawn with a border, calendar grid lines and
 * drawer edges included: over-counting only asks for a look at the line,
 * under-counting would let a separator through.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = join(SRC, '..', '..', 'examples');

type Kind = 'mono' | 'separator' | 'vseparator';
const KINDS = ['mono', 'separator', 'vseparator'] as const;
type Offences = Record<Kind, Record<string, number>>;

const PATTERNS: Record<Kind, RegExp[]> = {
  mono: [/\bfont-mono\b/g, /monospace/g],
  separator: [
    /\bdivide-y\b/g,
    // `border-t` / `border-b` alone or with a width; a colour such as
    // `border-t-transparent` only styles a rule counted on its own.
    /\bborder-[tb](?![-\w])/g,
    /\bborder-[tb]-[0-9]\b/g,
    /<hr\b/g,
    /<(?:DropdownMenu)?Separator\b/g,
    /\b(?:DropdownMenuSeparator|Separator)\)/g,
    // `min-h-px` and `max-h-px` bound a size, they draw nothing.
    /(?<![-\w])h-(?:px\b|\[1px\])/g,
  ],
  vseparator: [
    /\bdivide-x(?![-\w])/g,
    /\bdivide-x-[0-9]\b/g,
    /(?<![-\w]|focus:|focus-visible:|focus-within:)border-[lrxse](?![-\w])/g,
    // An explicit width on the right / both sides is still a rule; on the
    // left / start side it is an accent bar (see the exclusions above).
    /(?<![-\w]|focus:|focus-visible:|focus-within:)border-[rxe]-[0-9]\b/g,
  ],
};

// A line matching this draws no separator between two zones.
const NOT_A_ZONE_RULE = /\brounded(?:(?![-\w])|-(?![\w-]*none\b))|\bborder-[lrxse]-transparent\b/;

// `min-w-px` and `max-w-px` bound a size, they draw nothing.
const ONE_PIXEL_WIDE = /(?<![-\w]|before:)w-(?:px\b|\[1px\])/g;
const RESIZE_HANDLE = /\bcursor-col-resize\b/;

function sourceFiles(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path, ext);
    return ext.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function key(path: string): string {
  return relative(join(SRC, '..', '..'), path).split(sep).join('/');
}

function count(text: string, kind: Kind): number {
  const lines = text.split('\n');
  let total = 0;
  lines.forEach((line, i) => {
    if (kind === 'mono' && lines.slice(Math.max(0, i - 2), i + 1).some((l) => l.includes('code-font:'))) return;
    if (kind === 'vseparator' && !RESIZE_HANDLE.test(line)) total += line.match(ONE_PIXEL_WIDE)?.length ?? 0;
    if (kind === 'vseparator' && NOT_A_ZONE_RULE.test(line)) return;
    for (const pattern of PATTERNS[kind]) total += line.match(pattern)?.length ?? 0;
  });
  return total;
}

function scan(): Offences {
  const files = [...sourceFiles(SRC, /\.tsx?$/), ...sourceFiles(EXAMPLES, /\.(?:m?js|tsx?)$/)];
  const out: Offences = { mono: {}, separator: {}, vseparator: {} };
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const kind of KINDS) {
      const n = count(text, kind);
      if (n > 0) out[kind][key(file)] = n;
    }
  }
  return out;
}

test('no monospace type outside code, no hard separator line', () => {
  const now = scan();
  const offenders = KINDS.flatMap((kind) => Object.entries(now[kind]).map(([file, n]) => `${file}: ${kind} ${n}`));
  assert.deepEqual(
    offenders,
    [],
    'AGENTS.md rule 16: monospace only for code (mark it `code-font: <reason>`), no horizontal separator lines, and no vertical ones: zones side by side are islands (`.rooks-island` on `.rooks-island-backdrop`, styles/globals.css).',
  );
});

test('the rule catches what it is meant to catch', () => {
  assert.equal(count('<p className="font-mono text-xs">13m12s</p>', 'mono'), 1);
  assert.equal(count('// code-font: shell command\n<code className="font-mono">', 'mono'), 0);
  assert.equal(count('<ul className="divide-y divide-border">', 'separator'), 1);
  assert.equal(count('<div className="border-t border-border p-1">', 'separator'), 1);
  assert.equal(count('<div className="border-b-2 border-t-transparent">', 'separator'), 1);
  assert.equal(count('<div className="border border-border rounded-xl">', 'separator'), 0);
  assert.equal(count('h(DropdownMenuSeparator)', 'separator'), 1);
  // A one-pixel-tall element is the same line, under any spelling.
  assert.equal(count('<span className="h-px flex-1 bg-border/60" />', 'separator'), 1);
  assert.equal(count('<Dropdown.Separator className="my-1 h-px bg-border" />', 'separator'), 1);
  assert.equal(count('<div className="after:h-px after:bg-border">', 'separator'), 1);
  assert.equal(count('"h-[1px] w-full"', 'separator'), 1);
  assert.equal(count('<div className="min-h-px max-h-px">', 'separator'), 0);
  assert.equal(count('<div className="h-2 w-px">', 'separator'), 0);

  assert.equal(count('<div className="flex divide-x divide-border">', 'vseparator'), 1);
  assert.equal(count('<aside className="w-56 border-r border-border bg-card">', 'vseparator'), 1);
  assert.equal(count('<aside className="md:w-72 md:border-r">', 'vseparator'), 1);
  assert.equal(count('<td className="border-x-2">', 'vseparator'), 1);
  // A side's colour only styles a border counted on its own.
  assert.equal(count('<div className="border-l-primary border-r-sky-500">', 'vseparator'), 0);
  // An accent bar on the left / start side.
  assert.equal(count('<blockquote className="border-l-4 pl-3">', 'vseparator'), 0);
  // The outline of a rounded card, field or button.
  assert.equal(count('<div className="rounded-md border border-l-4">', 'vseparator'), 0);
  assert.equal(count('<div className="rounded-b-xl border-x border-b">', 'vseparator'), 0);
  assert.equal(count('<aside className="rounded-none border-r">', 'vseparator'), 1);
  // A transparent side draws nothing (scrollbar track).
  assert.equal(count('"h-full w-2.5 border-l border-l-transparent p-[1px]"', 'vseparator'), 0);
  // Focus is the focus ring's job.
  assert.equal(count('<input className="focus-visible:border-l">', 'vseparator'), 0);
  // CSS written as CSS is not a utility class.
  assert.equal(count('border-left: 2px solid hsl(var(--border));', 'vseparator'), 0);
  // A one-pixel-wide element is the same line, under any spelling.
  assert.equal(count('<span className="h-3 w-px bg-border" />', 'vseparator'), 1);
  assert.equal(count('"h-4 w-[1px] shrink-0"', 'vseparator'), 1);
  assert.equal(count('<div className="after:w-px after:bg-border">', 'vseparator'), 1);
  assert.equal(count('<span className="h-4 w-px rounded-full bg-border" />', 'vseparator'), 1);
  assert.equal(count('<div className="rounded-xl"><span className="h-4 w-px bg-border" /></div>', 'vseparator'), 1);
  assert.equal(count('<div className="min-w-px max-w-px">', 'vseparator'), 0);
  // A timeline spine and the hairline of a resize handle split no zones.
  assert.equal(count('<ol className="relative before:absolute before:w-px before:bg-border">', 'vseparator'), 0);
  assert.equal(count('<div className="cursor-col-resize after:absolute after:w-px">', 'vseparator'), 0);
});
