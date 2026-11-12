/**
 * Proves that a packaged app directory can start its compiled entry points.
 *
 * The desktop package ships the traced `.next/standalone` of the app, not its
 * whole `node_modules` (25 000 files, each scanned by Windows Defender while
 * the installer writes it). A package a compiled entry requires but the trace
 * left out would only show at runtime, on a tester's machine: checked here,
 * it fails the build instead.
 */
import { builtinModules, createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

const BUILTINS = new Set(builtinModules);

/** Bare package names a compiled CommonJS file requires (`require("next")`,
 *  `require("next/dist/x")` → `next`). Builtins and relative paths excluded. */
export function externalRequires(source) {
  const names = new Set();
  for (const match of source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
    const spec = match[1];
    if (spec.startsWith('.') || spec.startsWith('node:') || isAbsolute(spec) || BUILTINS.has(spec)) continue;
    const parts = spec.split('/');
    names.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
  }
  return [...names].sort();
}

/** Every package the entries require must resolve from `appDir`'s own
 *  `node_modules`. Throws with the full list of what is missing. */
export function assertEntriesResolve(appDir, entries) {
  const req = createRequire(join(appDir, 'package.json'));
  const missing = [];
  for (const file of entries) {
    for (const name of externalRequires(readFileSync(file, 'utf8'))) {
      try {
        req.resolve(name);
      } catch {
        missing.push(`${name} (required by ${basename(file)})`);
      }
    }
  }
  if (missing.length) throw new Error(`${appDir} lacks: ${missing.join(', ')}`);
}
