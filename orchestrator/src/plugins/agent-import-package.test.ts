/**
 * The agent import as a package: what its manifest asks for and opens, that a
 * third-party source adapter's manifest naming its socket is admitted, and
 * that neither its sources nor its shipped modules reach into the product.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readManifest } from './manifest.js';

const PACKAGE = fileURLToPath(new URL('../../../plugins/agent-import', import.meta.url));
const pkg = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as {
  name: string; type: string; main: string; exports: Record<string, string>; dependencies: Record<string, string>; rooks: unknown;
};

test('the manifest is a behavior with a browser half, opening the source socket', () => {
  const read = readManifest(pkg);
  assert.ok(read.ok, read.ok ? '' : read.message);
  const manifest = read.manifest;
  assert.equal(pkg.name, '@rooks/plugin-agent-import');
  assert.equal(pkg.type, 'module', 'tsx and the loader read the sources as ESM');
  assert.equal(pkg.main, 'lib/index.js');
  assert.deepEqual(pkg.exports, { '.': './lib/index.js', './client': './lib/client.js', './hooks': './lib/hooks.js' });
  assert.equal(manifest.id, 'agent-import');
  assert.equal(manifest.apiVersion, 15);
  assert.deepEqual(manifest.kind, ['behavior']);
  // The built-in source for other agent tools occupies the socket like any third-party adapter would.
  assert.deepEqual(manifest.client?.slots, ['settings.section', 'agents.toolbar', 'onboarding.agent', 'agentimport.source', 'bots.rail.action', 'agent.menu.item']);
  assert.deepEqual(manifest.declares, { 'agentimport.source': 'list' });
  assert.equal(manifest.license.required, false);
  assert.ok(pkg.dependencies.fflate, 'the zip reader of part 2 keeps its dependency');
});

test('the permissions are exactly what the engine will use', () => {
  const read = readManifest(pkg);
  assert.ok(read.ok);
  // Each one is justified in docs/PROGRESS.md; adding one is a decision, not a side effect.
  assert.deepEqual([...read.manifest.permissions].sort(), [
    'agents:docs:read', // fingerprint of the documents: a hand edit is not overwritten
    'agents:docs:write', // identity documents (SOUL.md, instructions)
    'agents:export', // the portable definition of the agents an account exports
    'agents:manage', // create the agents, attach skills / MCP servers / team, avatar
    'agents:read', // follow a rename (agent_updated) to keep re-imports idempotent
    'backends:read', // a backend or model of the source missing here is said in the preview
    'events:publish', // agent-import:applied@1
    'events:register', // declare it
    'events:subscribe', // agent_updated
    'kanban:write', // the task action of an imported routine trigger
    'mcp-servers:read', // an id already taken is not overwritten
    'mcp-servers:write', // imported MCP server declarations
    'memory:read', // an exported agent's own rules
    'memory:write', // imported memories as the agent's rules
    'missions:spawn', // a routine enabled at the source runs here too
    'skills:read', // an id already taken is not overwritten
    'skills:write', // imported skills
    'storage', // staged imports, re-import map
    'triggers:write', // imported routines as schedule triggers with their time zone
  ]);
});

test('a third-party source adapter naming the socket is a valid manifest', () => {
  const adapter = {
    name: '@acme/agent-import-source-acme',
    rooks: {
      id: 'acme-import-source',
      apiVersion: 15,
      kind: ['behavior'],
      permissions: [],
      client: { slots: ['agentimport.source'], external: ['react', '@rooks/ui'], mode: 'esm' },
      license: { required: false },
    },
  };
  const read = readManifest(adapter);
  assert.ok(read.ok, read.ok ? '' : read.message);
  assert.deepEqual(read.manifest.client?.slots, ['agentimport.source']);
  // Without `kind`, a plugin naming only this socket is still a behavior.
  const inferred = readManifest({ ...adapter, rooks: { ...adapter.rooks, kind: undefined } });
  assert.ok(inferred.ok);
  assert.deepEqual(inferred.manifest.kind, ['behavior']);
  // The plugin id cannot be the slot name: a slot segment admits no hyphen.
  assert.equal(readManifest({ ...adapter, rooks: { ...adapter.rooks, client: { ...adapter.rooks.client, slots: ['agent-import.source'] } } }).ok, false);
});

test('sources and shipped modules never import product internals', () => {
  function check(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { check(path); continue; }
      if (!/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
      const source = readFileSync(path, 'utf8');
      assert.doesNotMatch(source, /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"][^'"]*(?:app\/|@\/|orchestrator\/src|packages\/sdk)/, path);
    }
  }
  check(join(PACKAGE, 'src'));
  check(join(PACKAGE, 'lib'));
  for (const file of ['client.js', 'hooks.js']) {
    const shipped = readFileSync(join(PACKAGE, 'lib', file), 'utf8');
    // Import lines only: a bundled string such as "agent.from" is not an import.
    const imports = [...shipped.matchAll(/^import .* from\s*["']([^"']+)["']/gm)].map((m) => m[1]);
    assert.ok(imports.length > 0, `${file} imports nothing: the scan no longer sees its imports`);
    assert.ok(imports.every((id) => id === 'react' || id === '@rooks/ui'), `${file} imports: ${imports.join(', ')}`);
    assert.doesNotMatch(shipped, /\bfetch\s*\(/, file);
  }
  const host = readFileSync(join(PACKAGE, 'lib', 'index.js'), 'utf8');
  const hostImports = [...host.matchAll(/^import .* from\s*["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.ok(hostImports.every((id) => id?.startsWith('node:')), `index.js imports: ${hostImports.join(', ')}`);
});
