#!/usr/bin/env node
/**
 * Client JS weight per App Router route, read from a finished `next build`.
 *
 *   node scripts/measure-bundle.mjs [--dist app/.next] [--route /chat] [--json]
 *   node scripts/measure-bundle.mjs --dist app/.next-after --compare app/.next-before
 *   node scripts/measure-bundle.mjs --route /chat --modules   # build with ROOKS_BUNDLE_STATS=1
 *   node scripts/measure-bundle.mjs --why highlight.js/lib/core  # import chain from the root layout
 *   node scripts/measure-bundle.mjs --retained   # what each module alone keeps in the root layout
 *
 * `app-build-manifest.json` lists, per entry (`/layout`, `/(main)/layout`,
 * `/chat/page`…), the files the browser loads for it. A route's cost is the
 * UNION of its page and every layout above it — the shared webpack runtime
 * appears in each entry and must only count once. Only what the first paint
 * loads is counted: chunks behind `next/dynamic` or `import()` are not in the
 * manifest, which is exactly what makes them free for a route.
 *
 * Gzip is measured here (zlib, default level) rather than taken from Next's
 * build output, which reports first-load sizes per page with its own rules
 * and nothing for the root layout alone.
 *
 * No dependency: node built-ins only (AGENTS.md rule 12).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DIST = join(ROOT, 'app', '.next');

/** Route groups `(main)` and the trailing `/page` vanish from the URL. */
export function routeOf(entry) {
  const path = entry
    .replace(/\/page$/, '')
    .split('/')
    .filter((seg) => seg && !/^\(.*\)$/.test(seg))
    .join('/');
  return `/${path}`;
}

/** Layout entries that wrap `pageEntry`, outermost first. */
export function layoutChain(pageEntry, entries) {
  const segments = pageEntry.replace(/\/page$/, '').split('/').filter(Boolean);
  const chain = [];
  for (let i = 0; i <= segments.length; i += 1) {
    const layout = `/${[...segments.slice(0, i), 'layout'].join('/')}`;
    if (entries.has(layout)) chain.push(layout);
  }
  return chain;
}

/**
 * `{ entry: files[] }` for the root layout and every page, each page's list
 * already merged with its layouts. Only `.js`: CSS is not what this measures,
 * and Next lists it alongside.
 */
export function routeFiles(manifest) {
  const pages = manifest.pages ?? {};
  const entries = new Set(Object.keys(pages));
  const js = (files) => (files ?? []).filter((f) => f.endsWith('.js'));
  const out = {};
  if (entries.has('/layout')) out['/layout'] = [...new Set(js(pages['/layout']))];
  for (const entry of entries) {
    if (!entry.endsWith('/page')) continue;
    const files = new Set();
    for (const layout of layoutChain(entry, entries)) for (const f of js(pages[layout])) files.add(f);
    for (const f of js(pages[entry])) files.add(f);
    out[entry] = [...files];
  }
  return out;
}

/** Sizes of `files` under `dist`, each file read and gzipped once. */
export function sizeOf(files, dist, cache = new Map()) {
  let raw = 0;
  let gzip = 0;
  let missing = 0;
  for (const file of files) {
    let size = cache.get(file);
    if (!size) {
      const path = join(dist, file);
      if (!existsSync(path)) { missing += 1; continue; }
      const buf = readFileSync(path);
      size = { raw: buf.length, gzip: gzipSync(buf).length };
      cache.set(file, size);
    }
    raw += size.raw;
    gzip += size.gzip;
  }
  return { files: files.length, raw, gzip, missing };
}

