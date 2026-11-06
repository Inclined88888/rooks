/**
 * Whether a mutation reaching a Next route came from another origin — the
 * opaque origin of a sandboxed document first (ADR-MCPUI D3, D4).
 *
 * The document's own barriers come first: its CSP (`connect-src 'none'`,
 * `form-action 'none'`) blocks the request, and a request from an opaque
 * origin is cross-site, so the `Lax` session cookie is not attached. This is
 * the third one, on the routes that answer or close a document: the Next
 * proxy does not relay `Origin` nor `Sec-Fetch-Site` to the daemon, so the
 * daemon's own cross-site check cannot see them.
 *
 * `Sec-Fetch-Site` is authoritative when present (anything but
 * `same-origin` refused); else an `Origin` of `null`, or one whose host is
 * not the `Host` the request came in on, is refused. Neither header: a
 * non-browser client, which carries no session cookie by accident.
 */
export function foreignMutation(headers: { get(name: string): string | null }): boolean {
  const site = headers.get('sec-fetch-site');
  if (site !== null) return site !== 'same-origin';
  const origin = headers.get('origin');
  if (origin === null) return false;
  if (origin === 'null') return true;
  const host = headers.get('host')?.trim();
  try {
    return !host || new URL(origin).host !== host;
  } catch {
    return true;
  }
}

export function foreignMutationRefusal(): Response {
  return new Response(JSON.stringify({ error: 'cross_origin', message: 'this action is taken from a Timon page' }), {
    status: 403,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
