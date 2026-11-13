/**
 * Settings › AI models › CLI binaries (TODO #413): the backend CLIs the daemon
 * runs, and the paths pinned for them. The daemon validates every path and
 * decides who may pin (a superadmin signed in to the app); this module types
 * its answers and turns its codes into sentences.
 */
import { t } from '@/lib/i18n';

export type BackendBinary = {
  /** Binary name, the key of `host.binaries`. */
  cmd: string;
  /** Backend ids served by this binary. */
  backends: string[];
  /** What a mission would run now, `null` when nothing usable was found. */
  path: string | null;
  /** True when `path` comes from a pin. */
  pinned: boolean;
  /** The pinned value as configured, even when it no longer resolves. */
  pin: string | null;
};

export type BinaryState = 'found' | 'pinned' | 'brokenPin' | 'missing';

export function binaryState(binary: BackendBinary): BinaryState {
  if (binary.pin !== null) return binary.path !== null ? 'pinned' : 'brokenPin';
  return binary.path !== null ? 'found' : 'missing';
}

const BASE = '/api/ui/backends/binaries';

export class BinaryPinError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'BinaryPinError';
  }
}

const KNOWN_CODES = [
  'unknown_binary', 'path_not_absolute', 'path_missing', 'path_not_file', 'path_not_executable',
  'no_config', 'config_unreadable', 'invalid_body',
];

/** Daemon codes → sentences of the locale; never the path that was typed. */
export function binaryErrorMessage(status: number, code: string): string {
  if (status === 401 || status === 403) return t('binariesSettings.errors.forbidden');
  if (KNOWN_CODES.includes(code)) return t(`binariesSettings.errors.${code}`);
  return t('binariesSettings.errors.generic', { status });
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    cache: 'no-store',
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof (json as { error?: unknown } | null)?.error === 'string' ? (json as { error: string }).error : '';
    throw new BinaryPinError(response.status, code, binaryErrorMessage(response.status, code));
  }
  return json as T;
}

export const fetchBinaries = async (): Promise<BackendBinary[]> =>
  (await call<{ binaries: BackendBinary[] }>('GET', '')).binaries;
export const recheckBinaries = (): Promise<{ binaries: BackendBinary[]; configError: string | null }> =>
  call('POST', '/recheck');
export const pinBinary = async (cmd: string, path: string): Promise<BackendBinary[]> =>
  (await call<{ binaries: BackendBinary[] }>('PUT', `/${encodeURIComponent(cmd)}`, { path })).binaries;
export const unpinBinary = async (cmd: string): Promise<BackendBinary[]> =>
  (await call<{ binaries: BackendBinary[] }>('DELETE', `/${encodeURIComponent(cmd)}`)).binaries;
