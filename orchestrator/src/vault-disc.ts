/**
 * Live payload of the vault-graph disc (luke321/vault-graph).
 *
 * Filesystem crawl of the knowledge vault, same shape as `src/build-graph.mjs`:
 * indexed nodes + edges {s,t,w}. Distinct from `vault-graph.ts` (cockpit 3D graph).
 */
import { type FSWatcher, lstatSync, existsSync, readFileSync, readdirSync, statSync, watch } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { configuredVaultRoot } from './vault-root.js';
import { dateTally, localDay, resolveCreated, type DateTally } from './vault-disc-dates.js';


function vaultRoot(): string {
  return configuredVaultRoot();
}

export interface VaultDiscNode {
  id: string;
  label: string;
  folder: string;
  dirs: string[];
  sub: string;
  type: string;
  tags: string[];
  created: string;
  touched: string;
  words: number;
  deg: number;
  ghost?: boolean;
}

export interface VaultDiscEdge {
  s: number;
  t: number;
  w: number;
}

export interface VaultDiscData {
  vault: string;
  generated: string;
  nodes: VaultDiscNode[];
  edges: VaultDiscEdge[];
  stats: {
    files: number;
    nodes: number;
    edges: number;
    unresolved: number;
    orphans: number;
    dates: DateTally;
    templatesExcluded: boolean;
    ghostsIncluded: boolean;
  };
}

type FmValue = string | string[];
type FrontMatter = Record<string, FmValue>;

const MONTHISH = /^\d{4}(?:[-_ ]?(?:\d{2}|Q[1-4]|W\d{1,2}))?$/i;
const TYPE_ALIAS: Record<string, string> = {
  people: 'person',
  person: 'person',
  'zettel/permanent': 'zettel',
  'zettel/fleeting': 'zettel',
  'zettel/literature': 'zettel',
};
const SKIP_DIRS = new Set(['node_modules']);
const SKIP_FILES = new Set(['claude.md', 'readme.md', 'license.md']);

