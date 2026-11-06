/**
 * Newline-delimited reader for a backend's stdout, with a ceiling on how much
 * of an unfinished line it keeps. A tool dumping a huge blob without a '\n'
 * would otherwise grow the buffer until the daemon runs out of heap, taking
 * every live mission with it. A line past the cap is dropped whole, up to its
 * terminating newline, and `onOverflow` fires once for it.
 */

/** Same ceiling as the ACP transport: far above any real stream-json line
 *  (a base64 screenshot is a few MiB), far below a heap-killing one. */
export const DEFAULT_MAX_LINE_CHARS = 16 * 1024 * 1024;

export type LineSplitterOptions = {
  maxLineChars?: number;
  onOverflow?: () => void;
};

export function createLineSplitter(
  onLine: (line: string) => void,
  opts: LineSplitterOptions = {},
): (chunk: string) => void {
  const max = opts.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  let buf = '';
  // Inside the tail of a line that already overflowed: skip up to its newline.
  let discarding = false;
  return (chunk) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const raw = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (discarding) { discarding = false; continue; }
      if (raw.length > max) { opts.onOverflow?.(); continue; }
      const line = raw.replace(/\r$/, '');
      if (!line.trim()) continue;
      onLine(line);
    }
    if (buf.length > max) {
      buf = '';
      if (!discarding) {
        discarding = true;
        opts.onOverflow?.();
      }
    }
  };
}
