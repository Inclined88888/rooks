import { existsSync } from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';

/**
 * Copy of `isBundledNode` (`src/host/bundled-node.ts`): this file runs before
 * anything is loaded, under whatever Node reached `bin/rooks`, and cannot
 * import the compiled sources. `src/cli-runtime.test.ts` holds the two
 * together.
 */
export function isBundledNode(execPath, platform = process.platform) {
  const path = platform === 'win32' ? win32 : posix;
  const exe = path.basename(execPath).toLowerCase();
  if (exe !== (platform === 'win32' ? 'node.exe' : 'node')) return false;
  const dir = path.dirname(execPath);
  return path.basename(dir).toLowerCase() === 'node'
    && path.basename(path.dirname(dir)).toLowerCase() === 'resources';
}

/**
 * The package's CLI launcher, when `bin/rooks` runs inside a desktop package
 * under a Node that is not the app's runtime: `better-sqlite3` and the other
 * native modules are built for the app's Electron, and the system Node crashed
 * on them (tester report, 27/09/2026). The service puts `<installDir>/bin` on
 * the PATH of every agent, so `rooks` reached this file through its shebang.
 *
 * The launcher sits at the package root, `cli/rooks` (`Contents/cli/rooks` in
 * a macOS bundle) and runs this file with the app's executable. A source
 * checkout has none, and keeps its own Node. Windows is left out: there the
 * PATH reaches `cli\rooks.cmd`, never this extensionless file.
 *
 * Already on the package's runtime (Electron, or the Node it ships): the
 * launcher would only start this same runtime again.
 */
export function packagedLauncher(binFile, {
  versions = process.versions, env = process.env, platform = process.platform, exists = existsSync, execPath = process.execPath,
} = {}) {
  if (platform === 'win32' || versions.electron || isBundledNode(execPath, platform) || env.ROOKS_CLI_REEXEC === '1') return null;
  // <root>/resources/orchestrator/bin/rooks, or <App>.app/Contents/Resources/…
  const root = dirname(dirname(dirname(dirname(binFile))));
  const launcher = join(root, 'cli', 'rooks');
  return exists(launcher) ? launcher : null;
}
