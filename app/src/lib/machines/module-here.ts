/**
 * Whether the Machines module runs on THIS computer — the one place a code
 * from another machine can be entered — for core screens that point to it
 * (Settings → Devices) without importing the plugin.
 *
 * Same rule as the mounting of its client half (`plugins-client/mount.ts`,
 * `anchoredLocally`): a remote machine is only ever active through the local
 * module, so there it runs here; on this computer the capabilities at hand
 * are the local daemon's, and only an entry that names it active counts.
 */
import type { Capabilities } from '../capabilities';
import { moduleOffCause, type ModuleOffCause } from '../module-off-reason';
import { MACHINES_MODULE } from './fleet';

export type MachinesHere =
  | { on: true }
  | { on: false; cause: ModuleOffCause; reason: string | null };

/** `null` while the capabilities are not loaded: no verdict on a guess. */
export function machinesModuleHere(caps: Capabilities | null, remote: boolean): MachinesHere | null {
  if (remote) return { on: true };
  if (caps === null) return null;
  const entry = caps.modules.find((module) => module.id === MACHINES_MODULE);
  if (entry?.active === true) return { on: true };
  const reason = entry?.reason ?? null;
  return { on: false, cause: moduleOffCause(reason), reason };
}
