import type { RooksConfig } from '../config/schema.js';
import { isBundledNode } from './bundled-node.js';

export type NodeRuntime = { command: string; env: Record<string, string> };

/**
 * Which Node runs the app (step 5.6.5).
 *
 * `node` is the right answer for a daemon installed on a machine that has
 * Node — that is how it has always run. It is the WRONG answer inside a
 * package: nothing guarantees Node is installed there, and the host adapter
 * would only report that the node binary is not in PATH while the UI never
 * came up. A packaged daemon is itself running on Electron's Node
 * (`ELECTRON_RUN_AS_NODE`) or on the Node the package ships, so it already
 * holds a Node it can hand to its own child — `process.execPath`, the shipped
 * binary. Only Electron needs the flag on that child.
 *
 * `host.binaries.node` wins over both: in a GUI process the inherited PATH is
 * minimal, and naming the binary in `rooks.config.json` is how an operator
 * settles it (`docs/PLAN-MODULAIRE-CROSS-PLATFORM.md` §2, host adapter).
 */
export function nodeRuntime(
  cfg: RooksConfig,
  runtime: { execPath: string; electron?: string | undefined; platform?: NodeJS.Platform } = {
    execPath: process.execPath,
    electron: process.versions.electron,
    platform: process.platform,
  },
): NodeRuntime {
  const configured = cfg.host.binaries['node'];
  if (configured) return { command: configured, env: {} };
  if (runtime.electron) {
    // Explicit, never inherited: the child must be plain Node even if the
    // daemon's own environment ever loses the flag.
    return { command: runtime.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  if (isBundledNode(runtime.execPath, runtime.platform ?? process.platform)) return { command: runtime.execPath, env: {} };
  return { command: 'node', env: {} };
}
