/**
 * Origin the client actually reached us on, rebuilt from the request.
 *
 * Why this exists (step 5.9.6). The URL Next hands the middleware is built by
 * the SERVER, from its own bind address: `next-server.js:1162` composes
 * `${protocol}://${fetchHostname}:${port}${req.url}`. It can therefore never
 * carry the host the browser typed — `req.nextUrl` says `localhost` (or the
 * bind address) whatever happened on the wire, which is how a browser sitting
 * on `127.0.0.1:3110` was sent to `localhost:3110` before step 5.9.1. And a
 * RELATIVE `Location`, the fix attempted then, never reaches the browser at
 * all: the middleware adapter reparses it with `new NextURL(location, opts)`,
 * without a base (`adapter.js:242`), and throws `Invalid URL`.
 *
 * The only witness of the client's own origin is the `Host` header, which a
 * browser sets itself and a page cannot forge cross-origin (it is a forbidden
 * header name). So: host from `Host`, scheme from `X-Forwarded-Proto` when a
 * proxy set it — the same signal, and the same trust, that `lib/remote/auth.ts`
 * already relies on to decide a request came in over HTTPS.
 *
 * `X-Forwarded-Host` is deliberately NOT read. Nothing in the product sets it,
 * any client can send it, and honouring it would let a request choose the
 * origin of our own redirect — a wider trust than this fix needs.
 *
 * Everything is validated by actually building the URL: a malformed authority
 * (`user@evil.com`, `evil.com/login`, `evil.com#x`) or an impossible port
 * (`:99999`, which `new URL` rejects) falls back to the origin Next computed. The redirect must
 * never be the thing that throws — that was the outage.
 */

export function clientOrigin(
  headers: { get(name: string): string | null },
  fallbackOrigin: string,
): string {
  const fallback = new URL(fallbackOrigin);
  const host = headers.get('host')?.trim();
  if (!host) return fallback.origin;
  const forwarded = headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const scheme = forwarded === 'https' || forwarded === 'http'
    ? forwarded
    : fallback.protocol.replace(':', '');
  try {
    const candidate = new URL(`${scheme}://${host}`);
    // `new URL` is lenient about what follows the authority; anything past it
    // means the header was not a bare `name[:port]` and must not be trusted.
    if (candidate.pathname !== '/' || candidate.search || candidate.hash
      || candidate.username || candidate.password) {
      return fallback.origin;
    }
    return candidate.origin;
  } catch {
    return fallback.origin;
  }
}
