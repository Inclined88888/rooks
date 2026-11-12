/**
 * The steps before "Make this machine reachable": install Tailscale, sign in,
 * and on Linux let Rooks drive it without sudo. The daemon runs each step as a
 * job (`orchestrator/src/tailscale-setup.ts`); this module reads its answers
 * and decides, purely, what the card shows next.
 */

const BASE = '/api/ui/devices/tailscale';

export type TailscaleNodeState =
  | 'not_installed' | 'unreachable' | 'unreadable' | 'needs_login' | 'stopped' | 'starting' | 'running';

export type SetupStep = 'install' | 'connect' | 'operator';
/** `handoff`: the daemon verified the package, the desktop app opens it in the user's session. */
export type SetupPhase = 'downloading' | 'verifying' | 'installing' | 'handoff' | 'waiting_login' | 'done' | 'failed';

export type SetupJob = {
  kind: SetupStep;
  phase: SetupPhase;
  failure: string | null;
  command: string | null;
  detail: string | null;
  authUrl: string | null;
  /** When the daemon started it: tells one job from the next. */
  startedAt: number | null;
};

export type TailscaleSetupStatus = {
  platform: string | null;
  state: TailscaleNodeState;
  error: string | null;
  job: SetupJob | null;
};

/** What the daemon may answer as a failure; anything else reads as `failed`. */
const FAILURES: ReadonlySet<string> = new Set([
  'download_failed', 'checksum_mismatch', 'signature_invalid', 'no_desktop', 'elevation_unavailable', 'cancelled',
  'installer_failed', 'unsupported', 'not_installed', 'not_running', 'permission', 'failed',
]);
const STATES: ReadonlySet<string> = new Set(['not_installed', 'unreachable', 'unreadable', 'needs_login', 'stopped', 'starting', 'running']);
const STEPS: ReadonlySet<string> = new Set(['install', 'connect', 'operator']);
const PHASES: ReadonlySet<string> = new Set(['downloading', 'verifying', 'installing', 'handoff', 'waiting_login', 'done', 'failed']);
const ACTIVE: ReadonlySet<SetupPhase> = new Set(['downloading', 'verifying', 'installing', 'handoff', 'waiting_login']);

/** The sign-in page is only ever linked on Tailscale's own login host. */
const AUTH_URL_PREFIX = 'https://login.tailscale.com/';
/** Where HTTPS certificates are turned on, when tailscale printed no direct link. */
export const TAILSCALE_HTTPS_CONSOLE = 'https://login.tailscale.com/admin/dns';

const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

function parseJob(raw: unknown): SetupJob | null {
  if (!raw || typeof raw !== 'object') return null;
  const job = raw as Record<string, unknown>;
  if (typeof job.kind !== 'string' || !STEPS.has(job.kind) || typeof job.phase !== 'string' || !PHASES.has(job.phase)) return null;
  const failure = text(job.failure);
  const authUrl = text(job.auth_url);
  return {
    kind: job.kind as SetupStep,
    phase: job.phase as SetupPhase,
    failure: failure === null ? null : FAILURES.has(failure) ? failure : 'failed',
    command: text(job.command),
    detail: text(job.detail),
    authUrl: authUrl?.startsWith(AUTH_URL_PREFIX) ? authUrl : null,
    startedAt: typeof job.started_at === 'number' && Number.isFinite(job.started_at) ? job.started_at : null,
  };
}

/** A daemon answer, or `null` when it is not one (refused, unreachable, older daemon). */
export function parseSetupStatus(status: number, body: unknown): TailscaleSetupStatus | null {
  if (status !== 200 && status !== 202) return null;
  const fields = (body ?? {}) as Record<string, unknown>;
  if (typeof fields.state !== 'string' || !STATES.has(fields.state)) return null;
  return {
    platform: text(fields.platform),
    state: fields.state as TailscaleNodeState,
    error: text(fields.error),
    job: parseJob(fields.job),
  };
}