/** `node_modules/@scope/pkg/…` → `@scope/pkg`; app code keeps its path. */
export function packageOf(name) {
  const i = name.lastIndexOf('node_modules/');
  if (i < 0) return name.replace(/^\.\//, '').replace(/ \+ \d+ modules$/, '');
  const parts = name.slice(i + 'node_modules/'.length).split('/');
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

/**
 * What `files` carry, grouped by package, from the `bundle-modules.json` a
 * `ROOKS_BUNDLE_STATS=1` build writes. Sizes are webpack's source sizes
 * (before minification): good for ranking, not for adding up to `raw`.
 */
export function modulesOf(files, modulesByFile) {
  const totals = new Map();
  for (const file of files) {
    for (const m of modulesByFile[file] ?? []) {
      const key = packageOf(m.name);
      totals.set(key, (totals.get(key) ?? 0) + m.size);
    }
  }
  return [...totals.entries()].map(([name, size]) => ({ name, size })).sort((a, b) => b.size - a.size);
}

/**
 * Webpack names a concatenated module after its root (`./a.tsx + 3 modules`)
 * when it is the importer: folded back onto the root so the graph connects.
 * Next's client entry loader has no readable name once its loader prefix is
 * stripped (''): what it imports is an entry, so it is dropped as an importer.
 */
const unconcat = (name) => name.replace(/ \+ \d+ modules?$/, '');
const importersOf = (m) => (m.importers ?? []).map(unconcat).filter((i) => i && i !== m.name);

/** `name → static importers` over `files` (default: every chunk), merged. */
function importerGraph(modulesByFile, files = Object.keys(modulesByFile)) {
  const importers = new Map();
  for (const mods of files.map((f) => modulesByFile[f] ?? [])) {
    for (const m of mods) {
      const set = importers.get(m.name) ?? new Set();
      for (const i of importersOf(m)) set.add(i);
      importers.set(m.name, set);
    }
  }
  return importers;
}

/**
 * Shortest static import chain from the first module matching `needle` up to
 * a module nothing imports statically — a client component the layout or a
 * page renders (Next pulls those through an eager `import()`, which is why
 * the server `layout.tsx` itself never shows up). Pass a route's `files` to
 * stay inside that route: otherwise a page that also imports the module may
 * be the shorter answer.
 */
export function whyChain(needle, modulesByFile, files) {
  const importers = importerGraph(modulesByFile, files);
  const start = [...importers.keys()].find((n) => n.includes(needle));
  if (!start) return [];
  const parent = new Map([[start, null]]);
  const queue = [start];
  let end = start;
  while (queue.length) {
    const cur = queue.shift();
    const ups = [...(importers.get(cur) ?? [])].filter((up) => importers.has(up));
    if (ups.length === 0) { end = cur; break; }
    for (const up of ups) if (!parent.has(up)) { parent.set(up, cur); queue.push(up); }
  }
  const chain = [];
  for (let n = end; n; n = parent.get(n)) chain.unshift(n);
  return chain;
}

/**
 * What making each module lazy would take off a route: the modules reachable
 * from the route's entries only through it (its dominated set), source sizes
 * summed. Entries are the modules nothing imports statically. Only the
 * route's own `files` are walked, so a module shared with a lazy chunk does
 * not count.
 */
export function retainedSizes(files, modulesByFile) {
  const size = new Map();
  const children = new Map();
  for (const file of files) {
    for (const m of modulesByFile[file] ?? []) {
      size.set(m.name, m.size);
      for (const i of importersOf(m)) {
        if (!children.has(i)) children.set(i, new Set());
        children.get(i).add(m.name);
      }
    }
  }
  const importers = importerGraph(modulesByFile, files);
  const entries = [...size.keys()].filter((n) => ![...(importers.get(n) ?? [])].some((up) => size.has(up)));
  const reach = (skip) => {
    const seen = new Set(entries.filter((n) => n !== skip));
    const queue = [...seen];
    while (queue.length) {
      for (const c of children.get(queue.shift()) ?? []) {
        if (c !== skip && !seen.has(c)) { seen.add(c); queue.push(c); }
      }
    }
    return seen;
  };
  const all = reach(null);
  const total = (set) => [...set].reduce((sum, n) => sum + (size.get(n) ?? 0), 0);
  const whole = total(all);
  const out = [];
  for (const n of all) {
    const retained = whole - total(reach(n));
    if (retained > 0) out.push({ name: n, size: retained });
  }
  return out.sort((a, b) => b.size - a.size);
}

export function measure(dist) {
  const manifestPath = join(dist, 'app-build-manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`no app-build-manifest.json in ${dist} — run next build first`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const cache = new Map();
  const rows = [];
  for (const [entry, files] of Object.entries(routeFiles(manifest))) {
    rows.push({ entry, route: entry === '/layout' ? '(root layout)' : routeOf(entry), ...sizeOf(files, dist, cache) });
  }
  // The heaviest single files, whatever route pulls them: where to cut next.
  const chunks = [...cache.entries()]
    .map(([file, size]) => ({ file, ...size }))
    .sort((a, b) => b.raw - a.raw);
  rows.sort((a, b) => (a.entry === '/layout' ? -1 : b.entry === '/layout' ? 1 : a.route.localeCompare(b.route)));
  const statsPath = join(dist, 'bundle-modules.json');
  const modulesByFile = existsSync(statsPath) ? JSON.parse(readFileSync(statsPath, 'utf8')) : null;
  return { rows, chunks, files: routeFiles(manifest), modulesByFile };
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const delta = (now, before) => {
  if (before === undefined) return '';
  const d = now - before;
  return `${d > 0 ? '+' : ''}${(d / 1024).toFixed(0)} KB`;
};

export function render({ rows, chunks }, before, top = 10) {
  const prev = new Map((before?.rows ?? []).map((r) => [r.entry, r]));
  const lines = [];
  const head = ['route', 'files', 'raw', 'gzip'];
  if (before) head.push('Δ raw', 'Δ gzip');
  lines.push(head.join('\t'));
  for (const r of rows) {
    const cells = [r.route, String(r.files), kb(r.raw), kb(r.gzip)];
    if (before) cells.push(delta(r.raw, prev.get(r.entry)?.raw), delta(r.gzip, prev.get(r.entry)?.gzip));
    if (r.missing) cells.push(`(${r.missing} missing)`);
    lines.push(cells.join('\t'));
  }
  lines.push('', `heaviest chunks (top ${top})`);
  for (const c of chunks.slice(0, top)) lines.push(`${kb(c.raw)}\t${kb(c.gzip)}\t${c.file}`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const opts = { dist: DEFAULT_DIST, compare: null, route: null, json: false, modules: false, why: null, retained: false, top: 10 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--modules') opts.modules = true;
    else if (arg === '--why') opts.why = argv[++i];
    else if (arg === '--retained') opts.retained = true;
    else if (arg === '--dist') opts.dist = resolve(argv[++i]);
    else if (arg === '--compare') opts.compare = resolve(argv[++i]);
    else if (arg === '--route') opts.route = argv[++i];
    else if (arg === '--top') opts.top = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const keep = (m) => (opts.route ? { ...m, rows: m.rows.filter((r) => r.entry === '/layout' || r.route === opts.route) } : m);
  const now = keep(measure(opts.dist));
  const before = opts.compare ? keep(measure(opts.compare)) : undefined;
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ dist: opts.dist, rows: now.rows, chunks: now.chunks.slice(0, opts.top), before: before?.rows }, null, 2)}\n`);
  } else {
    process.stdout.write(`${render(now, before, opts.top)}\n`);
  }
  if ((opts.modules || opts.why || opts.retained) && !now.modulesByFile) throw new Error('no bundle-modules.json — rebuild with ROOKS_BUNDLE_STATS=1');
  if (opts.why) {
    const chain = whyChain(opts.why, now.modulesByFile, now.files['/layout']);
    process.stdout.write(chain.length ? `\nwhy ${opts.why} is in the root layout\n${chain.map((n, i) => `${'  '.repeat(i)}${i ? '← ' : ''}${n}`).join('\n')}\n` : `\nno module matches ${opts.why}\n`);
  }
  if (opts.retained) {
    process.stdout.write(`\nretained by each module of the root layout (top ${opts.top}, source size)\n`);
    for (const m of retainedSizes(now.files['/layout'] ?? [], now.modulesByFile).slice(0, opts.top)) {
      process.stdout.write(`${kb(m.size)}\t${m.name}\n`);
    }
  }
  if (opts.modules) {
    for (const row of now.rows) {
      process.stdout.write(`\nmodules of ${row.route} (top ${opts.top}, source size)\n`);
      for (const m of modulesOf(now.files[row.entry], now.modulesByFile).slice(0, opts.top)) {
        process.stdout.write(`${kb(m.size)}\t${m.name}\n`);
      }
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { main(); } catch (err) { process.stderr.write(`${err.message}\n`); process.exit(1); }
}
