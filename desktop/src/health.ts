import { instanceId } from './service.js';
/** A public health response must name both the product and the data directory.
 *  Authentication errors, redirects and old unidentified daemons are inconclusive. */

export type Identity = 'rooks' | 'foreign';

export type HealthResult =
  /** `packaged` is absent before 0.1.6: unknown, never read as "not packaged". */
  | { ok: true; status: number; identity: Identity; instance?: string; updatePending?: boolean; packaged?: boolean }
  | { ok: false; status: number | null; error?: string };

/** The daemon's own id, as `plugins-bundled/http/routes.ts` publishes it. */
export const SERVICE_ID = 'rooks';

async function identify(res: Response): Promise<{ identity: Identity; instance?: string; updatePending?: boolean; packaged?: boolean }> {
  if (!res.ok) return { identity: 'foreign' };
  try {
    const body = await res.json() as { service?: unknown; instance?: unknown; status?: unknown; packaged?: unknown } | null;
    if (body?.service !== SERVICE_ID) return { identity: 'foreign' };
    return { identity: 'rooks', ...(body.status === 'update_pending' ? { updatePending: true } : {}), ...(typeof body.instance === 'string' ? { instance: body.instance } : {}),
      ...(typeof body.packaged === 'boolean' ? { packaged: body.packaged } : {}) };
  } catch { return { identity: 'foreign' }; }
}

/**
 * Why a probe got nothing, in words a log reader can act on. `fetch` says
 * "fetch failed" for every network error and hides the cause in `cause.code`;
 * a tester's log then reads the same whether nothing listens or a daemon
 * holds the port without replying (Windows, 21/10/2026: five exchanges to
 * tell the two apart). Kept with the diagnostic's copy in
 * `orchestrator/src/host/diagnostic-report.ts` — two packages, same wording.
 */
export function probeFailureReason(e: unknown): string {
  const error = e as { name?: string; message?: string; cause?: { code?: string; message?: string; errors?: { code?: string }[] } } | null;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return 'connected, but no reply in time: the daemon is still starting, or busy';
  }
  // `localhost` resolves to two addresses: undici then wraps both failures in
  // an AggregateError whose own `code` is empty.
  const cause = error?.cause;
  const code = cause?.code ?? cause?.errors?.find((inner) => inner?.code)?.code
    ?? /\b(E[A-Z]{3,})\b/.exec(cause?.message ?? '')?.[1];
  if (code === 'ECONNREFUSED') return 'connection refused: nothing listens on the port';
  if (code === 'ECONNRESET') return 'connection reset: the daemon closed it without replying';
  if (code) return `${code}: ${error?.message ?? ''}`.trim();
  return error?.message ?? 'unknown';
}

/** One-shot probe. Never throws: a dead daemon is an expected state here. */
export async function probeHealth(origin: string, timeoutMs = 1500): Promise<HealthResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(`${origin}/api/health`, { signal, redirect: 'manual' });
    return { ok: true, status: res.status, ...await identify(res) };
  } catch (e) {
    return { ok: false, status: null, error: probeFailureReason(e) };
  }
}

/** Answered, and answered as Rooks. */
export function isRooks(result: HealthResult, home?: string): boolean {
  return result.ok && result.identity === 'rooks' && (home === undefined || result.instance === instanceId(home));
}

/**
 * Polls until the daemon answers or the budget runs out. Used by the embedded
 * mode (§5.2) after spawning the daemon, and by the tray to refresh its state.
 */
export async function waitForHealth(
  origin: string,
  budgetMs: number,
  intervalMs = 300,
): Promise<HealthResult> {
  const deadline = Date.now() + budgetMs;
  let last: HealthResult = { ok: false, status: null, error: 'not probed' };
  for (;;) {
    last = await probeHealth(origin, Math.min(1500, intervalMs * 4));
    // A foreign server answering here will not become Rooks by waiting; the
    // caller decides what to say about it.
    if (last.ok) return last;
    if (Date.now() + intervalMs >= deadline) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
