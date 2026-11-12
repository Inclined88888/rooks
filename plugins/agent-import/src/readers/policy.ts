/**
 * What both source readers (folder, zip) share: the shape of the tree they
 * hand to an adapter, the deny list applied BEFORE an adapter's `wants`, the
 * `wants` globs, and the selection that enforces the per-file, per-skill and
 * per-source ceilings on metadata alone — before a byte of content is read
 * or inflated.
 *
 * Paths in a tree are relative, POSIX (`/`), NFC-normalised: an adapter
 * matches `skills/café/SKILL.md` the same whether the folder came from macOS
 * (NFD names on disk), Windows (`\` in its zips) or Linux.
 */
import type { ReaderLimits } from './limits.js';

export type ReaderErrorCode =
  | 'unsafe-path'      // `..`, absolute or drive path, NUL: the source is hostile, refused whole
  | 'too-large'        // a byte ceiling of the whole source
  | 'too-many-files'   // the file-count ceiling of the whole source
  | 'too-deep'         // a folder deeper than the walk allows
  | 'bomb'             // an expansion ratio no text reaches
  | 'corrupt'          // malformed or self-contradicting archive
  | 'unsupported'      // encrypted entry, unknown compression, ZIP64, multi-disk
  | 'not-a-directory'  // the folder root is missing or not a folder
  | 'changed';         // a file changed between its listing and its reading

export class ReaderError extends Error {
  constructor(readonly code: ReaderErrorCode, message: string) {
    super(message);
    this.name = 'ReaderError';
  }
}

export type SkipReason =
  | 'blocked'          // deny list: secrets, keys, state databases, `.git`, `node_modules`
  | 'nested-archive'   // an archive inside the source is never opened
  | 'link'             // symbolic link or junction: never followed
  | 'hard-link'        // a file with more than one name: it may be a secret stored outside the root
  | 'special'          // device, FIFO, socket
  | 'unportable-name'  // a name Windows cannot hold (`:`, `<`, `CON`…)
  | 'too-large'        // one file past FILE_MAX_BYTES
  | 'skill-too-large'  // one skill past SKILL_MAX_BYTES / SKILL_MAX_FILES
  | 'case-collision';  // two paths equal once case is ignored (`README` / `readme`)

export type SkippedEntry = { path: string; reason: SkipReason };

/** A name the reader had to guess (a zip written without UTF-8 names). */
export type TreeNotice = { path: string; code: 'name-not-utf8' };

export type SourceTree = {
  /** Relative POSIX path → bytes, sorted by path. Line endings untouched. */
  files: Map<string, Uint8Array>;
  /** What was left out, so the preview can say so (names only, never content). */
  skipped: SkippedEntry[];
  notices: TreeNotice[];
  totalBytes: number;
};

/* ── Deny list ──────────────────────────────────────────────────────────── */

/**
 * Matched against EVERY segment of a path, case-insensitively: a folder that
 * matches is not entered, a file that matches is not read, whatever `wants`
 * says. The point is that an adapter — possibly a third-party one — can never
 * receive a secret, even by asking for `**`.
 */
const DENIED_SEGMENTS: readonly RegExp[] = [
  // `.env`, `.env.local`, `.envrc`, `.env_prod`, `prod.env`: any name starting
  // with `.env` is treated as a secret store, at the cost of a rare false positive.
  /^\.env/i, /\.env$/i,
  /^auth\.json$/i, /^credentials\.json$/i,     // Hermes / CLI credentials
  /^state\.db(-wal|-shm|-journal)?$/i,         // Hermes state database and its journals
  /\.(pem|key|p12|pfx)$/i,                     // certificates and private keys
  // SSH keys (`id_rsa`, `id_ed25519.pub`). An extension other than `.pub`
  // means an ordinary file (`id_mapping.md`), which stays readable.
  /^id_[a-z0-9_-]+(\.pub)?$/i,
  /^\.git$/i, /^node_modules$/i, /^\.ssh$/i, /^\.gnupg$/i,
  // Not secrets but OS bookkeeping a Finder or Explorer zip carries: AppleDouble
  // copies (`__MACOSX/…/._SKILL.md`) would otherwise reach an adapter asking for `**`.
  /^__MACOSX$/, /^\._/, /^\.DS_Store$/i, /^Thumbs\.db$/i, /^desktop\.ini$/i,
];

