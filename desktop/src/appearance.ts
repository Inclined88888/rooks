import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMachineId, LOCAL_MACHINE_ID } from './window-machine.js';

export type Scheme = 'light' | 'dark';

/**
 * A page tells the shell the light/dark mode it paints (multi-window): each
 * machine keeps its own, and a window opened on a remote machine must not
 * flash this computer's background before its page answers.
 */
export const WINDOW_SCHEME_CHANNEL = 'rooks:window-scheme';

/** What the shell remembers of the remote machines' modes; this computer's is the daemon's `appearance.json`. */
const MACHINE_SCHEMES_FILE = 'machine-schemes.json';
/** A fleet is a handful of machines: past this, a page reporting made-up ids could only grow the file. */
const MACHINE_SCHEMES_MAX = 64;

function isScheme(value: unknown): value is Scheme {
  return value === 'light' || value === 'dark';
}

function readMachineSchemes(home: string): Record<string, Scheme> {
  try {
    const raw = JSON.parse(readFileSync(join(home, MACHINE_SCHEMES_FILE), 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const schemes: Record<string, Scheme> = {};
    for (const [id, scheme] of Object.entries(raw)) if (isMachineId(id) && isScheme(scheme)) schemes[id] = scheme;
    return schemes;
  } catch {
    return {};
  }
}

const isRemote = (machineId: string | null): machineId is string =>
  machineId !== null && machineId !== LOCAL_MACHINE_ID && isMachineId(machineId);

/**
 * The scheme a window must paint before any daemon answers (#132): for a
 * remote machine, the one its page last reported; otherwise the one the
 * install recorded (`appearance.json`, written by the daemon on each choice) —
 * which also stands in for a remote machine never shown yet — else dark: no
 * file means no install yet, and the onboarding opens dark for everyone,
 * whatever the OS (the maintainer, 05/11/2026).
 */
export function windowScheme(home: string, machineId: string | null = null): Scheme {
  if (isRemote(machineId)) {
    const remote = readMachineSchemes(home)[machineId];
    if (remote) return remote;
  }
  try {
    const scheme = (JSON.parse(readFileSync(join(home, 'appearance.json'), 'utf8')) as { scheme?: unknown }).scheme;
    if (isScheme(scheme)) return scheme;
  } catch { /* no install yet, or an unreadable file: the onboarding's default */ }
  return 'dark';
}

/** A page's report, checked: a mode, and the machine the page was served for (`null` when it did not say). */
export function parseWindowSchemeReport(input: unknown): { scheme: Scheme; machineId: string | null } | null {
  if (!input || typeof input !== 'object') return null;
  const { scheme, machineId } = input as { scheme?: unknown; machineId?: unknown };
  if (!isScheme(scheme)) return null;
  if (machineId !== undefined && machineId !== null && !isMachineId(machineId)) return null;
  return { scheme, machineId: machineId ?? null };
}

/**
 * Remembers the mode a remote machine's page paints, for the next window or
 * page opened on it. This computer's own mode is not written here: the daemon
 * records it in `appearance.json`. Writes only on a change; `true` when it did.
 */
export function recordMachineScheme(home: string, machineId: string | null, scheme: Scheme): boolean {
  if (!isRemote(machineId) || !isScheme(scheme)) return false;
  const schemes = readMachineSchemes(home);
  if (schemes[machineId] === scheme) return false;
  if (!(machineId in schemes) && Object.keys(schemes).length >= MACHINE_SCHEMES_MAX) return false;
  schemes[machineId] = scheme;
  try {
    writeFileSync(join(home, MACHINE_SCHEMES_FILE), `${JSON.stringify(schemes)}\n`, { mode: 0o600 });
    return true;
  } catch (err) {
    console.warn(`[desktop] could not record the mode of machine ${machineId}: ${(err as Error).message}`);
    return false;
  }
}

/** Main window background, before the app paints (app surface-0, per scheme). */
export const WINDOW_BACKGROUND: Record<Scheme, string> = { dark: '#0b0b0d', light: '#f6f7f8' };
