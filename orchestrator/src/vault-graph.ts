import { realpathSync, type FSWatcher, readFileSync, readdirSync, statSync, watch } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { configuredVaultRoot } from './vault-root.js';

let VAULT_ROOT = '';
let watcher: FSWatcher | null = null;
function refreshRoot(): void {
  const root = configuredVaultRoot();
  if (root === VAULT_ROOT) return;
  watcher?.close();
  watcher = null;
  watchInitialized = false;
  cachedGraph = null;
  VAULT_ROOT = root;
}

export interface NoteNode {
  id: string;
  title: string;
  folder: string;
  tags: string[];
  degree: number;
  mtime: number;
}

interface Link {
  source: string;
  target: string;
}

export interface VaultGraph {
  nodes: NoteNode[];
  links: Link[];
  stats: { noteCount: number; linkCount: number; generatedAt: number };
}

// --- Front matter ---

function parseFrontMatter(content: string): { data: Record<string, string>; body: string } {
  if (!content.startsWith('---\n')) return { data: {}, body: content };
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return { data: {}, body: content };

  const fm = content.slice(4, end);
  const body = content.slice(end + 5);
  const data: Record<string, string> = {};

  for (const line of fm.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    data[key] = value;
  }

  return { data, body };
}

function parseTags(raw: string): string[] {
  const match = raw.match(/^\[(.*)\]$/);
  if (!match) return [];
  return match[1]!.split(',').map((t) => t.trim()).filter(Boolean);
}

// --- Wikilinks ---

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

export function extractWikilinks(content: string): string[] {
  const targets: string[] = [];
  let match: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((match = WIKILINK_RE.exec(content)) !== null) {
    // `[[note#heading]]` / `[[note^blockid]]` point to the same note: without this
    // strip, the basename becomes "note#heading" and the link is dropped.
    const t = match[1]!.split(/[#^]/)[0]!.trim();
    if (t) targets.push(t);
  }
  return targets;
}

// --- Resolution ---

export function resolveWikilink(
  target: string,
  nodeMap: Map<string, NoteNode>,
  basenameIndex: Map<string, string[]>,
  sourceId: string,
): string | null {
  // Exact match on relative path (e.g. "wiki/projects/rooks/foo")
  if (nodeMap.has(target)) return target;

  // Basename match
  const bn = basename(target);
  if (!bn) return null;

  const candidates = basenameIndex.get(bn);
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;

  // Multiple candidates: prefer same folder as source
  const sourceFolder = dirname(sourceId);
  for (const c of candidates) {
    if (dirname(c) === sourceFolder) return c;
  }

  // Ambiguous: skip
  return null;
}

// --- Graph builder ---

function buildGraph(): VaultGraph {
  const nodes: NoteNode[] = [];
  const nodeMap = new Map<string, NoteNode>();
  const basenameIndex = new Map<string, string[]>();

  let files: string[] = [];
  try {
    files = readdirSync(VAULT_ROOT, {
      recursive: true,
      encoding: 'utf8',
    }).filter((f) => f.endsWith('.md'));
  } catch {
    return { nodes: [], links: [], stats: { noteCount: 0, linkCount: 0, generatedAt: Date.now() } };
  }

  // Content kept from the 1st pass to avoid a 2nd disk read per note.
  const contents = new Map<string, string>();

  // First pass: nodes
  for (const relPath of files) {
    let absPath: string;
    try { absPath = realpathSync(join(VAULT_ROOT, relPath)); } catch { continue; }
    if (!absPath.startsWith(VAULT_ROOT + sep)) continue;
    let content: string;
    let mtime: number;
    try {
      content = readFileSync(absPath, 'utf8');
      // statSync must stay inside the try: a note deleted between the readdir
      // and here would otherwise crash the whole buildGraph (→ HTTP 500).
      mtime = statSync(absPath).mtimeMs;
    } catch {
      continue;
    }

    const { data } = parseFrontMatter(content);
    const id = relPath.replace(/\.md$/, '');
    const title = data['title'] ?? basename(relPath, '.md');
    const segments = relPath.split(sep);
    const folder = segments.length > 1 ? (segments[0] ?? '') : '';
    const tags = data['tags'] ? parseTags(data['tags']) : [];
    contents.set(id, content);

    const node: NoteNode = { id, title, folder, tags, degree: 0, mtime };
    nodes.push(node);
    nodeMap.set(id, node);

    const bn = basename(relPath, '.md');
    const existing = basenameIndex.get(bn);
    if (existing) {
      existing.push(id);
    } else {
      basenameIndex.set(bn, [id]);
    }
  }

  // Second pass: links
  const links: Link[] = [];
  const linkSet = new Set<string>();

  for (const [sourceId, content] of contents) {
    const targets = extractWikilinks(content);

    for (const target of targets) {
      const resolved = resolveWikilink(target, nodeMap, basenameIndex, sourceId);
      if (!resolved) continue;

      const key = `${sourceId}->${resolved}`;
      if (linkSet.has(key)) continue;
      linkSet.add(key);

      links.push({ source: sourceId, target: resolved });
    }
  }

  // Compute degrees
  for (const link of links) {
    const src = nodeMap.get(link.source);
    const tgt = nodeMap.get(link.target);
    if (src) src.degree++;
    if (tgt) tgt.degree++;
  }

  return {
    nodes,
    links,
    stats: {
      noteCount: nodes.length,
      linkCount: links.length,
      generatedAt: Date.now(),
    },
  };
}

// --- Cache + invalidation ---

let cachedGraph: VaultGraph | null = null;
let watchInitialized = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function invalidateCache(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    cachedGraph = null;
  }, 2000);
}

