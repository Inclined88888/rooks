/**
 * The leaves of `plugins/contract/` are the public plugin contract: the SDK entry
 * names them, and a leaf that imports the daemon drags the daemon into every
 * plugin's types (TODO #512, volet 3). So a leaf imports other leaves, and
 * nothing else, except through two doors pinned below by name. Both are
 * mandated, not exceptions waiting for a cleanup: arbitrated on 2026-10-29
 * (TODO #512, volet 3), see `MANDATED_DOORS`.
 *
 *   - `provider-kit.ts` re-exports provider kit types, from modules the published
 *     `@rooks/sdk/provider` already reaches (its closure is pinned by
 *     `backends/sdk-closure.test.ts`);
 *   - `http.ts` re-exports Express's `Router`, what `ctx.router()` returns.
 *
 * Every form a module can be named in counts: `import`, `export … from`,
 * `import('…')` in a type position, and a dynamic `import()` or `require()`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const CONTRACT = join(import.meta.dirname, 'contract');
const REPO = resolve(import.meta.dirname, '..', '..', '..');
const rel = (p: string): string => relative(REPO, p).split('\\').join('/');

/**
 * The only modules a leaf may name outside `contract/`, per door. A closed list,
 * arbitrated 2026-10-29 (TODO #512, volet 3):
 *   - the provider door re-exports the published provider kit rather than copying
 *     its ~130 declarations (a second source of truth for a frozen contract) or
 *     moving them (a change to `@rooks/sdk/provider`'s layout);
 *   - the HTTP door keeps Express's `Router`: a structural interface would narrow
 *     the public contract. The published package declares `@types/express` (volet 5).
 * A third door is a new decision, not an edit of this list.
 */
const MANDATED_DOORS: Record<string, readonly string[]> = {
  'provider-kit.ts': [
    'orchestrator/src/backends/catalog-model.ts',
    'orchestrator/src/backends/provider-plugin-context.ts',
    'orchestrator/src/backends/reasoning-control.ts',
    'orchestrator/src/backends/types.ts',
  ],
  'http.ts': ['express'],
};

type Reference = { specifier: string; typeOnly: boolean };

