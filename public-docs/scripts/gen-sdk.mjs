import plugin from 'docusaurus-plugin-typedoc';
import {mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, resolve, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertPublishable} from './doc-policy.mjs';
const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryHome = mkdtempSync(join(tmpdir(), 'timon-docs-sdk-'));
process.env.TIMON_HOME = temporaryHome;
// `TIMON_DOCS_OUT` writes the pages under another docs root: the freshness test
// (`generated-docs.test.mjs`) compares that copy with the committed one.
const root = resolve(process.env.TIMON_DOCS_OUT || resolve(site, 'docs'), 'plugins/api-reference');
/**
 * One TypeDoc run per public entry point of `@timon-ai/sdk`. Separate runs keep
 * the main entry's page paths stable (`api-reference/type-aliases/X.md`, linked
 * from the guides) and give each sub-path its own folder; a single multi-entry
 * run would move every main-entry page under a module folder.
 */
const entries = [
  {name: '@timon-ai/sdk', source: 'index.ts', folder: ''},
  {name: '@timon-ai/sdk/provider', source: 'provider.ts', folder: 'provider'},
  {name: '@timon-ai/sdk/testing', source: 'testing.ts', folder: 'testing'},
];
function annotate(directory) {
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) annotate(path);
    else if (entry.name.endsWith('.md')) {
      const text = readFileSync(path, 'utf8');
      const note = '\n<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->\n\n';
      const end = text.startsWith('---\n') ? text.indexOf('\n---', 4) + 4 : 0;
      writeFileSync(path, text.slice(0, end) + note + text.slice(end));
    }
  }
}
function markdownFiles(directory) {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : entry.name.endsWith('.md') ? [path] : [];
  });
}
try {
  rmSync(root, {recursive: true, force: true});
  for (const entry of entries) {
    const out = join(root, entry.folder);
    await plugin({siteDir: site, siteConfig: {presets: [['classic', {docs: {path: 'docs'}}]]}}, {
      entryPoints: [resolve(site, '../packages/sdk/src', entry.source)],
      tsconfig: resolve(site, '../packages/sdk/tsconfig.json'),
      out,
      name: entry.name,
      readme: 'none',
      entryFileName: 'index.md',
      plugin: [resolve(site, 'scripts/typedoc-public.mjs')],
      sidebar: {autoConfiguration: false},
      excludePrivate: true,
      excludeProtected: true,
      excludeExternals: true,
      disableSources: false,
      gitRevision: 'HEAD',
      validation: {notExported: false},
    });
    if (!existsSync(join(out, 'index.md'))) throw new Error(`TypeDoc did not produce the ${entry.name} entry page`);
  }
  annotate(root);
  // A type reaching the SDK through a .d.ts can drag daemon internals into the
  // reference: the publication policy must hold for it as for the CLI and config references.
  for (const file of markdownFiles(root)) assertPublishable(readFileSync(file, 'utf8'), join('docs/plugins/api-reference', relative(root, file)));
} finally {
  rmSync(temporaryHome, {recursive: true, force: true});
}
