/**
 * License server client — the calls of the frozen contract (`rooks-site`
 * `docs/PRD-S0.md` §5.1 → §5.3, amended §5.8, §5.9 and §5.10).
 *
 * Scope, on purpose: HTTP only. The refresh loop, the offline tolerance and
 * the routes live in `refresh.ts` and `kernel/routes/license.ts`. What this
 * module owns is the SHAPE of those requests, the authentication of the
 * server's answers, and the one recovery the contract asks the daemon to
 * perform.
 *
 * Two values identify this installation, and both must travel:
 *
 *   - `deviceId()` — drawn once, stored in `~/.rooks`. What the server binds
 *     the token's `did` to.
 *   - `fingerprint()` — SHA-256 of the OS machine id. The one value a copy of
 *     `~/.rooks` cannot carry, which is what makes seat counting mean
 *     something (§5.8).
 *
 * `deactivate` sends no fingerprint: releasing a seat we already hold does not
 * require proving the machine. `setMachineName` (§5.10) does send one: naming
 * is a write, and the contract authenticates it exactly like `renew`.
 *
 * Every answer is SIGNED by the server (§5.9, SECU-LICENCES L-10 and the maintainer's
 * request of 04/09/2026): `X-Rooks-Signature: <kid>.<base64url(Ed25519)>`
 * over `<nonce>\n<status>\n<body>`, where the nonce is the one this daemon
 * sent in `X-Rooks-Nonce`. The 200 was already self-authenticating (the JWT
 * is signed), the REFUSALS were not: a rogue server on `ROOKS_LICENSE_SERVER`
 * or a MITM could answer `409 device_mismatch` and make the daemon rotate its
 * device id, or `403 revoked` and switch it off. An answer that does not
 * verify is not a refusal — it is treated as the network failure it is
 * (`LicenseServerError` with `code: 'unsigned_response'`), which the refresh
 * loop counts as offline and never acts upon.
 *
 * `fingerprint()` throws when the OS exposes no machine id, and this module
 * lets that propagate rather than sending a made-up value: an activation bound
 * to a machine that does not exist reads as `device_mismatch` on the very next
 * renew. The caller surfaces it, never a silent pass.
 */
import { randomBytes, verify as verifyCrypto } from 'node:crypto';
import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';
import { BRAND } from '../brand.js';
import { deviceId, rotateDeviceId } from './device.js';
import { fingerprint } from './fingerprint.js';
import { activeKeyring, type LicensePublicKey } from './pubkey.js';

/** Shape of §5.1's 200. Unknown fields are kept out: this module hands the
 *  token to `verifyLicenseToken`, which is the only thing that grants rights. */
export type ActivationResponse = {
  token: string;
  refresh?: { every: number; offlineHours: number };
  license?: unknown;
};

/** An error code the server named (`{ error, message }`), as-is. The caller
 *  decides what each means for the UI — this module only acts on one of them
 *  (`device_mismatch`), because the contract tells it to. */
export class LicenseServerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    /** Body of the refusal, for the codes that carry one (`seat_limit`
     *  lists the activations so the UI can offer to release one). */
    readonly body?: unknown,
  ) {
    super(message ?? code);
    this.name = 'LicenseServerError';
  }
  /** A refusal the server actually made, as opposed to a transport failure
   *  (unreachable, 5xx, unsigned or unparseable answer). Only a refusal may
   *  change the licence state (L-1). */
  get isRefusal(): boolean {
    return this.status >= 400 && this.status < 500 && !TRANSPORT_CODES.has(this.code);
  }
}
const TRANSPORT_CODES = new Set(['unsigned_response', 'invalid_response']);

/** Injected in tests. Same signature as the global `fetch`. */
export type FetchLike = typeof globalThis.fetch;

export type ClientOptions = {
  /** Defaults to `ROOKS_LICENSE_SERVER`, then the brand's domain. */
  baseUrl?: string;
  fetch?: FetchLike;
  /** Keys the answers are verified against. The pinned production keyring by default. */
  keys?: readonly LicensePublicKey[];
  /**
   * Allow the §5.8 recovery (`409 device_mismatch` ⇒ rotate the device id and
   * activate once more). Destructive — the installed token stops verifying —
   * so only the interactive, superadmin-guarded route may pass `true`. The
   * refresh loop never does: a mismatch there is reported, not repaired.
   */
  allowRotate?: boolean;
};

function novaVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * `https://` only, outside tests. A plain-text server could not forge a token
 * nor a signed refusal, but it would read the activation key in transit — and
 * a loopback exception is what a local test server needs.
 */
function baseUrlOf(opts: ClientOptions): string {
  const configured = (opts.baseUrl ?? process.env.ROOKS_LICENSE_SERVER ?? `https://${BRAND.domain}`).replace(/\/+$/, '');
  const url = new URL(configured);
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !loopback && process.env.NODE_ENV !== 'test') {
    throw new LicenseServerError(0, 'insecure_server', `license server must be https:// (got ${url.protocol})`);
  }
  return configured;
}

/** §5 preamble: every route requires this header, so a request without it is
 *  refused before any of the bodies below matter. */
function userAgent(): string {
  return `rooks-daemon/${novaVersion()} (${process.platform})`;
}

/**
 * The label the server shows in the `seat_limit` list. The host name is fine
 * THERE — only the fingerprint must never be derived from it — but not the
 * fully-qualified one: the short name, capped, is all an inventory needs to
 * tell two laptops apart (L-8).
 */
export function deviceLabel(raw = hostname()): string {
  const short = raw.split('.')[0] ?? raw;
  const label = short.trim().slice(0, 32);
  return label === '' ? 'device' : label;
}

/** `<kid>.<base64url sig>` over `<nonce>\n<status>\n<body>`. */
export function verifyResponseSignature(
  header: string | null,
  nonce: string,
  status: number,
  body: string,
  keys: readonly LicensePublicKey[],
): boolean {
  if (!header) return false;
  const dot = header.lastIndexOf('.');
  if (dot <= 0) return false;
  const kid = header.slice(0, dot);
  const signature = header.slice(dot + 1);
  const key = keys.find((candidate) => candidate.keyId === kid);
  if (!key) return false;
  try {
    return verifyCrypto(null, Buffer.from(`${nonce}\n${status}\n${body}`), key.publicKey, Buffer.from(signature, 'base64url'));
  } catch { return false; }
}

async function post(
  path: string,
  body: Record<string, unknown>,
  opts: ClientOptions,
): Promise<unknown> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const nonce = randomBytes(16).toString('base64url');
  const response = await doFetch(`${baseUrlOf(opts)}${path}`, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json', 'user-agent': userAgent(), 'x-rooks-nonce': nonce },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  // An unsigned or badly signed answer did not come from the licence server,
  // whatever its status says: a 502 page from a proxy, a captive portal, a
  // rogue `ROOKS_LICENSE_SERVER`. Surface it as transport, never as a refusal.
  const signature = response.headers.get('x-rooks-signature');
  if (!verifyResponseSignature(signature, nonce, response.status, text, opts.keys ?? activeKeyring())) {
    throw new LicenseServerError(response.status, 'unsigned_response', `license server answer is not signed (HTTP ${response.status})`);
  }
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { /* signed but not JSON: fall through to the status */ }
  if (!response.ok) {
    const named = parsed as { error?: unknown; message?: unknown } | null;
    const code = typeof named?.error === 'string' ? named.error : `http_${response.status}`;
    const message = typeof named?.message === 'string' ? named.message : undefined;
    throw new LicenseServerError(response.status, code, message, parsed);
  }
  return parsed;
}

function tokenFrom(payload: unknown): ActivationResponse {
  const body = payload as { token?: unknown } | null;
  if (typeof body?.token !== 'string' || body.token.trim() === '') {
    throw new LicenseServerError(200, 'invalid_response', 'license server returned no token');
  }
  return payload as ActivationResponse;
}

/** §5.8: the ONE code the daemon knows how to act on by itself. */
export function isDeviceMismatch(err: unknown): boolean {
  return err instanceof LicenseServerError && err.status === 409 && err.code === 'device_mismatch';
}

/** §5.1 body. */
function activateBody(key: string, device: string): Record<string, unknown> {
  return {
    key,
    deviceId: device,
    deviceName: deviceLabel(),
    platform: process.platform,
    appVersion: novaVersion(),
    fp: fingerprint(),
  };
}

/** One activation attempt, with no recovery — the building block both entry
 *  points share. */
async function activateOnce(key: string, device: string, opts: ClientOptions): Promise<ActivationResponse> {
  return tokenFrom(await post('/api/v1/license/activate', activateBody(key, device), opts));
}