/** Archives inside the source: opening them would bypass every ceiling here. */
const NESTED_ARCHIVE = /\.(zip|tar|tgz|tbz2?|txz|gz|bz2|xz|zst|7z|rar|jar)$/i;

export function isDeniedSegment(segment: string): boolean {
  return DENIED_SEGMENTS.some((re) => re.test(segment));
}

export function isNestedArchive(fileName: string): boolean {
  return NESTED_ARCHIVE.test(fileName);
}

/**
 * The first segment that denies the path, as the prefix to report: a whole
 * `node_modules/` is one skipped entry, not three thousand.
 */
export function deniedPrefix(segments: readonly string[]): string | null {
  for (let i = 0; i < segments.length; i++) {
    if (isDeniedSegment(segments[i] ?? '')) return segments.slice(0, i + 1).join('/');
  }
  return null;
}

/* ── Names ──────────────────────────────────────────────────────────────── */

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * A segment Windows cannot store: the tree may be written back to disk on any
 * OS, and `a.md:x` on NTFS is an alternate data stream, not a file.
 */
export function isUnportableSegment(segment: string): boolean {
  if (segment === '' || segment === '.' || segment === '..') return true;
  if (/[<>:"|?*\\\u0000-\u001f]/.test(segment)) return true;
  if (segment.endsWith('.') || segment.endsWith(' ')) return true;
  return WINDOWS_RESERVED.test(segment);
}

/**
 * The segments of an archive entry name. `\` is a separator (the Windows
 * Explorer writes it), `.` and empty segments vanish, and anything that could
 * land outside the import — `..`, a leading `/`, a drive letter, a UNC path,
 * a NUL — refuses the whole archive: no honest tool writes those.
 */
export function archiveEntrySegments(raw: string): string[] {
  if (raw.includes('\0')) throw new ReaderError('unsafe-path', 'archive entry name contains a NUL byte');
  const name = raw.replaceAll('\\', '/');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
    throw new ReaderError('unsafe-path', `archive entry ${JSON.stringify(raw)} has an absolute path`);
  }
  const parts = name.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.includes('..')) {
    throw new ReaderError('unsafe-path', `archive entry ${JSON.stringify(raw)} escapes the archive (\`..\`)`);
  }
  return parts.map((part) => part.normalize('NFC'));
}

/* ── Globs ──────────────────────────────────────────────────────────────── */

type GlobSegment = RegExp | '**';
export type Glob = { source: string; segments: GlobSegment[] };

function segmentRegExp(segment: string): RegExp {
  let out = '';
  for (const ch of segment) {
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'u');
}

/**
 * `wants` globs: `*` and `?` inside a segment, `**` for any number of
 * segments (zero included), everything else literal and case-sensitive.
 * Relative POSIX only — an adapter has no business naming `..` or a root.
 */
export function compileGlob(pattern: string): Glob {
  const parts = pattern.split('/').filter((part) => part !== '' && part !== '.');
  if (pattern.startsWith('/') || pattern.includes('\\') || parts.includes('..') || parts.length === 0) {
    throw new ReaderError('unsafe-path', `invalid wants pattern ${JSON.stringify(pattern)}`);
  }
  return {
    source: pattern,
    segments: parts.map((part) => (part === '**' ? '**' : segmentRegExp(part.normalize('NFC')))),
  };
}

function matchFrom(glob: readonly GlobSegment[], gi: number, path: readonly string[], pi: number): boolean {
  if (gi === glob.length) return pi === path.length;
  const g = glob[gi];
  if (g === '**') {
    for (let skip = pi; skip <= path.length; skip++) {
      if (matchFrom(glob, gi + 1, path, skip)) return true;
    }
    return false;
  }
  const seg = path[pi];
  if (seg === undefined || g === undefined || !g.test(seg)) return false;
  return matchFrom(glob, gi + 1, path, pi + 1);
}

