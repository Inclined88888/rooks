/**
 * Outcome of asking for a folder (or a file, TODO #791), and where it is looked for.
 *
 * A folder path a setting, a project or an agent stores is read by the
 * daemon of the ACTIVE machine. The OS dialog of the desktop client
 * (`window.novaDesktop.selectDirectory`) browses this computer: it is the
 * right picker only when that daemon runs here. Driving another machine (the
 * machine switcher, TIM-0136), or in a plain browser that has no dialog
 * handing back an absolute path, the folders come from the daemon itself
 * (`GET /api/ui/host/directories`).
 */
import { LOCAL_MACHINE_ID } from './machines/machine-id';

export type DirectoryPick =
  | { status: 'chosen'; path: string }
  | { status: 'cancelled' }
  | { status: 'unavailable' }
  | { status: 'failed' };

type DirectoryBridge = { selectDirectory?: (defaultPath?: string) => Promise<string | null> } | null;

/**
 * True when a native dialog of this computer picks a path the active daemon
 * can read. Every native picker (folder, plugin source, CLI binary) asks it:
 * on another machine, a path of this disk would be stored there as if it
 * were its own.
 */
export function nativePickerReachesDaemon(machineId: string): boolean {
  return machineId === LOCAL_MACHINE_ID;
}

/** `native`: the desktop's OS dialog. `daemon`: the folders the active daemon lists. */
export function directoryPickSource(bridge: DirectoryBridge, machineId: string): 'native' | 'daemon' {
  return bridge?.selectDirectory && nativePickerReachesDaemon(machineId) ? 'native' : 'daemon';
}

export async function pickDirectory(bridge: DirectoryBridge, current: string): Promise<DirectoryPick> {
  if (!bridge?.selectDirectory) return { status: 'unavailable' };
  try {
    const path = await bridge.selectDirectory(current || undefined);
    return path === null || path === '' ? { status: 'cancelled' } : { status: 'chosen', path };
  } catch {
    return { status: 'failed' };
  }
}

export interface DirectoryEntry {
  name: string;
  path: string;
  hidden: boolean;
}

/** One level of the daemon's disk, every path built by the daemon. */
export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: DirectoryEntry[];
  truncated: boolean;
  home: string;
  roots: string[];
  /** File mode only (TODO #791): the files of the level that pass the request's filter. */
  files?: DirectoryEntry[];
  /** File mode only: the file the read named, when it passes the filter; `path` is then its folder. */
  selected?: string;
}

/**
 * What a pick asks for. `directory`: a folder (TIM-0136). `file`: a file the
 * daemon reads (TODO #791) — every file, or those ending with one of `accept`
 * (`.tgz`, `.tar.gz`…). File names are served to a superadmin only.
 */
export type DirectoryPickMode = { kind: 'directory' } | { kind: 'file'; accept: readonly string[] };

export const DIRECTORY_MODE: DirectoryPickMode = { kind: 'directory' };

/** The `files` query of a file-mode read: `*`, or the endings joined. */
export function filesQuery(mode: DirectoryPickMode): string | null {
  if (mode.kind !== 'file') return null;
  return mode.accept.length ? mode.accept.map((ending) => ending.toLowerCase()).join(',') : '*';
}

/**
 * Why a level could not be read. `outdated`: the daemon has no such route
 * (a machine on an older Rooks) — the path is typed instead, never picked on
 * this computer's disk, which would be the wrong one.
 */
export type DirectoryListError = 'not_found' | 'not_a_directory' | 'relative_path' | 'unreadable' | 'forbidden' | 'outdated' | 'failed';

export type DirectoryRead = { ok: true; listing: DirectoryListing } | { ok: false; error: DirectoryListError };

const NAMED: ReadonlySet<string> = new Set(['not_found', 'not_a_directory', 'relative_path', 'unreadable']);

function isListing(value: unknown): value is DirectoryListing {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.path === 'string' && (v.parent === null || typeof v.parent === 'string')
    && Array.isArray(v.entries) && Array.isArray(v.roots) && typeof v.home === 'string';
}

export async function readDirectories(
  path: string | null,
  fetcher: typeof fetch = fetch,
  mode: DirectoryPickMode = DIRECTORY_MODE,
): Promise<DirectoryRead> {
  const files = filesQuery(mode);
  const parts: string[] = [];
  if (path) parts.push(`path=${encodeURIComponent(path)}`);
  if (files !== null) parts.push(`files=${encodeURIComponent(files)}`);
  const query = parts.length ? `?${parts.join('&')}` : '';
  let response: Response;
  try {
    response = await fetcher(`/api/ui/host/directories${query}`, { cache: 'no-store' });
  } catch {
    return { ok: false, error: 'failed' };
  }
  let body: unknown = null;
  try { body = await response.json(); } catch { /* An HTML error page reads as no body. */ }
  if (response.ok) {
    if (!isListing(body)) return { ok: false, error: 'failed' };
    // A daemon that ignored `files` lists folders only: that is no file picker.
    if (files !== null && !Array.isArray(body.files)) return { ok: false, error: 'outdated' };
    return { ok: true, listing: body };
  }
  const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  if (typeof error === 'string' && NAMED.has(error)) return { ok: false, error: error as DirectoryListError };
  // A daemon of TIM-0136 knows the route but refuses `files` as an unknown key.
  if (files !== null && response.status === 400 && error === 'invalid_query') return { ok: false, error: 'outdated' };
  if (response.status === 401 || response.status === 403) return { ok: false, error: 'forbidden' };
  // No named error on a 404: the route itself is missing.
  if (response.status === 404) return { ok: false, error: 'outdated' };
  return { ok: false, error: 'failed' };
}

/**
 * The first level the browser opens on: the current value when it can be
 * read, otherwise the daemon's home — a setting may point at a folder since
 * removed, which must not leave the dialog empty.
 */
export async function openingListing(
  current: string,
  fetcher: typeof fetch = fetch,
  mode: DirectoryPickMode = DIRECTORY_MODE,
): Promise<DirectoryRead> {
  const start = current.trim();
  if (!start) return readDirectories(null, fetcher, mode);
  const first = await readDirectories(start, fetcher, mode);
  if (first.ok || first.error === 'forbidden' || first.error === 'outdated' || first.error === 'failed') return first;
  return readDirectories(null, fetcher, mode);
}
