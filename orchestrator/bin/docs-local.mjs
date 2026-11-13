/**
 * The Rooks user documentation, read locally by the MCP tools `docs_search`
 * and `docs_read` (bin/rooks-mcp.mjs).
 *
 * Why local: an agent that looks up how Rooks works should read the
 * documentation of the version installed on this machine, not whatever
 * docs.rooks.local says today, and should not need the network for it.
 *
 * Where the pages come from, first match wins:
 *  1. ROOKS_DOCS_DIR — an export directory (index.json + one .md per page);
 *  2. <orchestrator>/public-docs/ — the export shipped in the desktop package
 *     (desktop/scripts/prepare-daemon-release.mjs);
 *  3. a source checkout — public-docs/scripts/export-markdown.mjs run in
 *     memory, so a daemon started from the repository reads the current tree.
 *
 * Pure node, no dependency; the search is a plain scored full-text match,
 * which is enough for ~130 pages.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SITE_URL = 'https://docs.rooks.local';

/** Candidate sources, in order. Exported for the tests. */
export function docsSources(env = process.env, binDir = here) {
  const sources = [];
  if (env.ROOKS_DOCS_DIR) sources.push({ kind: 'export', dir: resolve(env.ROOKS_DOCS_DIR) });
  sources.push({ kind: 'export', dir: resolve(binDir, '..', 'public-docs') });
  sources.push({ kind: 'checkout', script: resolve(binDir, '..', '..', 'public-docs', 'scripts', 'export-markdown.mjs') });
  return sources;
}

function readExport(dir) {
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
  return index.pages.map((page) => ({
    ...page,
    markdown: readFileSync(join(dir, ...page.file.split('/')), 'utf8'),
  }));
}

/** Loads every page once: [{ route, title, description, section, markdown }]. */
export async function loadDocs(env = process.env, binDir = here) {
  for (const source of docsSources(env, binDir)) {
    if (source.kind === 'export' && existsSync(join(source.dir, 'index.json'))) {
      return { origin: source.dir, pages: readExport(source.dir) };
    }
    if (source.kind === 'checkout' && existsSync(source.script)) {
      const { exportMarkdown } = await import(pathToFileURL(source.script).href);
      return { origin: source.script, pages: exportMarkdown().pages };
    }
  }
  return null;
}

/** `/installation/linux`, from a route, a path, a `.md` file or a full URL. */
export function normaliseRoute(input) {
  let route = String(input ?? '').trim();
  if (route.startsWith(SITE_URL)) route = route.slice(SITE_URL.length);
  route = route.replace(/[?#].*$/, '').replace(/\.md$/, '').replace(/\/+$/, '');
  if (route === '' || route === '/index' || route === 'index') return '/';
  return route.startsWith('/') ? route : `/${route}`;
}

export function terms(query) {
  return [...new Set(String(query ?? '').toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter((t) => t.length >= 2))];
}

function count(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

function excerpt(markdown, needles, width = 280) {
  const lower = markdown.toLowerCase();
  const at = needles.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - Math.floor(width / 3));
  const text = markdown.slice(start, start + width).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${text}${start + width < markdown.length ? '…' : ''}`;
}

/**
 * Pages matching every term (all terms first; any term when none has them
 * all), scored title > description > headings > body.
 */
export function searchDocs(pages, query, limit = 8) {
  const needles = terms(query);
  if (!needles.length) throw new Error('docs_search needs at least one word of two characters or more');
  const scored = pages.map((page) => {
    const title = page.title.toLowerCase();
    const description = (page.description ?? '').toLowerCase();
    const body = page.markdown.toLowerCase();
    const headings = (page.markdown.match(/^#{1,6} .*$/gm) ?? []).join('\n').toLowerCase();
    let score = 0;
    let matched = 0;
    for (const t of needles) {
      const hits = count(body, t);
      if (hits || title.includes(t) || description.includes(t)) matched++;
      score += (title.includes(t) ? 10 : 0) + (description.includes(t) ? 4 : 0) + Math.min(count(headings, t), 3) * 3 + Math.min(hits, 10);
    }
    return { page, score, matched };
  }).filter((r) => r.matched > 0);
  const all = scored.filter((r) => r.matched === needles.length);
  const pool = all.length ? all : scored;
  return pool
    .sort((a, b) => b.matched - a.matched || b.score - a.score || a.page.route.localeCompare(b.page.route))
    .slice(0, Math.max(1, Math.min(Number(limit) || 8, 30)))
    .map(({ page, score }) => ({
      route: page.route,
      title: page.title,
      section: page.section,
      score,
      excerpt: excerpt(page.markdown, needles),
    }));
}

/** The part of a page under `heading` (case-insensitive substring), down to the next heading of the same or a higher level. */
export function sectionOf(markdown, heading) {
  const lines = markdown.split('\n');
  const wanted = heading.toLowerCase().replace(/^#+\s*/, '').trim();
  let fence = false;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    if (fence) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (start === -1) {
      if (m[2].toLowerCase().includes(wanted)) { start = i; level = m[1].length; }
    } else if (m[1].length <= level) {
      return lines.slice(start, i).join('\n').trim() + '\n';
    }
  }
  return start === -1 ? null : lines.slice(start).join('\n').trim() + '\n';
}

function headingsOf(markdown) {
  return (markdown.match(/^#{2,3} .*$/gm) ?? []).map((h) => h.replace(/^#+\s*/, ''));
}

/** Full page, or one section of it. Unknown route → error listing the closest routes. */
export function readDoc(pages, route, heading) {
  const wanted = normaliseRoute(route);
  const page = pages.find((p) => p.route === wanted)
    ?? pages.find((p) => p.route.toLowerCase() === wanted.toLowerCase());
  if (!page) {
    const last = wanted.split('/').pop() ?? '';
    const close = pages.filter((p) => last && p.route.toLowerCase().includes(last.toLowerCase())).slice(0, 5).map((p) => p.route);
    throw new Error(`No documentation page at ${wanted}.${close.length ? ` Did you mean: ${close.join(', ')}?` : ''} Use docs_search, or docs_read without a route for the page list.`);
  }
  const source = `Source: ${SITE_URL}${page.route === '/' ? '' : page.route}\n\n`;
  if (!heading) return source + page.markdown;
  const part = sectionOf(page.markdown, heading);
  if (!part) throw new Error(`No heading matching "${heading}" in ${page.route}. Headings: ${headingsOf(page.markdown).join(' | ')}`);
  return source + part;
}

/** Page list grouped by section, one line per page. */
export function docsIndex(pages) {
  const sections = [...new Set(pages.map((p) => p.section))];
  return sections.map((section) => [
    `## ${section}`,
    ...pages.filter((p) => p.section === section).map((p) => `- ${p.route} — ${p.title}${p.description ? `: ${p.description}` : ''}`),
  ].join('\n')).join('\n\n') + '\n';
}
