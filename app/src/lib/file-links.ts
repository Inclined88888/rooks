/**
 * Links an agent writes to a file it made ("report ready: /home/me/proj/out.md",
 * `file:///…`, `reports/out.md`). They point at the machine the agent runs on, so
 * in a browser — above all a remote one — they lead nowhere. This tells which
 * of them name a file of the agent's folder, so the chat can open it in the
 * Files viewer instead.
 */
/** `outside`: a file of the machine that is not in the agent's folder; `path` is its absolute path. */
export type FileLink = { kind: 'file'; path: string } | { kind: 'outside'; path: string };

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;
/** Routes of the app itself and static assets: never files of an agent. */
const APP_PATH = /^\/(api|_next|static|assets)(\/|$)/;

function decode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** Where a path that names a place of the machine starts, extension or not (`/etc/hosts`). */
const SYSTEM_ROOT = /^\/(etc|home|usr|var|tmp|opt|mnt|media|root|srv|boot|run|snap|bin|sbin|lib|lib64|proc|sys|dev|private|Users|Volumes|Library|Applications|System)\//;

const hasExtension = (path: string) => /\.[a-z0-9]{1,8}$/i.test(path.split('/').pop() ?? '');

export function resolveFileLink(href: string, roots: readonly string[]): FileLink | null {
  let raw = href.trim();
  if (!raw || raw.startsWith('#') || raw.startsWith('//')) return null;

  const scheme = SCHEME.exec(raw)?.[1]?.toLowerCase();
  if (scheme === 'file') {
    raw = raw.replace(/^file:\/\/[^/]*/i, '');
  } else if (scheme && !WINDOWS_DRIVE.test(raw)) {
    return null;
  }

  // A fragment or a `:12:3` suffix is a position in the file, not part of its name.
  let path = decode(raw.replace(/#.*$/, '').replace(/:\d+(?::\d+)?$/, '')).replace(/\\/g, '/');
  // `/D:/…` is how a `file:` URL spells a Windows path, and some agents write it bare (TIM-0076).
  if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
  // A trailing slash names a folder.
  if (!path || path.endsWith('/')) return null;

  const drive = WINDOWS_DRIVE.test(path);
  if (path.startsWith('/') || drive) {
    if (!drive && APP_PATH.test(path)) return null;
    for (const root of roots) {
      const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
      if (!base) continue;
      const same = (a: string, b: string) => (drive ? a.toLowerCase() === b.toLowerCase() : a === b);
      if (path.length > base.length + 1 && same(path.slice(0, base.length), base) && path[base.length] === '/') {
        return { kind: 'file', path: path.slice(base.length + 1) };
      }
    }
    return drive || hasExtension(path) || SYSTEM_ROOT.test(path) ? { kind: 'outside', path } : null;
  }

  // Relative: from the agent's folder. Only what looks like a file, and never up and out.
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.pop()) return null; continue; }
    parts.push(part);
  }
  const rel = parts.join('/');
  return rel && hasExtension(rel) ? { kind: 'file', path: rel } : null;
}
