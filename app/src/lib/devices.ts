/**
 * Paired devices of the signed-in account, as the daemon serves them through
 * `/api/ui/devices` (`orchestrator/src/users/devices-http.ts`). A listing
 * never carries a token; the pairing code is shown once, then forgotten.
 */
export type DeviceStatus = 'active' | 'revoked' | 'expired';

export type PairedDevice = {
  id: string;
  user_id: string;
  name: string;
  created_at: number;
  last_seen_at: number;
  /** Address the daemon saw: the relay that carried the requests, not the browser. */
  last_ip: string | null;
  user_agent: string | null;
  revoked_at: number | null;
  expires_at: number;
  status: DeviceStatus;
  /** The device this very request came through. */
  current: boolean;
};

export type PairingCode = { code: string; expiresAt: number };

/** Same bound as the daemon's `DEVICE_NAME_MAX`: a longer name is a 400. */
export const DEVICE_NAME_MAX = 64;

const BASE = '/api/ui/devices';

/** `error` is the daemon's machine-readable code (`too_many_codes`, `forbidden`…), never shown as is. */
export type DeviceFailure = { ok: false; status: number; error: string | null };
export type DeviceResult<T> = { ok: true; value: T } | DeviceFailure;

async function failure(response: Response): Promise<DeviceFailure> {
  const body = await response.json().catch(() => ({})) as { error?: unknown };
  return { ok: false, status: response.status, error: typeof body.error === 'string' ? body.error : null };
}

export type DeviceErrorKind = 'tooManyCodes' | 'notHere' | 'invalidName' | 'notFound' | 'generic';

/** Which localized message a failed call deserves. */
export function deviceErrorKind(failure: Pick<DeviceFailure, 'status' | 'error'>): DeviceErrorKind {
  if (failure.error === 'too_many_codes') return 'tooManyCodes';
  // A device or a mission cannot mint a code: it has to be done on the machine itself.
  if (failure.status === 403) return 'notHere';
  if (failure.status === 400) return 'invalidName';
  if (failure.status === 404) return 'notFound';
  return 'generic';
}

export async function listDevices(): Promise<DeviceResult<PairedDevice[]>> {
  const response = await fetch(BASE, { cache: 'no-store' });
  if (!response.ok) return failure(response);
  const body = await response.json() as { devices?: PairedDevice[] };
  return { ok: true, value: body.devices ?? [] };
}

export async function issuePairingCode(): Promise<DeviceResult<PairingCode>> {
  const response = await fetch(`${BASE}/pairing-codes`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store', body: '{}',
  });
  if (!response.ok) return failure(response);
  const body = await response.json() as { code: string; expires_at: number };
  return { ok: true, value: { code: body.code, expiresAt: body.expires_at } };
}

export async function renameDevice(id: string, name: string): Promise<DeviceResult<PairedDevice>> {
  const response = await fetch(`${BASE}/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, cache: 'no-store',
    body: JSON.stringify({ name }),
  });
  if (!response.ok) return failure(response);
  return { ok: true, value: (await response.json() as { device: PairedDevice }).device };
}

export async function revokeDevice(id: string): Promise<DeviceResult<PairedDevice>> {
  const response = await fetch(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE', cache: 'no-store' });
  if (!response.ok) return failure(response);
  return { ok: true, value: (await response.json() as { device: PairedDevice }).device };
}

/** Whole seconds a code has left, never negative. */
export function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

/** `4:05`: minutes, then two-digit seconds. */
export function formatCountdown(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** What a rename field may submit, or null when the daemon would refuse it. */
export function cleanDeviceName(raw: string): string | null {
  const name = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (name.length === 0 || name.length > DEVICE_NAME_MAX || /[\u0000-\u001f\u007f-\u009f]/.test(name)) return null;
  return name;
}

/** Live devices first (the one in use on top), then the expired, then the revoked. */
export function sortDevices(devices: readonly PairedDevice[]): PairedDevice[] {
  const rank = (device: PairedDevice): number =>
    device.current ? 0 : device.status === 'active' ? 1 : device.status === 'expired' ? 2 : 3;
  return [...devices].sort((a, b) => rank(a) - rank(b) || b.last_seen_at - a.last_seen_at);
}

/** Why `tailscale serve` could not publish this daemon (`orchestrator/src/tailnet-publish.ts`), plus the two refusals of the route. */
export type ReachableFailureReason =
  | 'not_installed' | 'not_connected' | 'serve_disabled' | 'permission' | 'no_free_port' | 'listen_not_loopback' | 'unreadable' | 'failed'
  | 'notHere' | 'generic';

const DAEMON_REASONS: ReadonlySet<string> = new Set([
  'not_installed', 'not_connected', 'serve_disabled', 'permission', 'no_free_port', 'listen_not_loopback', 'unreadable', 'failed',
]);

export type ReachableFailure = {
  ok: false;
  reason: ReachableFailureReason;
  /** OS of the daemon's machine, which words the elevation; `null` when the daemon did not say. */
  platform: string | null;
  command: string | null;
  enableUrl: string | null;
  detail: string | null;
};

export type ReachableOutcome = { ok: true; address: string } | ReachableFailure;

/** Only the admin console may be linked: the URL comes from tailscale's output, relayed by the daemon. */
const ENABLE_URL_PREFIX = 'https://login.tailscale.com/';

const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

export function reachableOutcome(status: number, body: unknown): ReachableOutcome {
  const fields = (body ?? {}) as Record<string, unknown>;
  if (status === 200) {
    const address = text(fields.address);
    if (address?.startsWith('https://')) return { ok: true, address };
  }
  const failure = (reason: ReachableFailureReason): ReachableFailure => {
    const enableUrl = text(fields.enable_url);
    return {
      ok: false,
      reason,
      platform: text(fields.platform),
      command: text(fields.command),
      enableUrl: enableUrl?.startsWith(ENABLE_URL_PREFIX) ? enableUrl : null,
      detail: text(fields.detail),
    };
  };
  if (status === 409 && typeof fields.reason === 'string' && DAEMON_REASONS.has(fields.reason)) {
    return failure(fields.reason as ReachableFailureReason);
  }
  // Refused by the route: a device, a mission, or someone who is not an administrator.
  if (status === 403) return { ok: false, reason: 'notHere', platform: null, command: null, enableUrl: null, detail: null };
  return { ok: false, reason: 'generic', platform: null, command: null, enableUrl: null, detail: null };
}

/** Ask the daemon to publish itself on the tailnet, and read back the address it got. */
export async function makeMachineReachable(): Promise<ReachableOutcome> {
  try {
    const response = await fetch(`${BASE}/reachable`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store', body: '{}',
    });
    return reachableOutcome(response.status, await response.json().catch(() => null));
  } catch {
    return reachableOutcome(0, null);
  }
}