export function globMatches(glob: Glob, segments: readonly string[]): boolean {
  return matchFrom(glob.segments, 0, segments, 0);
}

/** Whether a file below this folder could still match: the walk prunes the rest. */
export function globMayMatchBelow(glob: Glob, dirSegments: readonly string[]): boolean {
  let gi = 0;
  for (const seg of dirSegments) {
    const g = glob.segments[gi];
    if (g === '**') return true;
    if (g === undefined || !g.test(seg)) return false;
    gi++;
  }
  return gi < glob.segments.length;
}

export function compileWants(wants: readonly string[]): Glob[] {
  if (wants.length === 0) throw new ReaderError('unsafe-path', 'an adapter must declare at least one wants pattern');
  return wants.map(compileGlob);
}

/* ── Selection ──────────────────────────────────────────────────────────── */

export type Candidate<T> = { path: string; size: number; ref: T };

const SKILL_FILE = 'skill.md';

function parentOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}

/**
 * Applies, on metadata only, what does not need the content: one file too
 * large, two paths that a case-insensitive disk would merge, one skill too
 * large, and finally the ceilings of the whole source (which refuse it).
 * Candidates have already passed the deny list and `wants`.
 */
export function planSelection<T>(
  candidates: readonly Candidate<T>[],
  limits: ReaderLimits,
): { keep: Candidate<T>[]; skipped: SkippedEntry[] } {
  const skipped: SkippedEntry[] = [];
  const sorted = [...candidates].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  let kept: Candidate<T>[] = [];
  for (const c of sorted) {
    if (c.size > limits.maxFileBytes) skipped.push({ path: c.path, reason: 'too-large' });
    else kept.push(c);
  }

  // Both sides of a collision go: keeping either one would be a guess, and on
  // Windows or macOS the second write would silently replace the first.
  const byKey = new Map<string, Candidate<T>[]>();
  for (const c of kept) {
    const key = c.path.toLowerCase();
    const group = byKey.get(key);
    if (group) group.push(c);
    else byKey.set(key, [c]);
  }
  const colliding = new Set<Candidate<T>>();
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    for (const c of group) {
      colliding.add(c);
      skipped.push({ path: c.path, reason: 'case-collision' });
    }
  }
  kept = kept.filter((c) => !colliding.has(c));

  // A skill is the folder of a SKILL.md; a file belongs to its nearest one.
  const skillDirs = new Set(
    kept.filter((c) => (c.path.split('/').pop() ?? '').toLowerCase() === SKILL_FILE).map((c) => parentOf(c.path)),
  );
  if (skillDirs.size > 0) {
    const owner = (path: string): string | null => {
      for (let dir = parentOf(path); ; dir = parentOf(dir)) {
        if (skillDirs.has(dir)) return dir;
        if (dir === '') return null;
      }
    };
    const usage = new Map<string, { bytes: number; files: number }>();
    const owners = new Map<Candidate<T>, string>();
    for (const c of kept) {
      const dir = owner(c.path);
      if (dir === null) continue;
      owners.set(c, dir);
      const u = usage.get(dir) ?? { bytes: 0, files: 0 };
      u.bytes += c.size;
      u.files += 1;
      usage.set(dir, u);
    }
    const oversized = new Set<string>();
    for (const [dir, u] of usage) {
      if (u.bytes > limits.maxSkillBytes || u.files > limits.maxSkillFiles) {
        oversized.add(dir);
        skipped.push({ path: dir === '' ? '.' : dir, reason: 'skill-too-large' });
      }
    }
    if (oversized.size > 0) kept = kept.filter((c) => !oversized.has(owners.get(c) ?? '\0'));
  }

  if (kept.length > limits.maxFiles) {
    throw new ReaderError('too-many-files', `the source holds more than ${limits.maxFiles} importable files`);
  }
  const total = kept.reduce((sum, c) => sum + c.size, 0);
  if (total > limits.maxBytes) {
    throw new ReaderError('too-large', `the source holds more than ${limits.maxBytes} bytes of importable files`);
  }
  return { keep: kept, skipped };
}
