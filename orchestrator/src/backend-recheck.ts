/**
 * Live re-check of a sidelined backend, BEFORE a spawn is refused.
 *
 * WHY (tester incident, macOS, 0.1.5-rc.8, 2026-10-18). A codex turn ended on a
 * usage-limit sentence at 15:26; `backend_cooldowns` estimated the reopening at
 * "now + 5 h" (a textual hit carries no time) and every spawn until 20:26 was
 * refused — while the LLM Quota widget, which asks the provider, showed the
 * account green after its real reset. The registry was being trusted as the
 * truth; it is only a record of the last failure.
 *
 * Rule (decision of 2026-10-18): a recorded exclusion never decides on its own
 * whether an LLM call may start. Before each spawn the backend is re-tested:
 *
 *   1. for a QUOTA exclusion, the account's usage probe (`getBackendUsage`, the
 *      same one the widget reads) decides — a full window keeps the refusal and
 *      replaces the estimate with the provider's reset time; no full window
 *      lifts the exclusion;
 *   2. with no answer to read (no probe for this backend, probe down, not
 *      signed in) and for the two other families (402 without credit, circuit
 *      breaker), the spawn itself is the test: ONE attempt per backend per
 *      `RECHECK_INTERVAL_MS`. A turn that succeeds lifts the exclusion
 *      (`clearBackendCooldown` in agent.ts), a new failure records it again.
 *
 * The interval is also how long the failure that recorded the exclusion stays
 * the freshest evidence there is: probes cache their answer (up to 2 min for
 * copilot), so a reading taken in that window may predate the failure itself.
 * Without that bound, the night of 2026-08-22 (36 turns into a dry backend in a
 * row) would come back, one spawn per minute.
 */
import { dbApi } from './db.js';
import { asBackendName, getBackend, type BackendName } from './backends/index.js';
import type { AccountUsage } from './backends/types.js';
import { getBackendUsage } from './usage.js';
import { messageTime } from './message-dates.js';

/** Minimum gap between two real tests of the same sidelined backend. */
export const RECHECK_INTERVAL_MS = 2 * 60_000;

/** A probe slower than this answers nothing: the spawn path must not hang on
 *  a provider endpoint (copilot spawns its CLI to answer). */
const PROBE_TIMEOUT_MS = 10_000;

/** Last trial spawn allowed per backend, in ms epoch. In memory on purpose: a
 *  restart that forgets it costs one extra attempt, nothing more. */
const lastTrial = new Map<string, number>();

/** Probe running per backend: a spawn and the sweep asking at the same moment
 *  share one request instead of hitting the provider twice. */
const inflight = new Map<string, Promise<UsageVerdict | null>>();

/** Last probe started per backend, whoever asked. Only the sweep reads it: a
 *  spawn keeps its own rule (a probe with no answer leaves room for a trial). */
const lastProbe = new Map<string, number>();

export type UsageVerdict =
  | { state: 'open' }
  | { state: 'dry'; resetsAt: number; window: string };

/**
 * What a usage reading says about the quota, or null when it says nothing
 * (no window reported). A window counts as full at 100 % with a reset still
 * ahead; the latest such reset is when the account reopens.
 */
export function usageVerdict(usage: AccountUsage, now = Date.now()): UsageVerdict | null {
  let known = false;
  let dry: { resetsAt: number; window: string } | null = null;
  for (const [window, w] of Object.entries(usage.windows)) {
    if (!w) continue;
    known = true;
    const resetsAt = Date.parse(w.resets_at);
    if (w.utilization < 100 || !Number.isFinite(resetsAt) || resetsAt <= now) continue;
    if (!dry || resetsAt > dry.resetsAt) dry = { resetsAt, window };
  }
  if (dry) return { state: 'dry', ...dry };
  return known ? { state: 'open' } : null;
}

type Probe = (backend: BackendName) => Promise<UsageVerdict | null>;

