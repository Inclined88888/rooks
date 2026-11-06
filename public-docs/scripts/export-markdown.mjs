// Plain-Markdown export of the public documentation, for AI readers.
//
// Two consumers share it, which is why it depends on nothing but node:
//  - the Docusaurus build (plugins/markdown-export.mjs) publishes one `.md`
//    per page next to its HTML, plus `llms.txt` and `llms-full.txt`;
//  - the desktop package (desktop/scripts/prepare-daemon-release.mjs) ships
//    the same pages with the daemon, so agents read the documentation of the
//    version actually installed, offline (bin/timon-mcp.mjs: docs_search,
//    docs_read).
//
// The source pages are MDX. What an AI reader cannot use is dropped (imports,
// comments, layout tags); what carries meaning is rewritten (tabs become
// labelled paragraphs, admonitions blockquotes, links to other pages point at
// their `.md` export). It publishes nothing the HTML site does not already
// publish, so it applies no policy of its own: the forbidden-term guard of
// doc-policy.mjs is for the generated references, which it checks upstream.
//
//   node public-docs/scripts/export-markdown.mjs <outDir>
import {mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve, sep} from 'node:path';
import process from 'node:process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const DOCS_DIR = resolve(here, '..', 'docs');
export const SITE_URL = 'https://docs.timon-ai.com';
export const SITE_TITLE = 'Timon';
export const SITE_SUMMARY = 'Timon brings your local AI agents into one workspace: install it, run missions through your existing CLI subscriptions, organise work on a Kanban board and extend it with plugins built on a public SDK.';

const SECTION_LABELS = {installation: 'Installation', usage: 'Using Timon', plugins: 'Create a plugin'};

/** Minimal front matter reader: the pages only use flat `key: value` lines. */
export function parseFrontMatter(raw) {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return {data: {}, body: text};
  const data = {};
  for (const line of match[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) data[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return {data, body: text.slice(match[0].length)};
}

/** Docusaurus' route for a docs file (`routeBasePath: '/'`, no number prefixes in this tree). */
export function routeOf(file, data = {}) {
  if (data.slug) return data.slug.startsWith('/') ? data.slug : `/${data.slug}`;
  const parts = file.replace(/\.mdx?$/, '').split('/');
  if (data.id) parts[parts.length - 1] = data.id;
  const last = parts[parts.length - 1].toLowerCase();
  if (last === 'index' || last === 'readme' || (parts.length > 1 && last === parts[parts.length - 2].toLowerCase())) parts.pop();
  return `/${parts.join('/')}`;
}

/** File of a route's export, relative to the output directory, always with `/`. */
export function exportFile(route) {
  return route === '/' ? 'index.md' : `${route.slice(1)}.md`;
}

export function sectionOf(route) {
  const first = route.split('/')[1] ?? '';
  return SECTION_LABELS[first] ?? 'Start';
}

function firstHeading(body) {
  const match = /^#\s+(.+)$/m.exec(body);
  return match ? match[1].trim() : null;
}

function listDocs(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listDocs(full, base));
    else if (/\.mdx?$/.test(entry.name) && !entry.name.startsWith('_')) out.push(relative(base, full).split(sep).join('/'));
  }
  return out.sort();
}

/** Reads every page of the docs tree: file, route, title, description, body. */
export function collectPages(docsDir = DOCS_DIR) {
  return listDocs(docsDir).map(file => {
    const {data, body} = parseFrontMatter(readFileSync(join(docsDir, ...file.split('/')), 'utf8'));
    const route = routeOf(file, data);
    return {file, route, title: data.title || firstHeading(body) || file, description: data.description ?? '', body};
  });
}

const posixJoin = (from, target) => {
  const parts = from.split('/').slice(0, -1);
  for (const piece of target.split('/')) {
    if (piece === '..') parts.pop();
    else if (piece !== '.' && piece !== '') parts.push(piece);
  }
  return parts.join('/');
};

/**
 * Link target as an AI reader should follow it: another page → its `.md`
 * export (site-absolute), anything else untouched.
 */
