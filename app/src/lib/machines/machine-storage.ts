/**
 * Browser state that belongs to one machine (TODO #329, palier P3e).
 *
 * The interface switches daemons without changing origin, so `localStorage`
 * and `sessionStorage` are shared by every machine the browser visits. A key
 * that names an object of ONE daemon — a workspace, a pinned agent, a draft
 * written for a mission, a Kanban filter on a project — would follow the user
 * onto another daemon where that object does not exist, or worse, is another
 * one with the same id. Those keys go through this module; keys that describe
 * the device itself (theme cache before first paint, push-to-talk, microphone,
 * dictation) stay global and never come here.
 *
 *   - local machine: the key is unchanged, so nothing written before the
 *     multi-machine work is lost.
 *   - remote machine `<id>`: the key becomes `m:<id>:<key>`.
 *
 * Which machine is active is what the server resolved for this page
 * (`data-rooks-machine` on `<html>`, written by the root layout from
 * `resolveTarget()`), not the raw cookie: a malformed cookie is served as
 * local, and its state must be local's too. A well-formed id the registry
 * cannot resolve keeps its own prefix: that page is refused, never local's.
 * A malformed `X-Rooks-Machine` header is refused as well (`!malformed`, the
 * unavailable screen); that sentinel is no id, so the screen reads local's
 * keys. No desktop page can get there: the shell only writes ids it checked
 * (`isMachineId`, `desktop/src/window-machine.ts`), and nothing else sets the
 * header on a browser's requests.
 *
 * A switch is a full document load, never a client-side navigation: that is
 * what empties every in-memory request cache (the Next router cache, the
 * module-level caches of capabilities, backends, `/api/auth/me`…). Stored
 * state is not purged on a switch — the prefix keeps it apart, and a draft
 * left on a machine is still there when the user comes back. Only a machine
 * taken out of the fleet loses its state (`forgetMachineStorage`).
 */
import { isMachineId, LOCAL_MACHINE_ID } from './machine-id';

/** Attribute of `<html>` naming the machine this page was rendered for. */
export const MACHINE_ATTRIBUTE = 'data-rooks-machine';

const PREFIX = 'm:';

/** The machine this page belongs to; local outside a browser or when unsaid. */
export function activeMachineId(): string {
  if (typeof document === 'undefined') return LOCAL_MACHINE_ID;
  const raw = document.documentElement?.getAttribute(MACHINE_ATTRIBUTE) ?? null;
  return raw !== null && isMachineId(raw) ? raw : LOCAL_MACHINE_ID;
}

/** `key` as stored for `machineId` (the active machine by default). */
export function machineKey(key: string, machineId: string = activeMachineId()): string {
  return machineId === LOCAL_MACHINE_ID ? key : `${PREFIX}${machineId}:${key}`;
}

/** True when a raw storage key belongs to `machineId`. Local owns every key
 *  that carries no machine prefix. */
function ownsRawKey(raw: string, machineId: string): boolean {
  if (machineId === LOCAL_MACHINE_ID) return !raw.startsWith(PREFIX);
  return raw.startsWith(`${PREFIX}${machineId}:`);
}

/**
 * `base` seen through one machine's keys: reads and writes go to that
 * machine's namespace, `length`/`key()` enumerate it, `clear()` empties it and
 * nothing else. A drop-in `Storage` for code written against
 * `window.localStorage`.
 */
export function machineScopedStorage(base: Storage, machineId: string = activeMachineId()): Storage {
  const prefix = machineKey('', machineId);
  const ownKeys = (): string[] => {
    const out: string[] = [];
    for (let i = 0; i < base.length; i += 1) {
      const raw = base.key(i);
      if (raw !== null && ownsRawKey(raw, machineId)) out.push(raw.slice(prefix.length));
    }
    return out;
  };
  return {
    get length() { return ownKeys().length; },
    key: (index: number) => ownKeys()[index] ?? null,
    getItem: (key: string) => base.getItem(machineKey(key, machineId)),
    setItem: (key: string, value: string) => base.setItem(machineKey(key, machineId), value),
    removeItem: (key: string) => base.removeItem(machineKey(key, machineId)),
    clear: () => { for (const key of ownKeys()) base.removeItem(machineKey(key, machineId)); },
  };
}

type StorageName = 'localStorage' | 'sessionStorage';

function browserStorage(name: StorageName): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window[name];
  } catch {
    // Some private modes throw on mere access.
    return null;
  }
}

/** `localStorage` of a machine (the active one by default), or `null`
 *  (server render, blocked). */
export function machineLocalStorage(machineId: string = activeMachineId()): Storage | null {
  const base = browserStorage('localStorage');
  return base ? machineScopedStorage(base, machineId) : null;
}

/** `sessionStorage` of the active machine, or `null` (server render, blocked). */
export function machineSessionStorage(): Storage | null {
  const base = browserStorage('sessionStorage');
  return base ? machineScopedStorage(base) : null;
}

/**
 * Erases what this browser kept for a machine taken out of the fleet. The
 * local machine is never forgotten: its keys are the unprefixed ones, which
 * would include every per-device preference.
 */
export function forgetMachineStorage(machineId: string): void {
  if (machineId === LOCAL_MACHINE_ID || !isMachineId(machineId)) return;
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    const base = browserStorage(name);
    if (base) {
      try { machineScopedStorage(base, machineId).clear(); } catch { /* blocked storage: nothing kept */ }
    }
  }
}
