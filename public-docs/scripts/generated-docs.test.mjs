// The generated pages of the public docs must match their sources. They are
// what docs.rooks.local shows and what agents read through docs_search /
// docs_read, and nothing regenerated them on a schedule: the SDK reference
// stayed two contracts behind, the cookbook generator refused to run for weeks
// and the changelog page stopped one release early (TODO #546). Each test
// rebuilds a page from its source and names the command that refreshes it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {renderChangelog} from './gen-changelog.mjs';
import {renderExamples} from './gen-examples.mjs';

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(site, 'docs');
const read = (path) => readFileSync(path, 'utf8');

function markdownFiles(directory) {
  return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : entry.name.endsWith('.md') ? [path] : [];
  });
}

/** Relative paths (with `/`) of the pages that differ, are missing or are extra. */
function treeDifferences(expectedRoot, actualRoot) {
  const list = (root) => existsSync(root)
    ? markdownFiles(root).map((file) => relative(root, file).split(sep).join('/')).sort()
    : [];
  const expected = list(expectedRoot), actual = list(actualRoot);
  const differences = [];
  for (const file of new Set([...expected, ...actual])) {
    if (!expected.includes(file)) differences.push(`extra in the repository: ${file}`);
    else if (!actual.includes(file)) differences.push(`missing from the repository: ${file}`);
    else if (read(join(expectedRoot, file)) !== read(join(actualRoot, file))) differences.push(`outdated: ${file}`);
  }
  return differences;
}

/** Whether the public-docs dependencies a generator imports are installed. */
function installed(name) {
  try {
    createRequire(join(site, 'package.json')).resolve(name);
    return true;
  } catch {
    return false;
  }
}

// TypeDoc takes seconds and ends: on a loaded machine it took 100 s and lost to
// a fixed 90 s budget with nothing wrong (TODO #712). So a generator may use what
// the test wrapper grants this whole file, less a margin to report it.
const GENERATOR_BUDGET_MS = (Number(process.env.ROOKS_TEST_TIMEOUT_MS) || 120_000) - 10_000;

/** Runs a generator with its output redirected under a temporary docs root. */
function generate(script, folders) {
  const out = mkdtempSync(join(tmpdir(), 'rooks-docs-fresh-'));
  for (const folder of folders) mkdirSync(join(out, folder), {recursive: true});
  execFileSync(process.execPath, [join(site, 'scripts', script)], {
    cwd: site,
    env: {...process.env, ROOKS_DOCS_OUT: out, NO_COLOR: '1'},
    stdio: 'pipe',
    timeout: GENERATOR_BUDGET_MS,
  });
  return out;
}

test('the changelog page carries every published release of CHANGELOG.md', () => {
  const expected = renderChangelog(read(resolve(site, '../CHANGELOG.md')));
  assert.ok(
    read(join(docs, 'changelog.md')) === expected,
    'public-docs/docs/changelog.md is outdated: run `npm run gen:changelog` in public-docs',
  );
});

test('the example cookbook lists every package of examples/ with its current excerpts', () => {
  // Throws, naming the package, when examples/ has a package without an entry.
  const expected = renderExamples();
  assert.ok(
    read(join(docs, 'plugins/examples.md')) === expected,
    'public-docs/docs/plugins/examples.md is outdated: run `npm run gen:examples` in public-docs',
  );
});

test('the SDK reference is the one TypeDoc builds from the current SDK', {skip: !installed('docusaurus-plugin-typedoc') && 'public-docs dependencies are not installed'}, () => {
  const out = generate('gen-sdk.mjs', []);
  try {
    const differences = treeDifferences(join(out, 'plugins/api-reference'), join(docs, 'plugins/api-reference'));
    assert.deepEqual(differences, [], `the SDK reference is outdated: run \`npm run gen:sdk\` in public-docs\n${differences.join('\n')}`);
  } finally {
    rmSync(out, {recursive: true, force: true});
  }
});

test('the configuration reference matches the config schema', {skip: !installed('typescript') && 'public-docs dependencies are not installed'}, () => {
  const out = generate('gen-config.mjs', ['installation']);
  try {
    assert.ok(
      read(join(out, 'installation/config-reference.md')) === read(join(docs, 'installation/config-reference.md')),
      'public-docs/docs/installation/config-reference.md is outdated: run `npm run gen:config` in public-docs',
    );
  } finally {
    rmSync(out, {recursive: true, force: true});
  }
});

// gen-cli bounds the CLI with the Unix `timeout` program.
test('the CLI reference matches the CLI usage lines', {skip: (process.platform === 'win32' && 'gen-cli.mjs needs the Unix timeout program') || (!installed('typescript') && 'public-docs dependencies are not installed')}, () => {
  const out = generate('gen-cli.mjs', ['usage']);
  try {
    assert.ok(
      read(join(out, 'usage/cli-reference.md')) === read(join(docs, 'usage/cli-reference.md')),
      'public-docs/docs/usage/cli-reference.md is outdated: run `npm run gen:cli` in public-docs',
    );
  } finally {
    rmSync(out, {recursive: true, force: true});
  }
});

test('the CLI reference headings are unique and never cut inside an argument', () => {
  const headings = [...read(join(docs, 'usage/cli-reference.md')).matchAll(/^### (.+)$/gm)].map((match) => match[1]);
  const repeated = headings.filter((heading, index) => headings.indexOf(heading) !== index);
  assert.deepEqual(repeated, [], `headings written twice: ${repeated.join(', ')}`);
  const cut = headings.filter((heading) => (heading.match(/\[/g) ?? []).length !== (heading.match(/\]/g) ?? []).length);
  assert.deepEqual(cut, [], `headings cut inside an argument: ${cut.join(', ')}`);
});

test('the plugin overview names the contract the daemon implements', () => {
  const version = read(resolve(site, '../orchestrator/src/plugins/manifest.ts')).match(/export const PLUGIN_API_VERSION = (\d+);/)?.[1];
  assert.ok(version, 'PLUGIN_API_VERSION not found in orchestrator/src/plugins/manifest.ts');
  const overview = read(join(docs, 'plugins/overview.md'));
  assert.match(overview, new RegExp(`The current source exports contract \\*\\*${version}\\*\\*\\.`), `plugins/overview.md must say contract **${version}**`);
  assert.match(overview, new RegExp(`API ${version} `), `plugins/overview.md must say what API ${version} added`);
});

test('every written page is reachable from the sidebar', () => {
  const sidebar = read(join(site, 'sidebars.ts'));
  const listed = new Set([...sidebar.matchAll(/"([a-z0-9/-]+)"/g)].map((match) => match[1]));
  const pages = markdownFiles(docs)
    .map((file) => relative(docs, file).split(sep).join('/').replace(/\.md$/, ''))
    // The generated SDK reference is reached through its three index pages.
    .filter((id) => !id.startsWith('plugins/api-reference/') || id.endsWith('/index'));
  const absent = pages.filter((id) => !listed.has(id)).sort();
  assert.deepEqual(absent, [], `pages missing from public-docs/sidebars.ts: ${absent.join(', ')}`);
});