export function rewriteLink(target, fromFile, routesByFile) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('//')) return target;
  const [path, hash = ''] = target.split(/(?=#)/);
  if (/\.mdx?$/.test(path)) {
    const file = path.startsWith('/') ? path.slice(1) : posixJoin(fromFile, path);
    const route = routesByFile.get(file);
    return route ? `/${exportFile(route)}${hash}` : target;
  }
  if (path.startsWith('/') && !/\.[a-z0-9]+$/i.test(path) && !path.startsWith('/img/')) return `/${exportFile(path === '/' ? '/' : path.replace(/\/$/, ''))}${hash}`;
  return target;
}

const ADMONITION = /^:::(note|tip|info|caution|warning|danger|important)\b\s*(.*)$/;
const LAYOUT_TAG = /<\/?(div|span|p|br|Link|Tabs|details|summary)\b[^>]*\/?>/g;

/** MDX body → plain Markdown. Code blocks are copied verbatim. */
export function toMarkdown(page, routesByFile) {
  const out = [];
  let fence = null;
  let admonition = false;
  // A card is a <Link> wrapping a heading: the heading becomes the link.
  let linkTo = null;
  for (const line of page.body.split('\n')) {
    const fenceMark = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      out.push(admonition ? `> ${line}` : line);
      if (fenceMark && fenceMark[1] === fence) fence = null;
      continue;
    }
    if (fenceMark) {
      fence = fenceMark[1];
      out.push(admonition ? `> ${line}` : line);
      continue;
    }
    if (/^import\s.+from\s+['"].+['"];?\s*$/.test(line) || /^export\s/.test(line)) continue;
    const open = ADMONITION.exec(line);
    if (open) {
      const kind = open[1][0].toUpperCase() + open[1].slice(1);
      out.push(`> **${open[2] ? `${kind}: ${open[2]}` : kind}**`, '>');
      admonition = true;
      continue;
    }
    if (admonition && /^:::\s*$/.test(line)) {
      admonition = false;
      continue;
    }
    let text = line
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<TabItem\b[^>]*\blabel="([^"]*)"[^>]*>/g, '**$1**')
      .replace(/<\/TabItem>/g, '')
      .replace(/<Link\b[^>]*\bto="([^"]*)"[^>]*>/g, (_, to) => { linkTo = to; return ''; })
      .replace(/<\/Link>/g, () => { linkTo = null; return ''; })
      .replace(/<h([1-6])\b[^>]*>(.*?)<\/h\1>/g, (_, level, inner) => `${'#'.repeat(Number(level) + 1)} ${linkTo ? `[${inner}](${linkTo})` : inner}`)
      .replace(LAYOUT_TAG, '');
    if (text.trim() === '' && line.trim() !== '') continue;
    // JSX is indented for readability; kept as is, four spaces would turn the
    // converted line into a Markdown code block.
    if (text !== line) text = text.trim();
    text = text.replace(/\]\(([^)\s]+)\)/g, (_, target) => `](${rewriteLink(target, page.file, routesByFile)})`);
    out.push(admonition ? (text ? `> ${text}` : '>') : text);
  }
  const body = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const head = /^#\s/.test(body) ? '' : `# ${page.title}\n\n`;
  const summary = page.description ? `> ${page.description}\n\n` : '';
  return `${head}${summary}${body}\n`;
}

/**
 * The whole export. `order` (routes, sidebar order) decides the sequence of
 * llms.txt and llms-full.txt; pages it does not name follow, sorted by route.
 */
export function exportMarkdown({docsDir = DOCS_DIR, order = [], siteUrl = SITE_URL} = {}) {
  const collected = collectPages(docsDir);
  const routesByFile = new Map(collected.map(p => [p.file, p.route]));
  const rank = new Map(order.map((route, i) => [route, i]));
  const pages = collected
    .map(page => ({
      route: page.route,
      file: exportFile(page.route),
      title: page.title,
      description: page.description,
      section: sectionOf(page.route),
      markdown: toMarkdown(page, routesByFile),
    }))
    .sort((a, b) => (rank.get(a.route) ?? Infinity) - (rank.get(b.route) ?? Infinity) || a.route.localeCompare(b.route));

  const sections = [...new Set(pages.map(p => p.section))];
  const llmsTxt = [
    `# ${SITE_TITLE}`,
    '',
    `> ${SITE_SUMMARY}`,
    '',
    `Every page is also served as Markdown: append \`.md\` to its URL. The whole documentation in one file: ${siteUrl}/llms-full.txt`,
    ...sections.flatMap(section => [
      '',
      `## ${section}`,
      '',
      ...pages.filter(p => p.section === section).map(p => `- [${p.title}](${siteUrl}/${p.file})${p.description ? `: ${p.description}` : ''}`),
    ]),
    '',
  ].join('\n');
  const llmsFull = [
    `# ${SITE_TITLE} documentation`,
    '',
    `> ${SITE_SUMMARY}`,
    '',
    ...pages.map(p => `---\n\nSource: ${siteUrl}${p.route === '/' ? '' : p.route}\n\n${p.markdown}`),
  ].join('\n');

  return {pages, llmsTxt, llmsFull};
}

/**
 * Writes the export under `outDir`: one `.md` per page, `llms.txt`,
 * `llms-full.txt` and, when `index` is set, `index.json` (the page list the
 * MCP docs tools read).
 */
export function writeExport(result, outDir, {index = false} = {}) {
  for (const page of result.pages) {
    const target = join(outDir, ...page.file.split('/'));
    mkdirSync(dirname(target), {recursive: true});
    writeFileSync(target, page.markdown);
  }
  writeFileSync(join(outDir, 'llms.txt'), result.llmsTxt);
  writeFileSync(join(outDir, 'llms-full.txt'), result.llmsFull);
  if (index) {
    const entries = result.pages.map(({route, file, title, description, section}) => ({route, file, title, description, section}));
    writeFileSync(join(outDir, 'index.json'), `${JSON.stringify({site: SITE_URL, pages: entries}, null, 2)}\n`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('Usage: node public-docs/scripts/export-markdown.mjs <outDir>');
    process.exit(2);
  }
  const result = exportMarkdown();
  mkdirSync(outDir, {recursive: true});
  writeExport(result, resolve(outDir), {index: true});
  console.log(`exported ${result.pages.length} pages to ${resolve(outDir)}`);
}
