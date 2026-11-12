/**
 * An imported skill is text for an agent to read. `allowed-tools` in its front
 * matter would pre-authorise tools for every agent that loads it, which an
 * import never decides: the key is removed (with what it lists), and the
 * daemon refuses the skill anyway if one is left. Only the front matter is
 * touched, unless no closing fence can be found: then every line that reads
 * like the key goes, as the daemon's own check reads the whole text.
 */

const KEY_RE = /^\s*allowed[-_]tools\s*:/i;
/** A line that continues the previous key: indented, or a list item. */
const CONTINUATION_RE = /^(\s+\S|\s*-\s)/;

function dropKey(lines: string[]): { lines: string[]; removed: boolean } {
  const out: string[] = [];
  let removed = false;
  let skipping = false;
  for (const line of lines) {
    if (KEY_RE.test(line)) {
      removed = true;
      skipping = true;
      continue;
    }
    if (skipping && CONTINUATION_RE.test(line)) continue;
    skipping = false;
    out.push(line);
  }
  return { lines: out, removed };
}

export function stripAllowedTools(content: string): { content: string; removed: boolean } {
  if (!/^\s*---/.test(content)) return { content, removed: false };
  const lines = content.split(/\r?\n/);
  const open = lines.findIndex((line) => line.trim() === '---');
  const close = open < 0 ? -1 : lines.findIndex((line, i) => i > open && line.trim() === '---');
  if (open < 0 || close < 0) {
    const all = dropKey(lines);
    return { content: all.lines.join('\n'), removed: all.removed };
  }
  const head = dropKey(lines.slice(open + 1, close));
  // A second block right after the first is read as front matter by one of the parsers.
  const rest = lines.slice(close);
  const tail = dropKey(rest.slice(1));
  const removed = head.removed || tail.removed;
  if (!removed) return { content, removed: false };
  return { content: [...lines.slice(0, open + 1), ...head.lines, rest[0]!, ...tail.lines].join('\n'), removed };
}
