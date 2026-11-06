/**
 * What names a machine, shared by the server resolver (`target.ts`) and the
 * browser (`machine-storage.ts`). Kept free of any server import so a client
 * component can load it: `target.ts` pulls `next/headers`.
 */

/** The id of the daemon this app belongs to. */
export const LOCAL_MACHINE_ID = 'local';

const MACHINE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** True for a well-formed machine id. A malformed one is ignored, never trusted. */
export function isMachineId(value: string): boolean {
  return MACHINE_ID.test(value);
}

/**
 * Header naming the machine a request answers for, ahead of the
 * `timon_machine` cookie (`machineIdFromRequest` in `target.ts`): a desktop
 * window pinned to one machine, a permission resolved from a push
 * notification (`public/sw.js`, which spells it out: a static worker imports
 * nothing). An id, never a URL; it grants nothing — the machine must still be
 * one of the local session's. A custom header cannot ride a cross-site request
 * without a CORS preflight nobody answers, the remote relay still demands
 * same-origin, and the header itself never leaves for a remote daemon.
 */
export const MACHINE_HEADER = 'x-timon-machine';
