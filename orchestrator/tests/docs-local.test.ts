import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  docsIndex,
  docsSources,
  loadDocs,
  normaliseRoute,
  readDoc,
  searchDocs,
  sectionOf,
} from '../bin/docs-local.mjs';

type Page = { route: string; file: string; title: string; description: string; section: string; markdown: string };

const pages: Page[] = [
  { route: '/', file: 'index.md', title: 'Rooks documentation', description: 'Start here.', section: 'Start', markdown: '# Rooks documentation\n\nWelcome.\n' },
  {
    route: '/installation/linux', file: 'installation/linux.md', title: 'Linux', description: '', section: 'Installation',
    markdown: '# Linux\n\n## Desktop package\n\nUse the deb package.\n\n### Service\n\nA systemd user service.\n\n## From a checkout\n\n```bash\n# not a heading\nnpm ci\n```\n\nBuild it.\n',
  },
  { route: '/usage/agents', file: 'usage/agents.md', title: 'Agents', description: 'Permission mode and backends.', section: 'Using Rooks', markdown: '# Agents\n\nEach agent has a permission mode.\n' },
];

test('routes are accepted in every form an agent may hold', () => {
  assert.equal(normaliseRoute('/installation/linux'), '/installation/linux');
  assert.equal(normaliseRoute('installation/linux.md'), '/installation/linux');
  assert.equal(normaliseRoute('https://docs.rooks.local/installation/linux.md#service'), '/installation/linux');
  assert.equal(normaliseRoute('/plugins/api-reference/'), '/plugins/api-reference');
  assert.equal(normaliseRoute('/index.md'), '/');
  assert.equal(normaliseRoute(''), '/');
});

test('search: every word must match, title and description outrank the body', () => {
  const hits = searchDocs(pages, 'permission mode');
  assert.equal(hits[0].route, '/usage/agents');
  assert.equal(hits.length, 1);
  assert.match(hits[0].excerpt, /permission mode/);
  // No page holds both words: falls back to pages holding either.
  assert.deepEqual(searchDocs(pages, 'deb welcome').map((h) => h.route).sort(), ['/', '/installation/linux']);
  assert.throws(() => searchDocs(pages, 'a'), /at least one word/);
});

test('read: whole page with its source, one section, unknown route with suggestions', () => {
  assert.equal(readDoc(pages, '/usage/agents'), 'Source: https://docs.rooks.local/usage/agents\n\n# Agents\n\nEach agent has a permission mode.\n');
  assert.equal(readDoc(pages, '/').startsWith('Source: https://docs.rooks.local\n\n'), true);
  assert.equal(readDoc(pages, '/installation/linux', 'desktop'),
    'Source: https://docs.rooks.local/installation/linux\n\n## Desktop package\n\nUse the deb package.\n\n### Service\n\nA systemd user service.\n');
  assert.throws(() => readDoc(pages, '/installation/linu'), /Did you mean: \/installation\/linux/);
  assert.throws(() => readDoc(pages, '/installation/linux', 'windows'), /Headings: Desktop package \| Service \| From a checkout/);
});

test('a heading inside a code block does not end a section', () => {
  assert.equal(sectionOf(pages[1].markdown, 'from a checkout'), '## From a checkout\n\n```bash\n# not a heading\nnpm ci\n```\n\nBuild it.\n');
});

test('the page list is grouped by section', () => {
  assert.equal(docsIndex(pages), '## Start\n- / — Rooks documentation: Start here.\n\n## Installation\n- /installation/linux — Linux\n\n## Using Rooks\n- /usage/agents — Agents: Permission mode and backends.\n');
});

test('sources: override, then the packaged export, then the source checkout', () => {
  const bin = join('/', 'opt', 'rooks', 'orchestrator', 'bin');
  const sources = docsSources({ ROOKS_DOCS_DIR: 'docs-export' }, bin);
  assert.equal(sources[0].kind, 'export');
  assert.equal(sources[1].dir, join('/', 'opt', 'rooks', 'orchestrator', 'public-docs'));
  assert.equal(sources[2].script, join('/', 'opt', 'rooks', 'public-docs', 'scripts', 'export-markdown.mjs'));
  assert.equal(docsSources({}, bin).length, 2);
});

test('loads a packaged export, and the checkout when no export exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-export-'));
  mkdirSync(join(dir, 'usage'));
  writeFileSync(join(dir, 'usage', 'agents.md'), pages[2].markdown);
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ site: 'https://docs.rooks.local', pages: [{ route: '/usage/agents', file: 'usage/agents.md', title: 'Agents', description: '', section: 'Using Rooks' }] }));
  const packaged = await loadDocs({ ROOKS_DOCS_DIR: dir });
  assert.equal(packaged?.origin, dir);
  assert.equal(packaged?.pages[0].markdown, pages[2].markdown);

  // This repository is a checkout: with no export, the source tree is exported in memory.
  const bin = fileURLToPath(new URL('../bin/', import.meta.url));
  const checkout = await loadDocs({}, bin);
  assert.match(checkout?.origin ?? '', /export-markdown\.mjs$/);
  assert.ok((checkout?.pages.length ?? 0) > 50);
  assert.ok(checkout?.pages.some((p: Page) => p.route === '/installation/linux'));
});

test('rooks docs search|read answers from an export, with no daemon', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-cli-'));
  mkdirSync(join(dir, 'usage'));
  writeFileSync(join(dir, 'usage', 'agents.md'), '# Agents\n\n## Modes\n\nEach agent has a permission mode.\n\n## Other\n\nUnrelated.\n');
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ site: 'https://docs.rooks.local', pages: [{ route: '/usage/agents', file: 'usage/agents.md', title: 'Agents', description: '', section: 'Using Rooks' }] }));
  const cli = fileURLToPath(new URL('../bin/rooks', import.meta.url));
  // An unreachable API proves the command never calls the daemon.
  const env = { PATH: process.env.PATH, ROOKS_HOME: mkdtempSync(join(tmpdir(), 'docs-cli-home-')), ROOKS_DOCS_DIR: dir, ROOKS_API: 'http://127.0.0.1:1' };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'docs', ...args], { env, encoding: 'utf8', timeout: 20_000 });

  const found = run('search', 'permission', 'mode', '--json');
  assert.equal(found.status, 0, found.stderr);
  assert.equal(JSON.parse(found.stdout)[0].route, '/usage/agents');

  assert.match(run('search', 'permission').stdout, /^\/usage\/agents — Agents/);
  assert.match(run('read').stdout, /- \/usage\/agents — Agents/);
  const section = run('read', '/usage/agents', '--heading', 'modes');
  assert.match(section.stdout, /^Source: https:\/\/docs\.rooks-ai\.com\/usage\/agents\n\n## Modes/);
  assert.doesNotMatch(section.stdout, /Unrelated/);

  const missing = run('read', '/nope');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No documentation page at \/nope/);
  assert.equal(run('bogus').status, 64);
  assert.equal(run('search').status, 64);
});
