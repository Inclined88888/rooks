/**
 * `host.binaries.<cmd>` pinned from Settings, applied without a restart
 * (TODO #413, SUG-0066).
 *
 * A tester whose CLI was not found had to edit `timon.config.json` by hand and
 * restart the daemon: the config is a singleton read at boot. This module is
 * the one place that writes a pin, and it does three things together:
 *  - checks the path through the host adapter's own lookup (absolute, a file,
 *    executable — `.cmd` and app aliases on Windows), never a shell command;
 *  - rewrites ONLY that key of the user's file, atomically, keeping every
 *    other key and the file's indentation;
 *  - swaps the live config, which the host adapter, `doctor` and the boot
 *    check all read at call time — the next spawn uses the new path.
 *
 * It refuses to create the file: its absence is what "first run" means
 * (`setup.ts`), and a file written from here would end onboarding and drop
 * the ports a packaged first launch decided through the environment.
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, win32 } from 'node:path';
import { CONFIG_FILE, config, expandTilde, setConfig } from '../config/load.js';
import { HostSchema } from '../config/schema.js';
import { findExecutableBinary } from '../host/binary-path.js';
import { buildSetupConfig, SetupError } from '../setup.js';
import {
  backendBinaryAnchor, checkBackendBinaries, invalidateBackendBinaryAvailability, type BackendBinaryStatus,
} from './binary-check.js';

export type BinaryPinErrorCode =
  | 'unknown_binary'
  | 'path_not_absolute'
  | 'path_missing'
  | 'path_not_file'
  | 'path_not_executable'
  | 'no_config'
  | 'config_unreadable';

/** Fixed messages: none of them quotes what the caller sent. */
const MESSAGES: Record<BinaryPinErrorCode, string> = {
  unknown_binary: 'This binary is not the CLI of a local backend.',
  path_not_absolute: 'Give the full path of the binary (for example /usr/local/bin/claude or C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd).',
  path_missing: 'Nothing exists at this path.',
  path_not_file: 'This path is a folder, not the binary itself.',
  path_not_executable: 'This file cannot be run: it is not executable.',
  no_config: 'Finish the setup first: timon.config.json does not exist yet.',
  config_unreadable: 'timon.config.json cannot be read as JSON; fix or restore it first.',
};

const STATUS: Record<BinaryPinErrorCode, number> = {
  unknown_binary: 404,
  path_not_absolute: 400,
  path_missing: 400,
  path_not_file: 400,
  path_not_executable: 400,
  no_config: 409,
  config_unreadable: 409,
};

export class BinaryPinError extends Error {
  readonly status: number;
  constructor(readonly code: BinaryPinErrorCode) {
    super(MESSAGES[code]);
    this.status = STATUS[code];
  }
}

/** Shape a binary name must have before it is even looked up. */
const BINARY_NAME = /^[A-Za-z0-9._-]{1,64}$/;

export type BinaryPinStatus = BackendBinaryStatus & {
  /** The pinned value as configured, even when it no longer resolves. */
  pin: string | null;
};

/** Every local backend CLI, with its pin and what a spawn would run now. */
export function binaryPinStatuses(): BinaryPinStatus[] {
  const pins = config().host.binaries;
  return checkBackendBinaries().map((status) => {
    const pin = pins[status.cmd];
    return { ...status, pin: typeof pin === 'string' && pin.length > 0 ? pin : null };
  });
}

/** Only the CLIs of local backends may be pinned here: `node`, `git` or
 *  `docker` stay a hand edit. Also what keeps `__proto__` out of the file. */
export function assertPinnableBinary(name: string, statuses: readonly BackendBinaryStatus[] = checkBackendBinaries()): void {
  if (!BINARY_NAME.test(name) || !statuses.some((status) => status.cmd === name)) {
    throw new BinaryPinError('unknown_binary');
  }
}

/**
 * What the person typed or picked, as a path the daemon can check: trimmed,
 * one pair of surrounding quotes removed (Windows "Copy as path" adds them),
 * a leading `~` expanded. `null` when it is not absolute.
 */
export function normalizePinPath(
  raw: string,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string | null {
  let value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).trim();
  if (value === '~') return null;
  if (value.startsWith('~/') || (platform === 'win32' && value.startsWith('~\\'))) {
    value = (platform === 'win32' ? win32.join : join)(home, value.slice(2));
  }
  const absolute = platform === 'win32' ? win32.isAbsolute(value) && /^([A-Za-z]:[\\/]|[\\/]{2})/.test(value) : isAbsolute(value);
  return absolute ? value : null;
}

/** What the adapter can start on Windows: a program, or an npm shim through
 *  `cmd.exe` (`windowsShimLaunch`). */
const WINDOWS_RUNNABLE = new Set(['.exe', '.com', '.cmd', '.bat']);

/**
 * Windows has no execute bit: the lookup accepts any existing file. npm drops
 * `claude`, `claude.cmd` and `claude.ps1` side by side, and only the `.cmd`
 * can be spawned — a pin on the other two would show "Pinned" and fail every
 * mission at start.
 */
export function runnableOnWindows(path: string): boolean {
  return WINDOWS_RUNNABLE.has(win32.extname(path).toLowerCase());
}

