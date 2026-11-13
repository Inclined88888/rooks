/**
 * Fixed one-minute windows with bounded memory, one budget per key. Same
 * mechanics as the workflow webhook limiter (`workflows/webhooks.ts`), copied
 * rather than imported: triggers must not depend on the Workflows plugin,
 * which may be switched off. Unlike it, each key carries its own ceiling — a
 * route sets its own rate.
 */
const WINDOW_MS = 60_000;
const MAX_KEYS = 10_000;

export type LimitKey = { key: string; max: number };

export function rateLimiter(now: () => number = Date.now) {
  const attempts = new Map<string, { count: number; at: number }>();
  let sweptAt = 0;
  return (keys: readonly LimitKey[]): boolean => {
    const time = now();
    if (time - sweptAt >= WINDOW_MS) {
      for (const [key, state] of attempts) if (time - state.at >= WINDOW_MS) attempts.delete(key);
      sweptAt = time;
    }
    if (keys.some(({ key, max }) => {
      const state = attempts.get(key);
      return state && time - state.at < WINDOW_MS && state.count >= max;
    })) return false;
    if (attempts.size + keys.filter(({ key }) => !attempts.has(key)).length > MAX_KEYS) return false;
    for (const { key } of keys) {
      const old = attempts.get(key);
      const state = old && time - old.at < WINDOW_MS ? old : { count: 0, at: time };
      attempts.set(key, { count: state.count + 1, at: state.at });
    }
    return true;
  };
}
