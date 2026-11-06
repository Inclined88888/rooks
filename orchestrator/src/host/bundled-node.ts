import { posix, win32 } from 'node:path';

/**
 * Is this the Node a desktop package ships next to its app, rather than a Node
 * installed on the machine? The package lays it out as
 * `<root>/resources/node/node[.exe]` (Linux, Windows and a staged release) or
 * `<App>.app/Contents/Resources/node/node` (macOS); a source checkout runs a
 * system Node (`/usr/bin/node`, `…/nodejs/node.exe`, an nvm `bin/node`), whose
 * parent folder is never `node` under `resources`.
 *
 * The executable path decides, not an environment variable: a variable would
 * leak into every mission CLI the daemon starts, while `process.execPath` is a
 * property of the runtime itself, as `process.versions.electron` was.
 */
export function isBundledNode(execPath: string, platform: NodeJS.Platform = process.platform): boolean {
  const path = platform === 'win32' ? win32 : posix;
  const exe = path.basename(execPath).toLowerCase();
  if (exe !== (platform === 'win32' ? 'node.exe' : 'node')) return false;
  const dir = path.dirname(execPath);
  return path.basename(dir).toLowerCase() === 'node'
    && path.basename(path.dirname(dir)).toLowerCase() === 'resources';
}

/** What `packagedRuntime` reads of the running process. */
export interface RuntimeFacts {
  readonly execPath: string;
  readonly versions: NodeJS.ProcessVersions;
  readonly platform: NodeJS.Platform;
}

const currentRuntime = (): RuntimeFacts => ({ execPath: process.execPath, versions: process.versions, platform: process.platform });

/**
 * Does this process run on a desktop package's runtime: Electron used as Node
 * (`ELECTRON_RUN_AS_NODE`), or the Node the package ships? This is the
 * question "am I installed from a package", independent of which of the two
 * runtimes the package uses.
 *
 * Not to be confused with "is this Electron": only Electron needs
 * `ELECTRON_RUN_AS_NODE` on a child it starts with its own executable, and
 * only Electron virtualises ASAR paths. Those checks keep reading
 * `process.versions.electron`.
 */
export function packagedRuntime(runtime: RuntimeFacts = currentRuntime()): boolean {
  return Boolean(runtime.versions.electron) || isBundledNode(runtime.execPath, runtime.platform);
}
