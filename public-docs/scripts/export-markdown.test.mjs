import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  exportFile,
  exportMarkdown,
  parseFrontMatter,
  rewriteLink,
  routeOf,
  sectionOf,
  toMarkdown,
  writeExport,
} from './export-markdown.mjs';

const routes = new Map([
  ['installation/linux.md', '/installation/linux'],
  ['installation/first-run.md', '/installation/first-run'],
  ['plugins/api-reference/index.md', '/plugins/api-reference'],
  ['plugins/api-reference/interfaces/Dialect.md', '/plugins/api-reference/interfaces/Dialect'],
]);
const page = (body, extra = {}) => ({file: 'installation/linux.md', route: '/installation/linux', title: 'Linux', description: '', body, ...extra});

test('front matter: flat keys, quotes stripped, CRLF tolerated, absent block', () => {
  const {data, body} = parseFrontMatter('---\r\ntitle: "Linux"\r\nslug: /x\r\n---\r\nBody\r\n');
  assert.deepEqual(data, {title: 'Linux', slug: '/x'});
  assert.equal(body, 'Body\n');
  assert.deepEqual(parseFrontMatter('# Only a heading\n'), {data: {}, body: '# Only a heading\n'});
});

test('routes follow Docusaurus: slug, id, index pages', () => {
  assert.equal(routeOf('intro.md', {slug: '/'}), '/');
  assert.equal(routeOf('changelog.md', {slug: 'changelog'}), '/changelog');
  assert.equal(routeOf('installation/linux.md'), '/installation/linux');
  assert.equal(routeOf('installation/linux.md', {id: 'gnu'}), '/installation/gnu');
  assert.equal(routeOf('plugins/api-reference/index.md'), '/plugins/api-reference');
  assert.equal(exportFile('/'), 'index.md');
  assert.equal(exportFile('/installation/linux'), 'installation/linux.md');
  assert.equal(sectionOf('/plugins/kinds'), 'Create a plugin');
  assert.equal(sectionOf('/changelog'), 'Start');
});

test('links to pages point at their .md export; the rest is untouched', () => {
  assert.equal(rewriteLink('first-run.md#service', 'installation/linux.md', routes), '/installation/first-run.md#service');
  assert.equal(rewriteLink('interfaces/Dialect.md', 'plugins/api-reference/index.md', routes), '/plugins/api-reference/interfaces/Dialect.md');
  assert.equal(rewriteLink('../installation/linux.md', 'usage/cli.md', routes), '/installation/linux.md');
  assert.equal(rewriteLink('/usage/concepts', 'intro.md', routes), '/usage/concepts.md');
  assert.equal(rewriteLink('/', 'intro.md', routes), '/index.md');
  assert.equal(rewriteLink('https://rooks.local', 'intro.md', routes), 'https://rooks.local');
  assert.equal(rewriteLink('#anchor', 'intro.md', routes), '#anchor');
  assert.equal(rewriteLink('/img/logo.png', 'intro.md', routes), '/img/logo.png');
  assert.equal(rewriteLink('missing.md', 'intro.md', routes), 'missing.md');
});

test('MDX becomes plain Markdown: imports, tabs, admonitions, cards, comments', () => {
  const md = toMarkdown(page([
    "import Tabs from '@theme/Tabs';",
    '<!-- Generated. -->',
    '<Tabs>',
    '<TabItem value="a" label="Generated form">',
    'Read [First run](first-run.md).',
    '</TabItem>',
    '</Tabs>',
    ':::warning Existing installation',
    'Finish missions first.',
    ':::',
    '<div className="docs-paths">',
    '  <Link className="docs-path" to="/usage/concepts">',
    '    <h2>Use your workspace</h2>',
    '    <p>Set up agents.</p>',
    '  </Link>',
    '</div>',
  ].join('\n'), {description: 'Install on Linux.'}), routes);
  assert.equal(md, [
    '# Linux',
    '',
    '> Install on Linux.',
    '',
    '**Generated form**',
    'Read [First run](/installation/first-run.md).',
    '> **Warning: Existing installation**',
    '>',
    '> Finish missions first.',
    '### [Use your workspace](/usage/concepts.md)',
    'Set up agents.',
    '',
  ].join('\n'));
});

test('code blocks are copied verbatim, placeholders and imports included', () => {
  const body = ['```bash', "import x from 'y';", 'rooks secret set <NAME>', '    <div>kept</div>', '```', 'After [link](first-run.md).'].join('\n');
  const md = toMarkdown(page(body), routes);
  assert.ok(md.includes("```bash\nimport x from 'y';\nnova secret set <NAME>\n    <div>kept</div>\n```"));
  assert.ok(md.includes('After [link](/installation/first-run.md).'));
});

test('an existing H1 is kept instead of a generated one', () => {
  assert.equal(toMarkdown(page('# Interface: Dialect\n\nText'), routes), '# Interface: Dialect\n\nText\n');
});

test('export: order, llms.txt, llms-full.txt and index.json on disk', () => {
  const docs = mkdtempSync(join(tmpdir(), 'md-export-docs-'));
  mkdirSync(join(docs, 'installation'));
  writeFileSync(join(docs, 'intro.md'), '---\ntitle: Home\nslug: /\ndescription: Start here.\n---\nWelcome.\n');
  writeFileSync(join(docs, 'installation', 'linux.md'), '---\ntitle: Linux\n---\nSee [home](../intro.md).\n');
  writeFileSync(join(docs, 'installation', 'macos.md'), '---\ntitle: macOS\n---\nMac.\n');

  const result = exportMarkdown({docsDir: docs, order: ['/', '/installation/macos'], siteUrl: 'https://docs.example'});
  assert.deepEqual(result.pages.map(p => p.route), ['/', '/installation/macos', '/installation/linux']);
  assert.ok(result.llmsTxt.includes('## Start\n\n- [Home](https://docs.example/index.md): Start here.'));
  assert.ok(result.llmsTxt.includes('## Installation\n\n- [macOS](https://docs.example/installation/macos.md)\n- [Linux]'));
  assert.ok(result.llmsFull.includes('Source: https://docs.example/installation/linux\n\n# Linux\n\nSee [home](/index.md).'));

  const out = mkdtempSync(join(tmpdir(), 'md-export-out-'));
  writeExport(result, out, {index: true});
  assert.equal(readFileSync(join(out, 'installation', 'linux.md'), 'utf8'), '# Linux\n\nSee [home](/index.md).\n');
  const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
  assert.deepEqual(index.pages[0], {route: '/', file: 'index.md', title: 'Home', description: 'Start here.', section: 'Start'});
  assert.ok(readFileSync(join(out, 'llms.txt'), 'utf8').startsWith('# Rooks'));
});
