import { createHash } from 'node:crypto';
import { createReadStream, type Dirent } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { compareVersions } from './data-restore.js';

/**
 * The verified download of a newer Timon (docs/AUTO-UPDATE.md §4, §7 P2).
 *
 * The daemon has verified the signed release list; this process downloads the
 * installer for its own system and architecture, and nothing else:
 *
 *  - the URL, size and sha256 come from the local daemon's offer
 *    (`GET /api/updates`, daemon token, loopback), never from the renderer;
 *  - https only, redirects followed by hand: every `Location` is checked
 *    before a single byte of its body is read (GitHub Releases answers with a
 *    redirect to its object store), and a redirect off https stops everything;
 *  - bytes go to `<home>/updates/<version>/<name>.part`; more bytes than the
 *    signed size stop the transfer; the sha256 is checked once the size is
 *    reached, and only then is the file renamed to its final name;
 *  - a cut connection keeps the `.part`, and the next attempt resumes with a
 *    `Range`; every verdict on the bytes (hash, size, refused redirect, HTTP
 *    error, full disk) and a cancel delete it;
 *  - the request carries a generic User-Agent and nothing else: no licence,
 *    no cookie, no machine id.
 *
 * It opens nothing and installs nothing: that is the window's choice ("Open
 * the folder", "Open the installer") and, later, P3.
 */

export const USER_AGENT = 'Timon-Updater';
const MAX_REDIRECTS = 5;
/** A transfer that receives nothing for this long is cut, then resumed. */
const STALL_MS = 60_000;
/** Attempts per start: a cut connection resumes where it stopped. */
const TRANSFER_ATTEMPTS = 3;
/** Kept free beyond the installer itself, so a download never fills the disk to the last byte. */
const DISK_MARGIN = 64 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 250;
/** Far above any installer; a size past it is a broken offer, not a big file. */
const MAX_ARTIFACT_SIZE = 8 * 1024 * 1024 * 1024;

const VERSION = /^\d+\.\d+\.\d+(-rc\.\d+)?$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;

export type UpdateFormat = 'appimage' | 'deb' | 'pkg' | 'dmg' | 'nsis';
export type UpdateOs = 'linux' | 'mac' | 'win';

const httpsUrl = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}, 'expected an https URL without credentials');

const artifactSchema = z.object({
  key: z.string().max(64),
  os: z.enum(['linux', 'mac', 'win']),
  arch: z.enum(['x64', 'arm64', 'universal']),
  format: z.enum(['appimage', 'deb', 'pkg', 'dmg', 'nsis']),
  name: z.string().max(255).regex(NAME),
  url: httpsUrl,
  size: z.number().int().positive().max(MAX_ARTIFACT_SIZE),
  sha256: z.string().regex(SHA256),
});
export type OfferedArtifact = z.infer<typeof artifactSchema>;

/** What the shell needs of the daemon's `GET /api/updates`; anything it does not name is ignored. */
const statusSchema = z.object({
  state: z.string(),
  available: z.object({
    version: z.string().regex(VERSION),
    artifacts: z.array(z.unknown()).max(64),
  }).nullable(),
});

export type VerifiedOffer = { version: string; artifact: OfferedArtifact };

/** Installer formats in the order this shell takes them, on each system. */
const FORMAT_ORDER: Record<UpdateOs, readonly UpdateFormat[]> = {
  // The running build's own format first: an AppImage replaces an AppImage, a `.deb` a `.deb`.
  linux: ['appimage', 'deb'],
  // The `.pkg` installs the command line and the service; the `.dmg` does not.
  mac: ['pkg', 'dmg'],
  win: ['nsis'],
};

export function osOf(platform: NodeJS.Platform): UpdateOs | null {
  if (platform === 'linux') return 'linux';
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'win';
  return null;
}

/**
 * The installer of this machine: its system, its architecture (or a universal
 * macOS build), the format it was installed with when that is known.
 */
