import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The executable that runs the daemon and its runners, with what it needs in its environment. */
export interface DaemonRuntime {
  readonly execPath: string;
  /** `ELECTRON_RUN_AS_NODE` for Electron used as Node; nothing for a real Node. */
  readonly env: Readonly<Record<string, string>>;
}

/** `resources/node/node[.exe]`: the Node a package ships (`scripts/fetch-node.mjs`). */
export function bundledNodeOf(resourcesPath: string, platform: NodeJS.Platform = process.platform): string {
  return join(resourcesPath, 'node', platform === 'win32' ? 'node.exe' : 'node');
}

/**
 * Who runs the daemon, its app, its CLI and the runners the shell starts.
 *
 * A package runs them on the Node it ships: Electron 33's own Node (20) has no
 * `node:sqlite`, which third-party plugins need, and the package's Electron no
 * longer runs as Node at all (`RunAsNode` fuse off, TODO #764). A package
 * without its Node therefore has nothing to start the daemon with: it says so
 * (the shell turns the error into its startup dialog) rather than launching a
 * second window in place of a daemon. From the sources, Electron runs them as
 * plain Node, as it always did.
 */
export function daemonRuntime(input: {
  packaged: boolean;
  resourcesPath: string;
  electronExecPath: string;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
}): DaemonRuntime {
  if (!input.packaged) return { execPath: input.electronExecPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  const node = bundledNodeOf(input.resourcesPath, input.platform ?? process.platform);
  if (!(input.exists ?? existsSync)(node)) {
    throw new Error(`The Node this package ships is missing: expected at ${node}. This build is incomplete, reinstall it.`);
  }
  return { execPath: node, env: {} };
}

/**
 * `base` with the runtime's own variables: `ELECTRON_RUN_AS_NODE` is set for
 * Electron and removed for a real Node, never inherited by accident.
 */
export function withRuntimeEnv(base: NodeJS.ProcessEnv, runtime: DaemonRuntime): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key];
  }
  return { ...env, ...runtime.env };
}