function initWatcher(): void {
  if (watchInitialized) return;
  try {
    watcher = watch(VAULT_ROOT, { recursive: true }, () => {
      invalidateCache();
    });
    // Flag set only on success: if the vault is missing at the first
    // call, the next call retries the watch instead of staying deaf for life.
    watchInitialized = true;
  } catch {
    // Vault inaccessible — graph stays empty, no crash
  }
}

export interface VaultNote {
  id: string;
  title: string;
  folder: string;
  content: string;
  mtime: number;
}

/**
 * Reads a vault note by its id (= relative path without `.md`).
 * Returns null if the note does not exist or if the id leaves the vault.
 */
export function getVaultNote(id: string): VaultNote | null {
  refreshRoot();
  if (!VAULT_ROOT) return null;
  // The id comes from the URL: without this bound, `../../.ssh/id_rsa` would be readable.
  let absPath: string;
  try { absPath = realpathSync(resolve(VAULT_ROOT, `${id}.md`)); } catch { return null; }
  if (absPath !== join(VAULT_ROOT, `${id}.md`) || !absPath.startsWith(VAULT_ROOT + sep)) {
    return null;
  }

  let content: string;
  let mtime: number;
  try {
    content = readFileSync(absPath, 'utf8');
    mtime = statSync(absPath).mtimeMs;
  } catch {
    return null;
  }

  const { data } = parseFrontMatter(content);
  const segments = id.split(sep);
  return {
    id,
    title: data['title'] ?? basename(id),
    folder: segments.length > 1 ? (segments[0] ?? '') : '',
    content,
    mtime,
  };
}

export function getVaultGraph(): VaultGraph {
  refreshRoot();
  if (!VAULT_ROOT) return { nodes: [], links: [], stats: { noteCount: 0, linkCount: 0, generatedAt: Date.now() } };
  initWatcher();
  if (!cachedGraph) {
    const graph = buildGraph();
    // An empty graph almost always comes from an unavailable vault: we do not
    // cache it, otherwise the orchestrator has to be restarted to get out of it.
    if (graph.stats.noteCount > 0) cachedGraph = graph;
    return graph;
  }
  return cachedGraph;
}
