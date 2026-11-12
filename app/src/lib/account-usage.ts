/**
 * First-party reading of GET /api/ui/usage.
 *
 * A missing CLI session is an idle state (`connected: false`), not a
 * transport failure. Callers must not match the English error sentence.
 */

export type AccountUsageView =
  | { kind: 'ok' }
  | { kind: 'unsupported' }
  | { kind: 'disconnected'; backend: string }
  | { kind: 'error'; message: string };

function asRecord(body: unknown): Record<string, unknown> | null {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
}

function errorMessage(body: unknown, fallback: string): string {
  const rec = asRecord(body);
  return typeof rec?.error === 'string' && rec.error.trim() ? rec.error : fallback;
}

export function interpretUsageResponse(status: number, body: unknown): AccountUsageView {
  if (status === 503) {
    return { kind: 'error', message: errorMessage(body, 'Usage unavailable') };
  }
  const rec = asRecord(body);
  if (status !== 200 || !rec) {
    return { kind: 'error', message: errorMessage(body, `Usage unavailable (${status})`) };
  }
  if (rec.supported === false) return { kind: 'unsupported' };
  if (rec.supported === true && rec.connected === false) {
    return {
      kind: 'disconnected',
      backend: typeof rec.backend === 'string' ? rec.backend : '',
    };
  }
  if (rec.supported === true) return { kind: 'ok' };
  return { kind: 'error', message: errorMessage(body, 'Usage unavailable') };
}

/** Keep polling on real failures; a missing session will not appear by retrying. */
export function usageShouldKeepPolling(view: AccountUsageView): boolean {
  return view.kind !== 'disconnected';
}
