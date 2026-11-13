/**
 * Which addresses the app must actually listen on (step 5.9.1).
 *
 * Binding `127.0.0.1` alone is what killed the first real launch of the
 * package: on this machine `localhost` resolves to `::1` first, the app
 * answered on IPv4 only, and every chunk webpack asked for on the `localhost`
 * origin timed out. The page rendered, and not a single link worked.
 *
 * So a loopback bind means BOTH loopbacks. Not `::` — that would publish the
 * UI on every interface of the machine, which is a different product with
 * different security. Two sockets on the two loopback addresses, and nothing
 * else changes.
 */

/** Names that mean "the loopback", whichever family the resolver picks. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.trim().toLowerCase());
}

/**
 * The addresses to bind for a configured host.
 *
 * The first one is the primary: a failure there is fatal. The others are
 * best-effort — a machine with IPv6 disabled must still start (`EAFNOSUPPORT`,
 * `EADDRNOTAVAIL`), it just cannot be reached through `::1`, which is exactly
 * the situation the caller wanted to survive.
 */
export function listenHostsFor(host: string): string[] {
  const normalised = host.trim().toLowerCase();
  if (!isLoopbackHost(normalised)) return [host];
  return normalised === '::1' ? ['::1', '127.0.0.1'] : ['127.0.0.1', '::1'];
}