export function pickArtifact(
  artifacts: readonly OfferedArtifact[],
  machine: { platform: NodeJS.Platform; arch: string; appImage: boolean },
): OfferedArtifact | null {
  const os = osOf(machine.platform);
  if (!os) return null;
  let formats = FORMAT_ORDER[os];
  if (os === 'linux') formats = machine.appImage ? ['appimage', 'deb'] : ['deb', 'appimage'];
  const archRank = (arch: string): number => (arch === machine.arch ? 0 : arch === 'universal' && os === 'mac' ? 1 : -1);
  const usable = artifacts.filter((artifact) => artifact.os === os && formats.includes(artifact.format) && archRank(artifact.arch) >= 0);
  usable.sort((a, b) => (formats.indexOf(a.format) - formats.indexOf(b.format)) * 10 + (archRank(a.arch) - archRank(b.arch)));
  return usable[0] ?? null;
}

/**
 * The offer to download, read from the daemon's status: a version strictly
 * above this shell's, and the one installer that fits this machine. `null`
 * when there is none; a malformed artifact is skipped, never trusted.
 */
export function offerFromStatus(
  body: unknown,
  installed: string,
  machine: { platform: NodeJS.Platform; arch: string; appImage: boolean },
): VerifiedOffer | null {
  const parsed = statusSchema.safeParse(body);
  if (!parsed.success || parsed.data.state !== 'available' || !parsed.data.available) return null;
  const { version, artifacts } = parsed.data.available;
  // Never the installed version or an older one: going back is the downgrade flow's job.
  if ((compareVersions(version, installed) ?? 0) <= 0) return null;
  const valid = artifacts.flatMap((raw) => {
    const artifact = artifactSchema.safeParse(raw);
    return artifact.success ? [artifact.data] : [];
  });
  const artifact = pickArtifact(valid, machine);
  return artifact ? { version, artifact } : null;
}

export type DownloadErrorCode =
  /** The daemon offers no newer version for this machine. */
  | 'no_offer'
  /** The daemon could not be asked (not running, token unreadable). */
  | 'daemon'
  | 'network'
  | 'http'
  | 'insecure_redirect'
  | 'too_many_redirects'
  /** More bytes than the signed size. */
  | 'size'
  /** The bytes do not hash to the signed sha256. */
  | 'integrity'
  | 'disk_full'
  | 'filesystem';

export type DownloadState =
  | { phase: 'idle' }
  | { phase: 'downloading'; version: string; name: string; format: UpdateFormat; received: number; total: number }
  | { phase: 'verifying'; version: string; name: string; format: UpdateFormat; total: number }
  | { phase: 'ready'; version: string; name: string; format: UpdateFormat; total: number }
  | { phase: 'failed'; version: string | null; name: string | null; code: DownloadErrorCode; resumable: boolean };

export class DownloadError extends Error {
  constructor(readonly code: DownloadErrorCode, message: string) {
    super(message);
    this.name = 'DownloadError';
  }
}

class Cancelled extends Error {}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type Sink = { write(chunk: Uint8Array): Promise<void>; close(): Promise<void> };

export type DownloaderDeps = {
  /** `<home>/updates`. */
  root: string;
  fetch?: FetchLike;
  /** Free bytes where the file goes, `null` when the system cannot tell. */
  freeBytes?: (dir: string) => Promise<number | null>;
  /** Opens the `.part`, truncated or for appending. */
  openSink?: (path: string, append: boolean) => Promise<Sink>;
  onState?: (state: DownloadState) => void;
  stallMs?: number;
  log?: (line: string) => void;
};

async function sizeOf(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch { return null; }
}

export function sha256Of(path: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    createReadStream(path).on('error', rejectHash).on('data', (chunk) => hash.update(chunk)).on('end', () => resolveHash(hash.digest('hex')));
  });
}

async function defaultFreeBytes(dir: string): Promise<number | null> {
  try {
    const info = await statfs(dir);
    return Number(info.bavail) * Number(info.bsize);
  } catch { return null; }
}