export function isActive(job: SetupJob | null): boolean {
  return job !== null && ACTIVE.has(job.phase);
}

/** What the card offers now. */
export type SetupView =
  | { kind: 'busy'; step: SetupStep; phase: SetupPhase; authUrl: string | null }
  | { kind: 'offer'; step: 'install' | 'connect'; failure: SetupJob | null }
  | { kind: 'unreadable'; error: string | null }
  | { kind: 'ready' };

/**
 * The next thing to show. A failed job stays visible next to the button that
 * retries it, so the person reads why before clicking again.
 */
export function setupView(status: TailscaleSetupStatus): SetupView {
  const job = status.job;
  if (job && isActive(job)) return { kind: 'busy', step: job.kind, phase: job.phase, authUrl: job.authUrl };
  if (status.state === 'running') return { kind: 'ready' };
  if (status.state === 'unreadable') return { kind: 'unreadable', error: status.error };
  if (status.state === 'starting') return { kind: 'busy', step: 'connect', phase: 'waiting_login', authUrl: null };
  const failed = job?.phase === 'failed' ? job : null;
  if (status.state === 'not_installed') return { kind: 'offer', step: 'install', failure: failed?.kind === 'install' ? failed : null };
  return { kind: 'offer', step: 'connect', failure: failed && failed.kind !== 'operator' ? failed : null };
}

/** Polled while something is in progress: an installer, a sign-in, a node starting. */
export function shouldPoll(status: TailscaleSetupStatus | null): boolean {
  if (!status) return false;
  return isActive(status.job) || status.state === 'starting';
}

async function call(method: 'GET' | 'POST', path: string, body: Record<string, string> = {}): Promise<TailscaleSetupStatus | null> {
  try {
    const response = await fetch(path, {
      method,
      cache: 'no-store',
      ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    return parseSetupStatus(response.status, await response.json().catch(() => null));
  } catch {
    return null;
  }
}

export function readTailscaleSetup(): Promise<TailscaleSetupStatus | null> {
  return call('GET', BASE);
}

/** `desktop`: the request comes from the Rooks desktop app, which opens the installer when the daemon cannot. */
export function startTailscaleStep(step: SetupStep, opts: { desktop?: boolean } = {}): Promise<TailscaleSetupStatus | null> {
  return call('POST', `${BASE}/${step}`, step === 'install' && opts.desktop ? { client: 'desktop' } : {});
}

/** What the install proxy passes on: that the desktop app asks, rebuilt, and nothing else. */
export function installProxyBody(body: unknown): { client?: 'desktop' } {
  return (body as { client?: unknown } | null)?.client === 'desktop' ? { client: 'desktop' } : {};
}

/** What the report proxy passes on: the three fields the daemon reads (it validates them strictly). */
export function installerReportProxyBody(body: unknown): Record<string, unknown> {
  const fields = (body && typeof body === 'object' ? body : {}) as { sha256?: unknown; outcome?: unknown; code?: unknown };
  return {
    sha256: fields.sha256,
    outcome: fields.outcome,
    ...(fields.code === undefined ? {} : { code: fields.code }),
  };
}

/**
 * The job the desktop app has to open an installer for, keyed so it is asked
 * once per job (a re-render, a poll, a second card never open a second one).
 */
export function handoffKey(status: TailscaleSetupStatus | null | undefined): string | null {
  const job = status?.job;
  if (!job || job.kind !== 'install' || job.phase !== 'handoff') return null;
  return `install:${job.startedAt ?? 'unknown'}`;
}

/** What the desktop app answered after its installer; anything unknown is a failure. */
export function installerOutcomeOf(value: unknown): 'installed' | 'cancelled' | 'none' | 'busy' | 'failed' {
  const status = (value && typeof value === 'object' ? (value as { status?: unknown }).status : null);
  return status === 'installed' || status === 'cancelled' || status === 'none' || status === 'busy' ? status : 'failed';
}
