import ts from 'typescript';
import {createRequire} from 'node:module';
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {tmpdir} from 'node:os';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {applyRewrites, assertPublishable, isExcluded, reportUnusedRewrites} from './doc-policy.mjs';
const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryHome = mkdtempSync(join(tmpdir(), 'rooks-docs-config-'));
process.env.ROOKS_HOME = temporaryHome;
try {
  // Load only the pure schema, never config/load.ts (which accesses the instance).
  const require = createRequire(resolve(site, '../orchestrator/package.json'));
  const source = readFileSync(resolve(site, '../orchestrator/src/config/schema.ts'), 'utf8');
  // Since 12/09/2026 the schema derives `daemon.installDir` from its own
  // location (`import.meta.url`), which a CommonJS sandbox cannot evaluate. The
  // generator hands it a fictitious module URL: the value is never published
  // (see the `daemon.installDir` row below), it only has to be computable.
  const esmFree = source.replaceAll('import.meta.url', '__schemaModuleUrl');
  const compiled = ts.transpileModule(esmFree, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  const exports = {};
  const allowed = new Set(['zod', 'node:path', 'node:url', 'node:net']);
  runInNewContext(compiled, {exports, __schemaModuleUrl: 'file:///rooks/orchestrator/src/config/schema.ts', require: name => {
    if (!allowed.has(name)) throw new Error(`Unexpected schema dependency: ${name}`);
    return require(name);
  }}, {timeout: 5000});
  const schema = exports.RooksConfigSchema;
  const json = schema.toJSONSchema({io: 'input'});
  const defaults = JSON.parse(JSON.stringify(schema.parse({})));
  const loader = readFileSync(resolve(site, '../orchestrator/src/config/load.ts'), 'utf8');
  const syntax = ts.createSourceFile('load.ts', loader, ts.ScriptTarget.Latest, true);
  const overrides = new Map();
  function findOverrides(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(syntax) === 'ENV_OVERRIDES') {
      if (!node.initializer || !ts.isArrayLiteralExpression(node.initializer)) throw new Error('ENV_OVERRIDES is no longer a literal array');
      for (const item of node.initializer.elements) {
        if (!ts.isObjectLiteralExpression(item)) throw new Error('Nonliteral environment mapping');
        const fields = Object.fromEntries(item.properties.map(property => {
          if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.initializer)) throw new Error('Nonliteral environment mapping');
          return [property.name.getText(syntax), property.initializer.text];
        }));
        overrides.set(fields.path, fields.key);
      }
    }
    ts.forEachChild(node, findOverrides);
  }
  findOverrides(syntax);
  if (!overrides.size) throw new Error('Missing environment override table');
  const cell = value => String(value).replaceAll('|', '&#124;').replaceAll('\n', ' ');
  function type(node) {
    if (node.enum) return node.enum.map(value => JSON.stringify(value)).join(' | ');
    if ('const' in node) return JSON.stringify(node.const);
    if (node.anyOf) return node.anyOf.map(type).join(' | ');
    if (node.type === 'array') return `${type(node.items)}[]`;
    return Array.isArray(node.type) ? node.type.join(' | ') : node.type ?? 'unknown';
  }
  const rows = [];
  const usedRewrites = new Set();
  function walk(node, path, value) {
    if (path) {
      // Publication policy: an excluded key hides its children too.
      if (isExcluded('configKeys', path)) return;
      if (!node.description) throw new Error(`Missing schema description: ${path}`);
      let displayDefault = value === undefined ? 'Not set' : JSON.stringify(value);
      // The default is the directory of the running daemon's own code: a
      // machine path, never published. Its meaning is.
      if (path === 'daemon.installDir') displayDefault = "Directory of the running daemon's code";
      if (node.properties) displayDefault = 'See child fields';
      const description = applyRewrites(node.description, 'config', usedRewrites);
      rows.push(`| \`${path}\` | ${cell(type(node))} | ${cell(displayDefault)} | ${cell(description.text)} | ${overrides.has(path) ? '`'+overrides.get(path)+'`' : path === 'settings' ? 'Same key as each registry setting' : '—'} |`);
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) walk(child, path ? `${path}.${key}` : key, value?.[key]);
  }
  walk(json, '', defaults);
  reportUnusedRewrites(usedRewrites, 'config');
  const page = `---\ntitle: Configuration reference\nsidebar_position: 11\n---\n\n<!-- Generated file. Do not edit by hand. Run npm run gen:config. -->\n\nGenerated from the configuration schema and the loader's environment override table. Defaults below are parsed from an empty configuration, before edition presets, user values and environment overrides. Nested defaults account for parent prefaults (the app port is 3100).\n\n\`ROOKS_HOME\` selects the data directory; it is not a schema field. A dash means no direct bootstrap environment override is declared for that field. Registry settings use their own names as environment keys. The installation-directory default is described rather than copied: it is wherever the running daemon's code lives, so a packaged install needs no value.\n\n| Key | Type | Default | Description | Environment |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\nRecord-valued fields accept arbitrary keys within their declared value type. Module and plugin entries accept a boolean, \`"auto"\`, or an options object with optional \`enabled\`; registry values accept strings, numbers and booleans. See [Configuration](configuration.md) for precedence and safe installation examples.\n`;
  assertPublishable(page, 'docs/installation/config-reference.md');
  writeFileSync(resolve(process.env.ROOKS_DOCS_OUT || resolve(site, 'docs'), 'installation/config-reference.md'), page);
} finally {
  rmSync(temporaryHome, {recursive: true, force: true});
}
