/**
 * Whether a newer Rooks is published for this build's channel
 * (docs/AUTO-UPDATE.md §4, §6, P1b).
 *
 * One GET of the signed manifest, nothing in it but a generic User-Agent: no
 * licence, no installation id, no machine fingerprint, no cookie. Redirects are
 * followed by hand, as the desktop download does: every `Location` must be
 * https without credentials before it is requested, and a hop's body is never
 * read. Nothing of the manifest is read before its signature checks out, and a
 * manifest that fails any check is "no update known", never an offer.
 *
 * Anti-rollback: the highest `issuedAt` accepted is kept in
 * `<home>/updates/state.json` and an older manifest is refused, so a replayed
 * manifest can neither bring back an old offer nor hide a newer one. An offer
 * is only ever a version strictly above the installed one.
 *
 * A failed check keeps the last offer verified, as long as the manifest it came
 * from has not expired: a network glitch does not take the banner down, and a
 * forged manifest can add nothing to it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { BuildChannel } from '../../build-info.js';
import {
  ENVELOPE_MAX, RELEASES_URL, compareVersions, isVersion, verifyReleaseManifest,
  type ReleaseChannel, type ReleaseChannelEntry, type ReleasePublicKey, type ReleasesPayload,
} from './manifest.js';

export const USER_AGENT = 'Rooks-Updater';
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

export type UpdateState = 'off' | 'dev' | 'unchecked' | 'up_to_date' | 'available' | 'failed';

export type UpdateArtifact = {
  /** `linux-x64-appimage`, `mac-arm64-pkg`, `win-x64-nsis`… */
  key: string;
  os: 'linux' | 'mac' | 'win';
  arch: 'x64' | 'arm64' | 'universal';
  format: 'appimage' | 'deb' | 'pkg' | 'dmg' | 'nsis';
  name: string;
  url: string;
  size: number;
  /** Signed with the manifest: the desktop shell checks the downloaded bytes against it (P2). */
  sha256: string;
};

export type UpdateOffer = {
  version: string;
  publishedAt: string;
  /** Plain text; never HTML. */
  notes: string;
  notesUrl: string;
  artifacts: UpdateArtifact[];
};

export type UpdateStatus = {
  installed: string;
  channel: BuildChannel;
  /** The `ROOKS_UPDATES_CHECK` setting. */
  enabled: boolean;
  state: UpdateState;
  /** Last check that reached a verdict, successful or not. */
  checkedAt: string | null;
  available: UpdateOffer | null;
  /** The daemon's machine, so a client on the same OS offers the matching installer. */
  host: { os: 'linux' | 'mac' | 'win' | null; arch: string };
  /** End of this build (`build-info.json`), `null` when it never ends: the banner speaks of both at once. */
  buildExpiresAt: string | null;
};

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type CheckerDeps = {
  enabled: () => boolean;
  channel: () => BuildChannel;
  buildExpiresAt?: () => string | null;
  installed: () => string;
  keyring: () => readonly ReleasePublicKey[];
  stateFile: string;
  fetch?: FetchLike;
  now?: () => Date;
  url?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** A version newly offered by this check (not the one already known). */
  onOffer?: (offer: UpdateOffer, channel: ReleaseChannel) => void;
  log?: (message: string) => void;
};

const Persisted = z.object({
  lastIssuedAt: z.string().nullable().catch(null),
  notifiedVersion: z.string().nullable().catch(null),
});
export type PersistedState = z.infer<typeof Persisted>;

function hostOs(platform: NodeJS.Platform): UpdateStatus['host']['os'] {
  if (platform === 'linux') return 'linux';
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'win';
  return null;
}

function artifactsOf(entry: ReleaseChannelEntry): UpdateArtifact[] {
  return Object.entries(entry.artifacts).map(([key, artifact]) => {
    const [os, arch, format] = key.split('-') as [UpdateArtifact['os'], UpdateArtifact['arch'], UpdateArtifact['format']];
    return { key, os, arch, format, name: artifact.name, url: artifact.url, size: artifact.size, sha256: artifact.sha256 };
  });
}

/**
 * The entry a build of `channel` may be offered: a stable build reads
 * `stable` alone and never sees an rc; a beta build takes the higher of both.
 */
export function entryFor(payload: ReleasesPayload, channel: 'beta' | 'stable'): { entry: ReleaseChannelEntry; from: ReleaseChannel } | null {
  const { beta, stable } = payload.channels;
  if (channel === 'stable') return stable ? { entry: stable, from: 'stable' } : null;
  if (beta && stable) return compareVersions(beta.version, stable.version) >= 0 ? { entry: beta, from: 'beta' } : { entry: stable, from: 'stable' };
  if (beta) return { entry: beta, from: 'beta' };
  return stable ? { entry: stable, from: 'stable' } : null;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** An https URL without credentials, or a refusal that never echoes the URL (a CDN's carries a signed query). */
function secureTarget(location: string, base: string): string {
  let next: URL;
  try { next = new URL(location, base); } catch { throw new Error('manifest redirected to an invalid address'); }
  if (next.protocol !== 'https:' || next.username || next.password) throw new Error('manifest redirected off https');
  return next.href;
}

/**
 * GET with redirects followed by hand: each target is checked before it is
 * requested, and each hop's body is cancelled unread.
 */
async function fetchManifest(fetchImpl: FetchLike, url: string): Promise<Response> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let target = secureTarget(url, url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await fetchImpl(target, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'manual',
      signal,
    });
    if (!isRedirect(res.status)) return res;
    await res.body?.cancel().catch(() => undefined);
    const location = res.headers.get('location');
    if (!location) throw new Error(`manifest HTTP ${res.status} without a location`);
    target = secureTarget(location, target);
  }
  throw new Error('manifest redirected too many times');
}

