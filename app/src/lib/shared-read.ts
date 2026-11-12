/**
 * One network read for every identical GET already in flight.
 *
 * Opening `/chat` mounts a dozen surfaces that each ask the daemon the same
 * thing (`/api/ui/auth/me` eight times, `/api/ui/projects` twice…). The daemon
 * answers in milliseconds, but the browser only opens six connections per
 * origin and two of them are held by SSE streams: every duplicate queues in
 * front of the conversation itself (trace of 26/09/2026, ~90 requests).
 *
 * Only OVERLAPPING reads are shared: a settled answer is never replayed, so a
 * read issued after a save, a login or an account switch always reaches the
 * daemon. Each caller gets its own clone and owns its body.
 */
const pending = new Map<string, Promise<Response>>();

export async function sharedGet(url: string): Promise<Response> {
  let request = pending.get(url);
  if (!request) {
    const read: Promise<Response> = fetch(url, { cache: 'no-store' }).finally(() => {
      if (pending.get(url) === read) pending.delete(url);
    });
    request = read;
    pending.set(url, request);
  }
  return (await request).clone();
}

/**
 * Stops sharing the reads in flight: a read started under the previous
 * account (its `/api/ui/auth/me` above all) must not answer the next one.
 * Their callers still get their own answer; only later callers start anew.
 */
export function forgetSharedReads(): void {
  pending.clear();
}