async function defaultSink(path: string, append: boolean): Promise<Sink> {
  const handle = await open(path, append ? 'a' : 'w');
  return {
    write: async (chunk) => { await handle.write(chunk); },
    close: () => handle.close(),
  };
}

function isDiskFull(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOSPC' || code === 'EDQUOT';
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** An https URL without credentials, or a refusal; never echoes the URL (a CDN's carries a signed query). */
export function secureTarget(location: string, base: string): string {
  let next: URL;
  try { next = new URL(location, base); } catch { throw new DownloadError('insecure_redirect', 'The download was redirected to an invalid address.'); }
  if (next.protocol !== 'https:' || next.username || next.password) {
    throw new DownloadError('insecure_redirect', 'The download was redirected off https; nothing was read.');
  }
  return next.href;
}

/** `bytes <start>-<end>/<total>`: the start of a partial answer, or `null`. */
function rangeStart(header: string | null): number | null {
  const match = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(header?.trim() ?? '');
  return match ? Number(match[1]) : null;
}

export class UpdateDownloader {
  private current: DownloadState = { phase: 'idle' };
  private controller: AbortController | null = null;
  private running: Promise<DownloadState> | null = null;
  /** The verified file of the last download that reached `ready`. */
  private file: { path: string; offer: VerifiedOffer } | null = null;
  private lastProgress = 0;

  constructor(private readonly deps: DownloaderDeps) {}

  state(): DownloadState {
    return this.current;
  }

  /** The verified installer on disk and the offer it came from, or `null`. */
  ready(): { path: string; offer: VerifiedOffer } | null {
    return this.current.phase === 'ready' ? this.file : null;
  }

  private set(state: DownloadState): void {
    this.current = state;
    this.deps.onState?.(state);
  }

  private paths(offer: VerifiedOffer): { dir: string; part: string; final: string } {
    // Both checked again here: they become a path, whatever validated them before.
    if (!VERSION.test(offer.version) || !NAME.test(offer.artifact.name)) throw new DownloadError('filesystem', 'Unexpected version or file name.');
    const dir = join(this.deps.root, offer.version);
    return { dir, part: join(dir, `${offer.artifact.name}.part`), final: join(dir, offer.artifact.name) };
  }

  /** One download at a time: a second start while one runs gets that one. */
  start(offer: VerifiedOffer): Promise<DownloadState> {
    if (this.running) return this.running;
    const controller = new AbortController();
    this.controller = controller;
    this.running = this.run(offer, controller.signal).finally(() => {
      this.running = null;
      this.controller = null;
    });
    return this.running;
  }

  /** A start that never reached the network (no offer, no daemon): said like any failure, unless a download runs. */
  refuse(code: 'no_offer' | 'daemon'): DownloadState {
    if (this.running) return this.current;
    this.file = null;
    this.set({ phase: 'failed', version: null, name: null, code, resumable: false });
    return this.current;
  }

  /** Stops the download and deletes its partial file. Nothing running: nothing happens. */
  async cancel(): Promise<DownloadState> {
    const running = this.running;
    if (!running || !this.controller) return this.current;
    this.controller.abort(new Cancelled('cancelled'));
    return running;
  }

  private async run(offer: VerifiedOffer, signal: AbortSignal): Promise<DownloadState> {
    const { artifact, version } = offer;
    const base = { version, name: artifact.name, format: artifact.format };
    let paths: { dir: string; part: string; final: string } | null = null;
    try {
      paths = this.paths(offer);
      this.file = null;
      this.lastProgress = 0;
      this.set({ phase: 'downloading', ...base, received: 0, total: artifact.size });
      await mkdir(paths.dir, { recursive: true });
      await this.pruneOthers(version);

      // Downloaded before: the bytes are verified again, never assumed.
      if ((await sizeOf(paths.final)) === artifact.size) {
        this.set({ phase: 'verifying', ...base, total: artifact.size });
        if (await sha256Of(paths.final) === artifact.sha256) return this.done(paths.final, offer);
      }
      await rm(paths.final, { force: true });

      let offset = (await sizeOf(paths.part)) ?? 0;
      if (offset > artifact.size) {
        await rm(paths.part, { force: true });
        offset = 0;
      }
      const free = await (this.deps.freeBytes ?? defaultFreeBytes)(paths.dir);
      if (free !== null && free < artifact.size - offset + DISK_MARGIN) {
        throw new DownloadError('disk_full', 'Not enough free disk space for the installer.');
      }
      for (let attempt = 1; offset < artifact.size; attempt += 1) {
        try {
          offset = await this.transfer(artifact, paths.part, offset, signal, base);
        } catch (error) {
          const resumable = error instanceof DownloadError && error.code === 'network';
          if (!resumable || attempt >= TRANSFER_ATTEMPTS || signal.aborted) throw error;
          offset = (await sizeOf(paths.part)) ?? 0;
          this.deps.log?.(`[updates] connection cut at ${offset} bytes, resuming (attempt ${attempt + 1})`);
        }
      }
      this.set({ phase: 'verifying', ...base, total: artifact.size });
      if ((await sizeOf(paths.part)) !== artifact.size) throw new DownloadError('size', 'The installer does not have its announced size.');
      if (await sha256Of(paths.part) !== artifact.sha256) {
        throw new DownloadError('integrity', 'The downloaded installer does not match its signed checksum.');
      }
      await rename(paths.part, paths.final);
      return this.done(paths.final, offer);
    } catch (error) {
      return this.fail(error, signal, paths, base);
    }
  }

  private done(path: string, offer: VerifiedOffer): DownloadState {
    this.file = { path, offer };
    const state: DownloadState = { phase: 'ready', version: offer.version, name: offer.artifact.name, format: offer.artifact.format, total: offer.artifact.size };
    this.set(state);
    return state;
  }

  private async fail(
    error: unknown,
    signal: AbortSignal,
    paths: { part: string } | null,
    base: { version: string; name: string },
  ): Promise<DownloadState> {
    const cancelled = signal.aborted && signal.reason instanceof Cancelled;
    let code: DownloadErrorCode = 'filesystem';
    if (error instanceof DownloadError) code = error.code;
    else if (isDiskFull(error)) code = 'disk_full';
    // A cut connection says nothing about the bytes already here: they stay for the next attempt.
    const keep = !cancelled && code === 'network';
    if (paths && !keep) await rm(paths.part, { force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
    if (cancelled) {
      this.set({ phase: 'idle' });
      return this.current;
    }
    // Never the raw error of a request: a redirect URL can carry a signed query.
    this.deps.log?.(`[updates] download failed: ${code}${error instanceof DownloadError ? ` (${error.message})` : ''}`);
    this.set({ phase: 'failed', version: base.version, name: base.name, code, resumable: keep });
    return this.current;
  }

  /** Installers of other versions: only the one being fetched is kept. */
  private async pruneOthers(version: string): Promise<void> {
    let entries: Dirent[];
    try { entries = await readdir(this.deps.root, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === version || !VERSION.test(entry.name)) continue;
      await rm(join(this.deps.root, entry.name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
    }
  }

  /**
   * Follows redirects by hand: every hop is checked before its body is
   * touched, and a hop's body is cancelled unread.
   */
  private async request(url: string, offset: number, signal: AbortSignal): Promise<Response> {
    let target = secureTarget(url, url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      let response: Response;
      try {
        response = await (this.deps.fetch ?? fetch)(target, {
          method: 'GET',
          redirect: 'manual',
          credentials: 'omit',
          cache: 'no-store',
          headers: { 'user-agent': USER_AGENT, accept: 'application/octet-stream', ...(offset > 0 ? { range: `bytes=${offset}-` } : {}) },
          signal,
        });
      } catch {
        if (signal.aborted) throw signal.reason;
        throw new DownloadError('network', 'Network error while downloading the installer.');
      }
      if (!isRedirect(response.status)) return response;
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get('location');
      if (!location) throw new DownloadError('http', `The download server answered ${response.status} without an address.`);
      target = secureTarget(location, target);
    }
    throw new DownloadError('too_many_redirects', 'The download was redirected too many times.');
  }

  /** Writes from `offset` on; returns the bytes now in `part`. */
  private async transfer(
    artifact: OfferedArtifact,
    part: string,
    offset: number,
    signal: AbortSignal,
    base: { version: string; name: string; format: UpdateFormat },
  ): Promise<number> {
    const local = new AbortController();
    const forward = (): void => local.abort(signal.reason);
    if (signal.aborted) throw signal.reason;
    signal.addEventListener('abort', forward, { once: true });
    let stall: NodeJS.Timeout | undefined;
    const arm = (): void => {
      clearTimeout(stall);
      stall = setTimeout(() => local.abort(new DownloadError('network', 'The download stalled.')), this.deps.stallMs ?? STALL_MS);
    };
    let sink: Sink | null = null;
    try {
      arm();
      const response = await this.request(artifact.url, offset, local.signal);
      let position: number;
      if (response.status === 206 && offset > 0 && rangeStart(response.headers.get('content-range')) === offset) {
        position = offset;
      } else if (response.status === 200) {
        position = 0;
      } else if (response.status === 416 && offset === artifact.size) {
        await response.body?.cancel().catch(() => undefined);
        return offset;
      } else {
        await response.body?.cancel().catch(() => undefined);
        throw new DownloadError('http', `The download server answered ${response.status}.`);
      }
      const declared = Number(response.headers.get('content-length') ?? NaN);
      if (Number.isFinite(declared) && position + declared > artifact.size) {
        await response.body?.cancel().catch(() => undefined);
        throw new DownloadError('size', 'The server announces more bytes than the signed size.');
      }
      if (!response.body) throw new DownloadError('network', 'The download server sent no content.');
      sink = await (this.deps.openSink ?? defaultSink)(part, position > 0);
      const reader = response.body.getReader();
      // A cancel or a stall must end a read that waits on a silent socket.
      const stop = (): void => { void reader.cancel().catch(() => undefined); };
      local.signal.addEventListener('abort', stop, { once: true });
      let finished = false;
      try {
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch {
            if (local.signal.aborted) throw local.signal.reason;
            throw new DownloadError('network', 'The connection dropped during the download.');
          }
          if (local.signal.aborted) throw local.signal.reason;
          if (chunk.done) { finished = true; break; }
          arm();
          if (position + chunk.value.byteLength > artifact.size) throw new DownloadError('size', 'The server sent more bytes than the signed size.');
          await sink.write(chunk.value);
          position += chunk.value.byteLength;
          this.progress(base, position, artifact.size);
        }
      } finally {
        local.signal.removeEventListener('abort', stop);
        // Any early exit stops the transfer, or the socket keeps filling memory.
        if (!finished) await reader.cancel().catch(() => undefined);
      }
      if (position < artifact.size) throw new DownloadError('network', 'The connection ended before the installer was complete.');
      return position;
    } catch (error) {
      if (local.signal.aborted && !signal.aborted && local.signal.reason instanceof DownloadError) throw local.signal.reason;
      throw error;
    } finally {
      clearTimeout(stall);
      signal.removeEventListener('abort', forward);
      if (sink) await sink.close().catch(() => undefined);
    }
  }

  private progress(base: { version: string; name: string; format: UpdateFormat }, received: number, total: number): void {
    const now = Date.now();
    if (received < total && now - this.lastProgress < PROGRESS_INTERVAL_MS) {
      this.current = { phase: 'downloading', ...base, received, total };
      return;
    }
    this.lastProgress = now;
    this.set({ phase: 'downloading', ...base, received, total });
  }
}