async function probeUsage(backend: BackendName): Promise<UsageVerdict | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
    timer.unref();
  });
  try {
    const report = await Promise.race([getBackendUsage(backend), timeout]);
    if (!report || !report.supported || !report.connected) return null;
    return usageVerdict(report.usage);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let probe: Probe = probeUsage;

function probeOnce(name: BackendName): Promise<UsageVerdict | null> {
  const running = inflight.get(name);
  if (running) return running;
  lastProbe.set(name, Date.now());
  const pending = probe(name).catch(() => null).finally(() => inflight.delete(name));
  inflight.set(name, pending);
  return pending;
}

/** Test seam: replaces the usage probe; `null` restores the real one. */
export function setUsageProbeForTest(fn: Probe | null): void {
  probe = fn ?? probeUsage;
  lastTrial.clear();
  lastProbe.clear();
  inflight.clear();
}

/**
 * True when `backend` must NOT be spawned right now — the only question a
 * spawn path may ask about a sidelined backend.
 *
 * `claimTrial`: the caller is the spawn itself (`spawnTurn`, a message to a
 * live session) and takes the trial slot when it goes ahead without a probe
 * answer. An upstream router (dispatcher, wake) passes false: it only decides
 * whether to redirect, and the spawn it leads to claims the slot.
 */
export async function backendStillDry(
  backend: string | null | undefined,
  opts: { claimTrial: boolean },
): Promise<boolean> {
  const name = asBackendName(backend);
  if (!name) return false;
  const row = dbApi.getBackendCooldown(name);
  if (!row) return false;
  const now = Date.now();
  if (row.until <= now) {
    dbApi.clearBackendCooldown(name);
    return false;
  }
  if (now - Math.max(row.noted_at, lastTrial.get(name) ?? 0) < RECHECK_INTERVAL_MS) return true;

  if (row.kind === 'rate_limit') {
    const verdict = await probeOnce(name);
    // The registry may have moved while the probe ran: a turn that succeeded
    // cleared it, or a fresh failure re-recorded it. Its newest state wins.
    const current = dbApi.getBackendCooldown(name);
    if (!current) return false;
    if (current.noted_at !== row.noted_at) return current.until > Date.now();
    if (verdict?.state === 'open') {
      dbApi.clearBackendCooldown(name);
      console.log(`[fallback] backend ${name}: usage probe shows its quota open — exclusion lifted`);
      return false;
    }
    if (verdict?.state === 'dry') {
      // Kept for display: the provider's reset time replaces the estimate.
      dbApi.setBackendCooldown(name, verdict.resetsAt, verdict.window, true, 'rate_limit');
      console.warn(
        `[fallback] backend ${name}: usage probe confirms ${verdict.window} full ` +
        `— sidelined until ${messageTime(verdict.resetsAt)}`,
      );
      return true;
    }
  }

  if (opts.claimTrial) {
    lastTrial.set(name, Date.now());
    console.log(`[fallback] backend ${name}: sidelined as ${row.kind}, nothing to ask — this spawn is the test`);
  }
  return false;
}

/** Gap between two sweeps of the quota exclusions. */
export const SWEEP_INTERVAL_MS = 3 * 60_000;

/** Probes run at once by a sweep: twenty accounts out of quota must not open
 *  twenty provider requests (copilot spawns its CLI to answer). */
const SWEEP_CONCURRENCY = 2;

/** Whether `name` has a usage probe to ask. Without one, only a spawn can test
 *  the backend, and the sweep has no spawn to offer. */
function hasUsageProbe(name: BackendName): boolean {
  try {
    return typeof getBackend(name).accountUsage === 'function';
  } catch {
    return false;
  }
}

let sweeping: Promise<void> | null = null;

/**
 * Re-tests every quota exclusion against its usage probe, with no spawn
 * needed (TIM-0122). The re-check above only runs when something is about to
 * start on the backend: an account nobody picks — precisely because it shows
 * "Out of quota" — kept its estimated 5 h exclusion while the quota widget,
 * reading the same probe, showed it open.
 *
 * Only `rate_limit` rows: a 402 or an open breaker are not settled by a usage
 * window (cf. `backendStillDry`). A sweep that is still running when the next
 * one is due is joined, not doubled.
 */
export function sweepQuotaCooldowns(): Promise<void> {
  sweeping ??= runSweep().finally(() => { sweeping = null; });
  return sweeping;
}

async function runSweep(): Promise<void> {
  const now = Date.now();
  const due: BackendName[] = [];
  for (const row of dbApi.listBackendCooldowns()) {
    if (row.kind !== 'rate_limit' || row.until <= now) continue;
    const name = asBackendName(row.backend);
    if (!name || !hasUsageProbe(name)) continue;
    if (now - Math.max(row.noted_at, lastProbe.get(name) ?? 0) < RECHECK_INTERVAL_MS) continue;
    due.push(name);
  }
  const worker = async (): Promise<void> => {
    for (let name = due.shift(); name; name = due.shift()) {
      try {
        await backendStillDry(name, { claimTrial: false });
      } catch (err) {
        console.warn(`[fallback] backend ${name}: quota re-check failed: ${(err as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, due.length) }, worker));
}

/** Starts the periodic sweep; returns its stop. Owned by `@rooks/backends`. */
export function startQuotaRecheckSweep(intervalMs = SWEEP_INTERVAL_MS): () => void {
  const timer = setInterval(() => { void sweepQuotaCooldowns(); }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
