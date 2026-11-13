#!/usr/bin/env node
/**
 * Builds the three entry points of the SDK (`@rooks/sdk`, `/provider`,
 * `/testing`) into `dist/`: JavaScript and declarations, nothing else, with the
 * compiler of the repository (no dependency is added to the package for it),
 * plus `dist/ui.d.ts` (`@rooks/sdk/ui`), copied as is.
 *
 *   node scripts/build.mjs [--out <dir>]
 *
 * The output keeps the repository's layout (`dist/packages/sdk/src/…`,
 * `dist/orchestrator/src/…`): the entries re-export modules that live in the
 * daemon's tree but reach nothing else of it. The provider kit's closure is
 * pinned by `orchestrator/src/backends/sdk-closure.test.ts`; the main entry's
 * (the hand-written contract in `plugins/contract/`, two type-only doors to the
 * provider kit and Express's `Router`) by `plugins/contract-imports.test.ts`.
 * `exports` in `package.json` hides the paths from the consumer. The only value
 * the main entry carries is `PLUGIN_API_VERSION` (and its alias `apiVersion`).
 *
 * `ui.d.ts` only declares ambient modules (`@rooks/ui`, …) that the daemon
 * serves to the browser: `tsc` never emits a declaration file it reads, hence
 * the copy.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productCredentialDirs, render, TARGET } from './gen-product-credential-dirs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(HERE, '..');

/** The compiler: `ROOKS_TSC` if set, else the repository's own. */
function compiler() {
  const candidates = [
    process.env.ROOKS_TSC,
    join(PACKAGE, '..', '..', 'orchestrator', 'node_modules', 'typescript', 'bin', 'tsc'),
    join(PACKAGE, 'node_modules', 'typescript', 'bin', 'tsc'),
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    console.error('No TypeScript compiler found. Set ROOKS_TSC to the path of tsc, or build from a checkout that has orchestrator/node_modules.');
    process.exit(1);
  }
  return found;
}

/**
 * The package carries the product's sign-in folders as a copy of the official manifests
 * (`src/product-credential-dirs.ts`): a stale copy would let a provider's own test accept a
 * folder the daemon refuses, so it is never published.
 */
function assertCredentialDirsFresh() {
  if (readFileSync(TARGET, 'utf8') !== render(productCredentialDirs())) {
    console.error(`${TARGET} is stale: run \`node packages/sdk/scripts/gen-product-credential-dirs.mjs\`.`);
    process.exit(1);
  }
}

export function build(outDir = join(PACKAGE, 'dist')) {
  assertCredentialDirsFresh();
  rmSync(outDir, { recursive: true, force: true });
  const result = spawnSync(process.execPath, [compiler(), '-p', join(PACKAGE, 'tsconfig.build.json'), '--outDir', outDir], {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error('The SDK did not build.');
    process.exit(result.status ?? 1);
  }
  copyFileSync(join(PACKAGE, 'src', 'ui.d.ts'), join(outDir, 'ui.d.ts'));
  return outDir;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--out');
  const out = build(at > 0 ? resolve(process.argv[at + 1] ?? '') : undefined);
  console.log(`@rooks/sdk built into ${out}`);
}
