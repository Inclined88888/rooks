import { copyButtonHtml } from './markdown';

const escape = (value: string) => value.replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** A path segment renders as `key`, `.key`, `["odd key"]` or `[0]` — the
 *  dotted form a developer would type, not the bracketed dump of every
 *  key. First segment carries no leading dot. */
function joinPath(base: string, key: string, isArray: boolean) {
  if (isArray) return base + `[${key}]`;
  if (/^[A-Za-z_$][\w$]*$/.test(key)) return base ? `${base}.${key}` : key;
  return base + `[${JSON.stringify(key)}]`;
}

/** Tool payloads routinely carry JSON *inside* a string (an MCP result's
 *  `content`, a stdout capture…). Rendering it as one opaque blob defeats
 *  the whole table, so a string that parses into a container is walked
 *  like any other node. */
function embeddedJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (trimmed.length < 2) return undefined;
  const first = trimmed[0];
  if (first !== '{' && first !== '[') return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The key column is set `nowrap` — a wrapped path breaks mid-word and
 *  becomes unreadable — so a deep path is elided in its middle instead of
 *  widening the column indefinitely. The full path stays in `title`. */
function elidePath(path: string, max = 30) {
  if (path.length <= max) return path;
  const tail = path.slice(-Math.max(8, Math.floor(max / 2)));
  const cut = tail.search(/[.[]/);
  return path.slice(0, max - tail.length - 1) + '…' + (cut > 0 ? tail.slice(cut) : tail);
}

/** Flatten JSON leaves into readable paths without changing the original copy payload. */
export function renderToolJson(value: unknown): string {
  const rows: string[] = [];
  const visit = (item: unknown, path: string, depth: number) => {
    let node = item;
    if (typeof node === 'string' && depth < 12) {
      const inner = embeddedJson(node);
      if (inner !== undefined) node = inner;
    }
    const entries = node !== null && typeof node === 'object' ? Object.entries(node) : [];
    if (entries.length && depth < 12) {
      const isArray = Array.isArray(node);
      for (const [key, child] of entries) visit(child, joinPath(path, key, isArray), depth + 1);
      return;
    }
    const text = typeof node === 'string' ? (node || '""') : JSON.stringify(node) ?? 'null';
    const full = path || '$';
    const short = elidePath(full);
    const title = short === full ? '' : ` title="${escape(full)}"`;
    rows.push(`<tr><th scope="row"${title}>${escape(short)}</th><td>${escape(text)}</td></tr>`);
  };
  visit(value, '', 0);
  return '<div class="tool-json">' + copyButtonHtml('cite-copy', JSON.stringify(value, null, 2) ?? 'null')
    + '<div class="tool-json-scroll"><table><tbody>' + rows.join('') + '</tbody></table></div></div>';
}

export function tryRenderToolJson(text: string): string | null {
  try { return renderToolJson(JSON.parse(text)); } catch { return null; }
}
