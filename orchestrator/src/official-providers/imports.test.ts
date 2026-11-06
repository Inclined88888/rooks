/**
 * An official provider is written like a third-party one (`docs/PROVIDERS-SDK.md` § 12.1):
 * against `ctx.provider` and nothing else. The day a provider imports `orchestrator/src`
 * it stops being a plugin and becomes core code in the wrong directory, and a fix the SDK
 * lacks is hidden instead of added to it.
 *
 * The guard reads every provider listed in `builtin-plugins.json` and refuses any import
 * specifier that is not a Node built-in, the SDK, or a file inside the plugin's own package.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const { readBuiltinList } = await import('../plugins/builtin.js');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const STATIC_IMPORT = /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every module specifier a source text imports, comments excluded. */
export function importSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [...[...code.matchAll(STATIC_IMPORT)], ...[...code.matchAll(DYNAMIC_IMPORT)]].map((match) => match[1]!);
}

/** Why `specifier`, imported from `file` of the package at `dir`, is not allowed; null when it is. */
export function importProblem(specifier: string, file: string, dir: string): string | null {
  if (specifier.startsWith('node:')) return null;
  if (specifier === '@timon-ai/sdk' || specifier.startsWith('@timon-ai/sdk/')) return null;
  if (specifier.startsWith('.') || isAbsolute(specifier)) {
    const target = resolve(dirname(file), specifier);
    const rel = relative(dir, target);
    return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
      ? `\`${specifier}\` leaves the plugin's package (a missing SDK facade is added to the SDK, never reached around)`
      : null;
  }
  return `\`${specifier}\` is neither a Node built-in nor the SDK`;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules') return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:js|mjs|cjs|ts|mts)$/.test(name) ? [path] : [];
  });
}

function isProviderPackage(dir: string): boolean {
  try {
    const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { timon?: { kind?: string | string[] } };
    const kind = json.timon?.kind;
    return Array.isArray(kind) ? kind.includes('provider') : kind === 'provider';
  } catch {
    return false;
  }
}

test('the guard itself: what it lets through and what it refuses', () => {
  const dir = join(ROOT, 'official-providers', 'x');
  const file = join(dir, 'lib', 'index.js');
  const source = [
    "import { join } from 'node:path';",
    "import type { X } from '@timon-ai/sdk/provider';",
    "import { y } from './grok.js';",
    "export { z } from '../lib/other.js';",
    "const a = await import('../../../src/backends/types.js');",
    "const b = require('express');",
    "// import { c } from '../../src/agent.js';",
  ].join('\n');
  const found = importSpecifiers(source);
  assert.deepEqual(found, [
    'node:path', '@timon-ai/sdk/provider', './grok.js', '../lib/other.js', '../../../src/backends/types.js', 'express',
  ]);
  assert.deepEqual(found.map((specifier) => importProblem(specifier, file, dir) === null), [true, true, true, true, false, false]);
});

/** The provider templates of `examples/` that carry code: written as a third party writes, so held to the same rule. */
function exampleProviders(): Array<{ name: string; dir: string }> {
  const examples = resolve(ROOT, '..', 'examples');
  return readdirSync(examples)
    .map((name) => ({ name, dir: join(examples, name) }))
    .filter(({ dir }) => isProviderPackage(dir) && existsSync(join(dir, 'lib')));
}

test('the provider templates of examples/ import only Node built-ins and the SDK, and Cursor is one of them', () => {
  const found = exampleProviders();
  assert.ok(found.some(({ name }) => name === 'plugin-provider-cursor'), 'the Cursor template is covered');
  for (const { name, dir } of found) {
    const problems = sourceFiles(dir).flatMap((file) =>
      importSpecifiers(readFileSync(file, 'utf8')).flatMap((specifier) => {
        const problem = importProblem(specifier, file, dir);
        return problem ? [`${relative(dir, file)}: ${problem}`] : [];
      }));
    assert.deepEqual(problems, [], `${name} reaches around the SDK`);
  }
});

test('every official provider imports only Node built-ins and the SDK', () => {
  const providers = readBuiltinList(ROOT).filter(({ source }) => isProviderPackage(resolve(ROOT, source)));
  assert.ok(providers.some((p) => p.pkg === '@timon-ai/provider-claude'));
  assert.ok(providers.some((p) => p.pkg === '@timon-ai/provider-kimi'));
  for (const { pkg, source } of providers) {
    const dir = resolve(ROOT, source);
    assert.ok(existsSync(dir), `${pkg}: ${dir} is missing`);
    const problems = sourceFiles(dir).flatMap((file) =>
      importSpecifiers(readFileSync(file, 'utf8')).flatMap((specifier) => {
        const problem = importProblem(specifier, file, dir);
        return problem ? [`${relative(dir, file)}: ${problem}`] : [];
      }));
    assert.deepEqual(problems, [], `${pkg} reaches around the SDK`);
  }
});