/** Every module specifier a source file names, and whether the naming is type-only. */
function references(file: string): Reference[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: Reference[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly = !clause || clause.isTypeOnly
        || (!clause.name && !!clause.namedBindings && ts.isNamedImports(clause.namedBindings)
          && clause.namedBindings.elements.every((e) => e.isTypeOnly));
      // A bare `import 'x'` runs x: never type-only.
      found.push({ specifier: node.moduleSpecifier.text, typeOnly: !!clause && typeOnly });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = node.isTypeOnly
        || (!!node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.every((e) => e.isTypeOnly));
      found.push({ specifier: node.moduleSpecifier.text, typeOnly });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      found.push({ specifier: node.argument.literal.text, typeOnly: true });
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      found.push({ specifier: node.arguments[0].text, typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** A relative specifier as a repository path (`.js` written for a `.ts` source); a package name as is. */
function target(from: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier;
  const resolved = resolve(dirname(from), specifier);
  const source = resolved.replace(/\.js$/, '.ts');
  return rel(existsSync(source) ? source : resolved);
}

const leaves = readdirSync(CONTRACT).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort();

test('a contract leaf names only other leaves, or what its door allows', () => {
  const contractDir = rel(CONTRACT) + '/';
  const stray: string[] = [];
  for (const leaf of leaves) {
    const file = join(CONTRACT, leaf);
    for (const { specifier } of references(file)) {
      const to = target(file, specifier);
      if (to.startsWith(contractDir) && !to.slice(contractDir.length).includes('/')) continue;
      if (MANDATED_DOORS[leaf]?.includes(to)) continue;
      stray.push(`${leaf} → ${specifier}`);
    }
  }
  assert.deepEqual(stray, [], 'the plugin contract reaches the daemon. Spell the type out in a leaf (see type-equality.ts for the guard), or take a new decision: the doors are a closed list (MANDATED_DOORS).');
});

test('the doors only re-export types', () => {
  for (const door of Object.keys(MANDATED_DOORS)) {
    const file = join(CONTRACT, door);
    assert.ok(existsSync(file), `door ${door} is gone: remove it from MANDATED_DOORS so the list stays the truth`);
    const refs = references(file);
    assert.ok(refs.length > 0, `door ${door} names nothing: remove it from MANDATED_DOORS`);
    assert.deepEqual(refs.filter((r) => !r.typeOnly).map((r) => r.specifier), [], `${door} carries a value: a door lets types through, never code`);
    const named = new Set(refs.map((r) => target(file, r.specifier)));
    assert.deepEqual(MANDATED_DOORS[door].filter((t) => !named.has(t)), [], `${door} no longer names these: remove them from MANDATED_DOORS`);
  }
});

/** The modules `@rooks/sdk/provider` and `/testing` reach (same walk as `backends/sdk-closure.test.ts`). */
function providerKitClosure(): Set<string> {
  const files = new Set<string>();
  const queue = ['packages/sdk/src/provider.ts', 'packages/sdk/src/testing.ts'].map((e) => resolve(REPO, e));
  for (const entry of queue) files.add(entry);
  while (queue.length) {
    const file = queue.shift()!;
    for (const { fileName } of ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles) {
      if (!fileName.startsWith('.')) continue;
      let next = resolve(dirname(file), fileName).replace(/\.js$/, '.ts');
      if (!existsSync(next)) next = resolve(dirname(file), fileName, 'index.ts');
      if (existsSync(next) && !files.has(next)) { files.add(next); queue.push(next); }
    }
  }
  return new Set([...files].map(rel));
}

test('the provider door opens only onto the published provider kit', () => {
  const kit = providerKitClosure();
  const outside = MANDATED_DOORS['provider-kit.ts'].filter((t) => !kit.has(t));
  assert.deepEqual(outside, [], 'the provider door names a module the provider kit does not publish: its closure is not vetted');
});

/**
 * The closure of the SDK entry `@rooks/sdk` (TODO #512, volet 4): what a plugin
 * author's compiler loads when it imports the contract. Up to the doors, it is
 * pinned edge by edge: the entry and its own dictation types, the leaves, and
 * the door targets, each named by its door. Beyond the provider door, the
 * modules are those of the published provider kit, whose closure
 * `backends/sdk-closure.test.ts` pins; they are checked to stay inside it, and
 * nowhere in the walk may the daemon show up.
 */
const SDK_ENTRY = resolve(REPO, 'packages/sdk/src/index.ts');
const CONTRACT_DIR = rel(CONTRACT) + '/';
const isLeaf = (to: string): boolean => to.startsWith(CONTRACT_DIR) && !to.slice(CONTRACT_DIR.length).includes('/');

/**
 * Before any door, who may name what outside `contract/`: the entry its own
 * dictation types, and each door its targets — nobody else, not even the
 * entry, so a door target is always reached through its door. Leaves may be
 * named by anyone. Adding to this map is a decision.
 */
const ENTRY_EDGES: Record<string, readonly string[]> = {
  'packages/sdk/src/index.ts': ['packages/sdk/src/dictation.ts'],
  'packages/sdk/src/dictation.ts': [],
  ...Object.fromEntries(Object.entries(MANDATED_DOORS).map(([door, targets]) => [CONTRACT_DIR + door, targets])),
};

/**
 * Never in the entry's closure, even behind a door: the daemon's database,
 * licences, vault, host adapter and kernel. `secrets/redact.ts` is the one leaf
 * of `secrets/` the provider kit ships (dependency-free, vetted in
 * `backends/sdk-closure.test.ts`).
 */
const FORBIDDEN = [/^orchestrator\/src\/db(\.ts|\/)/, /^orchestrator\/src\/license\//, /^orchestrator\/src\/secrets\/(?!redact\.ts$)/,
  /^orchestrator\/src\/host\//, /^orchestrator\/src\/kernel\//, /^@deepseek-ai\/cordis/, /^better-sqlite3$/, /^zod(\/|$)/];

/**
 * Every module the SDK entry reaches: the edges walked before any door target,
 * and what lies beyond the door targets (first namer of each).
 */
function entryClosure(): { edges: Array<[from: string, to: string]>; beyond: Map<string, string> } {
  const edges: Array<[string, string]> = [];
  const beyond = new Map<string, string>();
  const doorTargets = new Set(Object.values(MANDATED_DOORS).flat());
  const walked = new Set<string>([rel(SDK_ENTRY)]);
  const queue: Array<{ file: string; crossed: boolean }> = [{ file: SDK_ENTRY, crossed: false }];
  while (queue.length) {
    const { file, crossed } = queue.shift()!;
    const from = rel(file);
    const behindDoor = crossed || doorTargets.has(from);
    for (const { specifier } of references(file)) {
      const to = target(file, specifier);
      if (behindDoor) {
        if (!walked.has(to) && !beyond.has(to)) beyond.set(to, from);
      } else {
        edges.push([from, to]);
      }
      if (walked.has(to)) continue;
      walked.add(to);
      if (specifier.startsWith('.') && existsSync(resolve(REPO, to))) queue.push({ file: resolve(REPO, to), crossed: behindDoor });
    }
  }
  return { edges, beyond };
}

test('the SDK entry reaches only contract leaves, and the door targets through their door', () => {
  const { edges } = entryClosure();
  const stray = edges.filter(([from, to]) => !isLeaf(to) && !ENTRY_EDGES[from]?.includes(to));
  assert.deepEqual(stray.map(([from, to]) => `${from} → ${to}`), [],
    'the SDK entry names a module outside plugins/contract/. Name it through a leaf (spell the type out, guard it with type-equality.ts), or take a new decision: the doors are a closed list.');
  const missing = Object.entries(ENTRY_EDGES).flatMap(([from, targets]) => targets.map((to) => [from, to] as const))
    .filter(([from, to]) => !edges.some(([f, t]) => f === from && t === to));
  assert.deepEqual(missing.map(([from, to]) => `${from} → ${to}`), [], 'pinned edges the SDK entry no longer walks: remove them so the list stays the truth');
});

test('beyond the provider door, the SDK entry reaches only the published provider kit', () => {
  const { beyond } = entryClosure();
  const kit = providerKitClosure();
  const outside = [...beyond].filter(([to]) => to.startsWith('orchestrator/') || to.startsWith('packages/'))
    .filter(([to]) => !kit.has(to));
  assert.deepEqual(outside.map(([to, from]) => `${to} (named by ${from})`), [], 'the provider door leads outside the vetted provider kit');
  const packages = [...beyond.keys()].filter((to) => !to.startsWith('orchestrator/') && !to.startsWith('packages/') && !to.startsWith('node:'));
  assert.deepEqual(packages, [], 'a package joined the provider kit types the SDK entry exposes');
});

test('the SDK entry never reaches the daemon, even behind a door', () => {
  const { edges, beyond } = entryClosure();
  const reached: Array<[from: string, to: string]> = [...edges, ...[...beyond].map(([to, from]) => [from, to] as [string, string])];
  const forbidden = reached.filter(([, to]) => FORBIDDEN.some((re) => re.test(to)));
  assert.deepEqual(forbidden.map(([from, to]) => `${to} (named by ${from})`), [], 'the SDK entry drags the daemon into every plugin');
});