/** Reads the body up to `max` bytes; past it the transfer is cut and nothing is parsed. */
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) throw new Error('manifest too large');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error('manifest too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class UpdateChecker {
  private offer: UpdateOffer | null = null;
  private offerExpiresAt = 0;
  private lastVerdict: 'up_to_date' | 'available' | 'failed' | null = null;
  private checkedAt: string | null = null;
  private running: Promise<UpdateStatus> | null = null;

  constructor(private readonly deps: CheckerDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  readState(): PersistedState {
    try {
      return Persisted.parse(JSON.parse(readFileSync(this.deps.stateFile, 'utf8')) as unknown);
    } catch {
      return { lastIssuedAt: null, notifiedVersion: null };
    }
  }

  private writeState(state: PersistedState): void {
    mkdirSync(dirname(this.deps.stateFile), { recursive: true });
    const tmp = `${this.deps.stateFile}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, this.deps.stateFile);
  }

  /** Why no check runs, or `null` when one may. */
  private blocked(): 'off' | 'dev' | null {
    if (this.deps.channel() === 'dev') return 'dev';
    if (!this.deps.enabled()) return 'off';
    return null;
  }

  status(): UpdateStatus {
    const blocked = this.blocked();
    const offer = blocked === null && this.offer && this.offerExpiresAt > this.now().getTime() ? this.offer : null;
    let state: UpdateState;
    if (blocked) state = blocked;
    else if (offer) state = 'available';
    else if (this.lastVerdict === null) state = 'unchecked';
    // An offer whose manifest expired is knowledge lost, not "up to date".
    else state = this.lastVerdict === 'available' ? 'unchecked' : this.lastVerdict;
    return {
      installed: this.deps.installed(),
      channel: this.deps.channel(),
      enabled: this.deps.enabled(),
      state,
      checkedAt: this.checkedAt,
      available: offer,
      host: { os: hostOs(this.deps.platform ?? process.platform), arch: this.deps.arch ?? process.arch },
      buildExpiresAt: this.deps.buildExpiresAt?.() ?? null,
    };
  }

  /** One check; concurrent callers share it. Never throws. */
  check(): Promise<UpdateStatus> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }

  private async run(): Promise<UpdateStatus> {
    // Off or a source build: not a single request leaves the machine.
    if (this.blocked()) return this.status();
    const log = this.deps.log ?? ((message: string) => console.warn(`[updates] ${message}`));
    try {
      const installed = this.deps.installed();
      if (!isVersion(installed)) throw new Error(`installed version ${installed} is not x.y.z[-rc.N]`);
      const channel = this.deps.channel() as 'beta' | 'stable';
      const res = await fetchManifest(this.deps.fetch ?? fetch, this.deps.url ?? RELEASES_URL);
      if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
      const body = await readCapped(res, ENVELOPE_MAX);
      const persisted = this.readState();
      const payload = verifyReleaseManifest(body, this.deps.keyring(), { now: this.now(), minIssuedAt: persisted.lastIssuedAt });
      if (!persisted.lastIssuedAt || Date.parse(payload.issuedAt) > Date.parse(persisted.lastIssuedAt)) {
        persisted.lastIssuedAt = payload.issuedAt;
        this.writeState(persisted);
      }
      const picked = entryFor(payload, channel);
      const offer = picked && compareVersions(picked.entry.version, installed) > 0
        ? {
          version: picked.entry.version,
          publishedAt: picked.entry.publishedAt,
          notes: picked.entry.notes,
          notesUrl: picked.entry.notesUrl,
          artifacts: artifactsOf(picked.entry),
        }
        : null;
      const known = this.offer?.version ?? null;
      this.offer = offer;
      this.offerExpiresAt = Date.parse(payload.expiresAt);
      this.lastVerdict = offer ? 'available' : 'up_to_date';
      this.checkedAt = this.now().toISOString();
      if (offer && picked && offer.version !== known) this.deps.onOffer?.(offer, picked.from);
    } catch (error) {
      this.lastVerdict = 'failed';
      this.checkedAt = this.now().toISOString();
      log(`no update known: ${(error as Error).message}`);
    }
    return this.status();
  }

  /** The version a notification was already sent for, kept across restarts: one per version. */
  markNotified(version: string): boolean {
    const persisted = this.readState();
    if (persisted.notifiedVersion === version) return false;
    persisted.notifiedVersion = version;
    try { this.writeState(persisted); } catch { /* a notification sent twice is better than none */ }
    return true;
  }
}

export const stateFileIn = (home: string): string => join(home, 'updates', 'state.json');