const WIKILINK = /!?\[\[([^\[\]|#^]+)(?:[#^][^\[\]|]*)?(?:\|[^\[\]]*)?\]\]/g;
const MDLINK = /\[[^\]]*\]\(([^)\s]+\.md)(?:\s[^)]*)?\)/g;

function emptyDisc(): VaultDiscData {
  return {
    vault: 'vault',
    generated: formatGenerated(new Date()),
    nodes: [],
    edges: [],
    stats: {
      files: 0,
      nodes: 0,
      edges: 0,
      unresolved: 0,
      orphans: 0,
      dates: dateTally(),
      templatesExcluded: true,
      ghostsIncluded: false,
    },
  };
}

function formatGenerated(d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function readJson(rel: string): unknown {
  try {
    return JSON.parse(readFileSync(join(vaultRoot(), rel), 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function asFolder(value: unknown): string {
  return typeof value === 'string' && value.trim() ? norm(value) : '';
}

function templateDirs(): string[] {
  const out = new Set<string>();
  const core = readJson('.obsidian/templates.json');
  if (core && typeof core === 'object' && 'folder' in core) {
    const folder = asFolder((core as { folder?: unknown }).folder);
    if (folder) out.add(folder);
  }
  const templater = readJson('.obsidian/plugins/templater-obsidian/data.json');
  if (templater && typeof templater === 'object' && 'templates_folder' in templater) {
    const folder = asFolder((templater as { templates_folder?: unknown }).templates_folder);
    if (folder) out.add(folder);
  }
  if (out.size === 0 && existsSync(join(vaultRoot(), 'templates'))) {
    out.add('templates');
  }
  return [...out];
}

function dailyDir(): string {
  const dn = readJson('.obsidian/daily-notes.json');
  if (dn && typeof dn === 'object' && 'folder' in dn) {
    return asFolder((dn as { folder?: unknown }).folder);
  }
  return '';
}

export function norm(s: string): string {
  return String(s).split(/[\\/]/).filter(Boolean).join('/');
}

export function under(rel: string, dir: string): boolean {
  return Boolean(dir) && (rel === dir || rel.startsWith(`${dir}/`)); // portability: vault-relative posix path (relativePosix)
}

function unquote(s: string): string {
  return String(s).trim().replace(/^["']|["']$/g, '').trim();
}

export function parseFrontmatter(raw: string): { fm: FrontMatter; body: string } {
  const text = raw.replace(/^\uFEFF/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return { fm: {}, body: text };
  const fm: FrontMatter = {};
  const block = m[1] ?? '';
  const lines = block.split(/\r?\n/);
  let key: string | null = null;
  for (const line of lines) {
    const li = /^\s*-\s+(.*)$/.exec(line);
    if (li && key) {
      const cur = fm[key];
      const item = unquote(li[1] ?? '');
      if (Array.isArray(cur)) cur.push(item);
      else fm[key] = [item];
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    key = kv[1] ?? null;
    if (!key) continue;
    const v = (kv[2] ?? '').trim();
    if (v === '') {
      fm[key] = [];
      continue;
    }
    if (v.startsWith('[') && v.endsWith(']')) {
      fm[key] = v
        .slice(1, -1)
        .split(',')
        .map(unquote)
        .filter(Boolean);
    } else {
      fm[key] = unquote(v);
    }
  }
  return { fm, body: text.slice(m[0].length) };
}

function stripCode(s: string): string {
  return s
    .replace(/^```[\s\S]*?^```/gm, '\n')
    .replace(/^~~~[\s\S]*?^~~~/gm, '\n')
    .replace(/`[^`\n]*`/g, ' ');
}

function scan(text: string, re: RegExp, out: string[]): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1] ?? '';
    try {
      const decoded = decodeURIComponent(raw).trim();
      if (decoded) out.push(decoded);
    } catch {
      const t = raw.trim();
      if (t) out.push(t);
    }
  }
}

export function mineLinks(body: string, fm: FrontMatter): string[] {
  const out: string[] = [];
  const clean = stripCode(body);
  scan(clean, WIKILINK, out);
  scan(clean, MDLINK, out);
  for (const v of Object.values(fm)) {
    const values = Array.isArray(v) ? v : [v];
    for (const s of values) {
      if (typeof s === 'string' && s.includes('[[')) scan(s, WIKILINK, out);
    }
  }
  return out;
}

function deNumber(s: string): string {
  return String(s).replace(/^[\s\d._)\-]+/, '').trim();
}

function slug(s: string): string {
  return deNumber(s).toLowerCase().replace(/[\s_]+/g, '-');
}

function singular(s: string): string {
  return s.replace(/ies$/, 'y').replace(/([^aeious])s$/, '$1');
}

const VAULT_ROOT_FOLDER = '(vault root)';
const WIKI_NS = 'wiki';
/** Universes that, in a PARA vault, would be root folders. In
 *  this layout they live under `wiki/`: without lifting them up, ~90% of the notes
 *  share the colour of the first segment and the disc is monochrome. */
const WIKI_PROMOTED = new Set(['projects', 'perso']);
/** Bucket whose every subfolder becomes a group of its own. The disc only
 *  colours the root groups — a subfolder only inherits a shade of
 *  its parent, over four steps shared beyond that. Without this lift, the 24
 *  projects share four shades of the same colour. */
const OWN_GROUP_BUCKET = 'projects';

/** Index of the path segment that carries the group, 0 = first segment. */
function promoDepth(seg: string[]): number {
  if (seg[0] !== WIKI_NS) return 0;
  const bucket = seg[1];
  if (!bucket || !WIKI_PROMOTED.has(bucket) || seg.length <= 2) return 0;
  // `wiki/projects/rooks.md` has no folder of its own: it stays in `projects`.
  if (bucket === OWN_GROUP_BUCKET && seg.length > 3) return 2;
  return 1;
}

export function paraFolder(relPath: string): string {
  const seg = relPath.split('/');
  if (seg.length <= 1) return VAULT_ROOT_FOLDER;
  return seg[promoDepth(seg)] ?? VAULT_ROOT_FOLDER;
}

export function paraDirs(relPath: string, flatMonths = false): string[] {
  const parts = relPath.split('/');
  const seg = parts.slice(promoDepth(parts) + 1, -1);
  const out: string[] = [];
  for (let i = 0; i < seg.length; i++) {
    const part = seg[i] ?? '';
    if (MONTHISH.test(part)) {
      if (i === 0 && !flatMonths) out.push(part);
      break;
    }
    out.push(part);
  }
  return out;
}

export function inferType(
  fm: FrontMatter,
  relPath: string,
  tags: string[],
  daily: string,
  isTpl: (rel: string) => boolean,
): string {
  const raw = typeof fm.type === 'string' ? fm.type.toLowerCase() : '';
  if (raw) return TYPE_ALIAS[raw] ?? raw;
  if (tags.includes('daily-note')) return 'daily';
  if (under(relPath, daily)) return 'daily';
  if (isTpl(relPath)) return 'template';

  const dirs = relPath.split('/').slice(0, -1).filter(Boolean);
  const named = dirs.filter((d) => !MONTHISH.test(d));
  const pick = named.length ? named[named.length - 1] : dirs[0];
  const type = pick ? singular(slug(pick)) : '';
  return type || 'note';
}

function walk(dir: string, acc: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    let st;
    try {
      st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
      walk(p, acc);
    } else if (entry.toLowerCase().endsWith('.md') && !SKIP_FILES.has(entry.toLowerCase())) {
      acc.push(p);
    }
  }
  return acc;
}

function flattenFmList(v: FmValue | undefined): string[] {
  if (v === undefined) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .flatMap((t) => String(t).split(/[,\s]+/))
    .map((t) => t.replace(/^#/, '').trim())
    .filter(Boolean);
}

function relativePosix(abs: string): string {
  const root = vaultRoot();
  const rel = abs.startsWith(root + sep)
    ? abs.slice(root.length + 1)
    : abs;
  return rel.split('\\').join('/');
}

interface RawNote {
  id: string;
  label: string;
  folder: string;
  dirs: string[];
  sub: string;
  type: string;
  tags: string[];
  created: string;
  touched: string;
  words: number;
  links: string[];
}

function buildDisc(): VaultDiscData {
  const root = vaultRoot();
  if (!existsSync(root)) return emptyDisc();

  const tplDirs = templateDirs();
  const daily = dailyDir();
  const isTpl = (rel: string) => tplDirs.some((d) => under(rel, d));

  const files = walk(root).filter((abs) => {
    const rel = relativePosix(abs);
    return !isTpl(rel);
  });

  const notes: RawNote[] = [];
  const byKey = new Map<string, number>();
  const dates = dateTally();

  for (const abs of files) {
    const relPath = relativePosix(abs);
    let raw: string;
    let st;
    try {
      raw = readFileSync(abs, 'utf8');
      st = statSync(abs);
    } catch {
      continue;
    }
    const { fm, body } = parseFrontmatter(raw);
    const name = basename(abs, '.md');
    const dated = resolveCreated(fm, name, st.ctimeMs, st.mtimeMs);
    dates[dated.source]++;

    const tags = [...flattenFmList(fm.tags), ...flattenFmList(fm.tag)].filter(
      (t, i, a) => a.indexOf(t) === i,
    );
    const dirs = paraDirs(relPath);
    const note: RawNote = {
      id: relPath,
      label: name,
      folder: paraFolder(relPath),
      dirs,
      sub: dirs[0] ?? '',
      type: inferType(fm, relPath, tags, daily, isTpl),
      tags,
      created: dated.day,
      touched: localDay(st.mtimeMs),
      words: body.split(/\s+/).filter(Boolean).length,
      links: mineLinks(body, fm),
    };
    const idx = notes.push(note) - 1;
    const keys = [name, note.id, note.id.replace(/\.md$/, ''), ...flattenFmList(fm.aliases), ...flattenFmList(fm.alias)];
    for (const k of keys) {
      const kk = String(k).toLowerCase().trim();
      if (kk && !byKey.has(kk)) byKey.set(kk, idx);
    }
  }

  const resolve = (target: string): number => {
    const t = target.toLowerCase().trim().replace(/\.md$/, '');
    const exact = byKey.get(t);
    if (exact !== undefined) return exact;
    const base = t.split('/').pop();
    if (!base) return -1;
    return byKey.get(base) ?? -1;
  };

  const edgeWeight = new Map<string, number>();
  let unresolved = 0;

  const addEdge = (i: number, j: number): void => {
    if (i === j) return;
    const key = i < j ? `${i} ${j}` : `${j} ${i}`;
    edgeWeight.set(key, (edgeWeight.get(key) ?? 0) + 1);
  };

  for (let i = 0; i < notes.length; i++) {
    for (const target of notes[i]!.links) {
      const j = resolve(target);
      if (j < 0) {
        unresolved++;
        continue;
      }
      addEdge(i, j);
    }
  }

  const edges: VaultDiscEdge[] = [...edgeWeight].map(([k, w]) => {
    const [a, b] = k.split(' ').map(Number);
    return { s: a ?? 0, t: b ?? 0, w };
  });

  const degree = new Array<number>(notes.length).fill(0);
  for (const e of edges) {
    const ds = degree[e.s];
    const dt = degree[e.t];
    if (ds !== undefined) degree[e.s] = ds + 1;
    if (dt !== undefined) degree[e.t] = dt + 1;
  }

  const nodes: VaultDiscNode[] = notes.map((n, i) => ({
    id: n.id,
    label: n.label,
    folder: n.folder,
    dirs: n.dirs,
    sub: n.sub,
    type: n.type,
    tags: n.tags,
    created: n.created,
    touched: n.touched,
    words: n.words,
    deg: degree[i] ?? 0,
  }));

  return {
    // The folder's own name: the product has no name of its own for a user's notes.
    vault: basename(root) || 'vault',
    generated: formatGenerated(new Date()),
    nodes,
    edges,
    stats: {
      files: files.length,
      nodes: nodes.length,
      edges: edges.length,
      unresolved,
      orphans: degree.filter((d) => d === 0).length,
      dates,
      templatesExcluded: true,
      ghostsIncluded: false,
    },
  };
}

let cachedDisc: VaultDiscData | null = null;
let watchedRoot = '';
let watcher: FSWatcher | null = null;
let watchInitialized = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function invalidateCache(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    cachedDisc = null;
  }, 2000);
}

function initWatcher(): void {
  if (watchInitialized) return;
  try {
    watcher = watch(vaultRoot(), { recursive: true }, () => {
      invalidateCache();
    });
    watchInitialized = true;
  } catch {
    // Vault inaccessible — disc stays empty, no crash
  }
}

export function getVaultDisc(): VaultDiscData {
  const root = vaultRoot();
  if (root !== watchedRoot) {
    watcher?.close();
    watcher = null;
    watchInitialized = false;
    cachedDisc = null;
    watchedRoot = root;
  }
  if (!root) return emptyDisc();
  initWatcher();
  if (!cachedDisc) {
    const disc = buildDisc();
    if (disc.stats.nodes > 0) cachedDisc = disc;
    return disc;
  }
  return cachedDisc;
}
