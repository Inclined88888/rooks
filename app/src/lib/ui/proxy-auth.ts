/**
 * How the Next proxy authenticates to the daemon.
 *
 * A browser session cookie identifies the user. The proxy never sends
 * `ROOKS_DAEMON_TOKEN`: that header is for CLI, MCP and in-flight
 * agents, which talk to the daemon directly and never go through here.
 *
 * These headers are for the local daemon. When the target is a remote
 * machine, `relayFetch` (`lib/machines/target.ts`) drops the cookie and sends
 * that machine's device token instead: a local session never leaves.
 */
export const SESSION_COOKIE = 'rooks_session';

export function proxyAuthHeaders(opts: {
  sessionToken?: string | null;
}): Record<string, string> {
  const session = opts.sessionToken?.trim();
  if (!session) return {};
  return { cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}` };
}

/**
 * What the daemon's cross-site check (`isCrossSiteMutation`) needs to see of
 * the browser's own request. The proxy's fetch carries Node's headers, not the
 * browser's, so without this every mutation looks like a bare client to the
 * daemon and the check passes blind.
 *
 * `Sec-Fetch-Site` is authoritative on the daemon when present. `Origin` is
 * compared there to the host the browser used, which is why that host travels
 * as `X-Forwarded-Host` (the daemon itself is reached on its own address).
 */
export function browserOriginHeaders(incoming: { get(name: string): string | null }): Record<string, string> {
  const out: Record<string, string> = {};
  const site = incoming.get('sec-fetch-site');
  if (site) out['sec-fetch-site'] = site;
  const origin = incoming.get('origin');
  if (origin) {
    out.origin = origin;
    const host = incoming.get('x-forwarded-host')?.split(',')[0]?.trim() || incoming.get('host')?.trim();
    if (host) out['x-forwarded-host'] = host;
  }
  return out;
}