/**
 * §5.1 + §5.8 recovery.
 *
 * On `409 device_mismatch` the server is telling us this device id belongs to
 * another machine: `~/.rooks` was copied here. With `allowRotate`, we drop the
 * copied id, draw a fresh one and activate ONCE more. That consumes another
 * seat, or comes back `seat_limit` — both honest answers. Deliberately not a
 * loop and deliberately not recursive: a second mismatch on a brand-new id is
 * not a copy, it is a server or clock problem, and hiding it behind retries
 * would turn one bad install into a seat drain.
 *
 * Nothing else needs threading afterwards: `rotateDeviceId` persists the new
 * id, so `verifyLicenseToken` reads it from disk like any other boot.
 */
export async function activate(key: string, opts: ClientOptions = {}): Promise<ActivationResponse> {
  try {
    return await activateOnce(key, deviceId(), opts);
  } catch (err) {
    if (!opts.allowRotate || !isDeviceMismatch(err)) throw err;
    return activateOnce(key, rotateDeviceId(), opts);
  }
}

/**
 * §5.2 — idempotent heartbeat. Same fingerprint as the activation, otherwise
 * the server answers `device_mismatch` to the very install that activated.
 *
 * A mismatch here goes through the SAME recovery when allowed, and it
 * re-activates rather than re-renewing: a freshly drawn device id has no
 * activation on the server, so renewing it would only earn a 404.
 */
export async function renew(key: string, opts: ClientOptions = {}): Promise<ActivationResponse> {
  const body = { key, deviceId: deviceId(), appVersion: novaVersion(), fp: fingerprint() };
  try {
    return tokenFrom(await post('/api/v1/license/renew', body, opts));
  } catch (err) {
    if (!opts.allowRotate || !isDeviceMismatch(err)) throw err;
    return activateOnce(key, rotateDeviceId(), opts);
  }
}

/**
 * The name a holder gives THIS machine (§5.10). 1 to 32 characters after
 * `trim`, no control character — the server's `parseCustomName`, mirrored so
 * an invalid value never becomes a network call. `null` when the value is not
 * one; the caller refuses, it does not truncate: the name is written once and
 * the holder gets no second try.
 */
export const MACHINE_NAME_MAX = 32;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
export function parseMachineName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MACHINE_NAME_MAX) return null;
  if (CONTROL_CHARACTERS.test(trimmed)) return null;
  return trimmed;
}

/** §5.10: a machine that already carries a name keeps it, and says so. */
export function isNameLocked(err: unknown): boolean {
  return err instanceof LicenseServerError && err.status === 409 && err.code === 'name_locked';
}

/**
 * §5.10 — names this machine, once and for all.
 *
 * Authenticated like `renew` (key + device + fingerprint), because that is
 * what the contract asks: the name is what the holder reads in the console
 * and in a `seat_limit` list, so holding a copy of the key must not be enough
 * to rewrite it. A second attempt comes back `409 name_locked`, a refusal to
 * relay as-is — the server does NOT send the existing name back, and neither
 * the token nor any other route carries it, so a locked machine whose name we
 * never learned stays unnamed as far as this daemon knows.
 *
 * The answer is signed like every other (§5.9): an unsigned one is a network
 * failure, never a refusal, and `post` already makes that distinction.
 */
export async function setMachineName(key: string, name: string, opts: ClientOptions = {}): Promise<string> {
  const customName = parseMachineName(name);
  if (customName === null) {
    throw new LicenseServerError(0, 'invalid_name', `machine name must be 1 to ${MACHINE_NAME_MAX} characters, without control characters`);
  }
  const body = { key, deviceId: deviceId(), fp: fingerprint(), customName };
  const result = await post('/api/v1/license/name', body, opts);
  const named = result as { ok?: unknown; customName?: unknown } | null;
  if (named?.ok !== true || typeof named.customName !== 'string') {
    throw new LicenseServerError(200, 'invalid_response', 'license server did not acknowledge the machine name');
  }
  return named.customName;
}

/** §5.3 — releases the seat. No `fp`, no `appVersion`: the contract asks for
 *  the key and the device, and nothing more. */
export async function deactivate(key: string, opts: ClientOptions = {}): Promise<void> {
  const result = await post('/api/v1/license/deactivate', { key, deviceId: deviceId() }, opts);
  if (!result || typeof result !== 'object' || (result as { ok?: unknown }).ok !== true) {
    throw new LicenseServerError(200, 'invalid_response', 'license server did not acknowledge deactivation');
  }
}