/** Same lookup a spawn does: an absolute path is its own only candidate. */
export function assertExecutablePin(path: string, platform: NodeJS.Platform = process.platform): void {
  if (findExecutableBinary(path) !== null) {
    if (platform === 'win32' && !runnableOnWindows(path)) throw new BinaryPinError('path_not_executable');
    return;
  }
  let isFile: boolean;
  try {
    isFile = statSync(path).isFile();
  } catch {
    throw new BinaryPinError('path_missing');
  }
  throw new BinaryPinError(isFile ? 'path_not_executable' : 'path_not_file');
}

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Indentation of the file as written, so a rewrite does not reflow it. */
function indentOf(raw: string): string | number {
  const match = /^[{[][^\S\n]*\r?\n([ \t]+)\S/.exec(raw);
  return match?.[1] ?? 2;
}

function readUserFile(file: string): { json: Json; raw: string } {
  if (!existsSync(file)) throw new BinaryPinError('no_config');
  let raw: string;
  let parsed: unknown;
  try {
    raw = readFileSync(file, 'utf8');
    parsed = JSON.parse(raw);
  } catch {
    throw new BinaryPinError('config_unreadable');
  }
  if (!isPlainObject(parsed)) throw new BinaryPinError('config_unreadable');
  return { json: parsed, raw };
}

/** Same directory, then rename: neither the config watcher nor a crash ever
 *  sees half a file. */
function writeAtomically(file: string, content: string): void {
  const tmp = join(dirname(file), `.timon.config.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

/** Rewrites `host.binaries.<name>` in the user's file; `null` removes it. */
function writeUserPin(file: string, name: string, path: string | null): void {
  const { json, raw } = readUserFile(file);
  const host = isPlainObject(json.host) ? { ...json.host } : {};
  const binaries = isPlainObject(host.binaries) ? { ...host.binaries } : {};
  if (path === null) delete binaries[name];
  else binaries[name] = path;
  if (Object.keys(binaries).length > 0) host.binaries = binaries;
  else delete host.binaries;
  const next: Json = { ...json };
  if (Object.keys(host).length > 0) next.host = host;
  else delete next.host;
  writeAtomically(file, `${JSON.stringify(next, null, indentOf(raw))}${raw.endsWith('\n') ? '\n' : ''}`);
}

/** Swaps the live pins. A new object rather than a mutation: a reader holding
 *  the previous config keeps a coherent one. */
function applyLivePins(binaries: Record<string, string | null>): void {
  const live = config();
  setConfig({ ...live, host: { ...live.host, binaries } });
  invalidateBackendBinaryAvailability();
}

/** A warning raised at boot must not outlive the fix that answered it. */
async function dismissResolvedAlerts(statuses: readonly BackendBinaryStatus[]): Promise<void> {
  const resolved = statuses.filter((status) => status.path !== null);
  if (resolved.length === 0) return;
  try {
    const { dbApi } = await import('../db.js');
    for (const status of resolved) dbApi.dismissNotificationsByAnchor(backendBinaryAnchor(status.cmd), 'alert');
  } catch (err) {
    console.warn(`[backends] could not dismiss the missing-CLI alert: ${(err as Error).message}`);
  }
}

/** Pins `name` to `rawPath` (written, then live). Throws `BinaryPinError`. */
export async function pinBinary(name: string, rawPath: string, file: string = CONFIG_FILE): Promise<BinaryPinStatus[]> {
  assertPinnableBinary(name);
  const path = normalizePinPath(rawPath);
  if (path === null) throw new BinaryPinError('path_not_absolute');
  // The wizard's own validation: what it would write for this pin must be a
  // config the daemon accepts at boot.
  try {
    buildSetupConfig({ binaries: { [name]: path }, envDecisions: {} });
  } catch (err) {
    if (err instanceof SetupError) throw new BinaryPinError('path_not_absolute');
    throw err;
  }
  assertExecutablePin(path);
  writeUserPin(file, name, path);
  applyLivePins({ ...config().host.binaries, [name]: path });
  console.log(`[backends] ${name}: path pinned from Settings`);
  const statuses = binaryPinStatuses();
  await dismissResolvedAlerts(statuses);
  return statuses;
}

/** Removes the pin: back to PATH and the known install folders. */
export async function unpinBinary(name: string, file: string = CONFIG_FILE): Promise<BinaryPinStatus[]> {
  assertPinnableBinary(name);
  writeUserPin(file, name, null);
  const next = { ...config().host.binaries };
  delete next[name];
  applyLivePins(next);
  console.log(`[backends] ${name}: pin removed from Settings`);
  const statuses = binaryPinStatuses();
  await dismissResolvedAlerts(statuses);
  return statuses;
}

/**
 * "Check again": nothing is written. The pins are re-read from the file — the
 * person may have edited it by hand — and every CLI is resolved again — they
 * may have just installed one. An unreadable or invalid file leaves the live
 * pins as they were and says so.
 */
export async function recheckBinaries(file: string = CONFIG_FILE): Promise<{ binaries: BinaryPinStatus[]; configError: BinaryPinErrorCode | null }> {
  let configError: BinaryPinErrorCode | null = null;
  if (existsSync(file)) {
    try {
      const { json } = readUserFile(file);
      const host = isPlainObject(json.host) ? json.host : {};
      const parsed = HostSchema.shape.binaries.safeParse(host.binaries ?? {});
      if (!parsed.success) throw new BinaryPinError('config_unreadable');
      const binaries: Record<string, string | null> = {};
      for (const [key, value] of Object.entries(parsed.data)) {
        // Expanded exactly as the boot does (`loadConfig`), no more.
        binaries[key] = typeof value === 'string' ? expandTilde(value) : value;
      }
      applyLivePins(binaries);
    } catch (err) {
      if (!(err instanceof BinaryPinError)) throw err;
      configError = err.code;
      invalidateBackendBinaryAvailability();
    }
  } else {
    invalidateBackendBinaryAvailability();
  }
  const binaries = binaryPinStatuses();
  await dismissResolvedAlerts(binaries);
  return { binaries, configError };
}
