/**
 * Where the daemon's HTTP API actually binds (TODO #339).
 *
 * `app.listen(port)` without a host binds `::`, every interface of the
 * machine, while the auth and first-account guards decide on
 * `daemon.listen.host`: a loopback config then let an anonymous LAN request
 * reach the setup routes before the first account existed. The socket has to
 * say what the config says.
 *
 * A loopback bind means BOTH loopbacks: `localhost` resolves to `::1` first on
 * many machines, and the desktop probes `127.0.0.1` as well as `localhost`.
 * Never `::` — that is every interface again. Same rule as the app's
 * `app/src/lib/listen-hosts.ts` (step 5.9.1); copied, the two packages being
 * independent.
 */

import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Names that mean "the loopback", whichever family the resolver picks. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

/** `[::1]` is accepted in the config (`setup-token.ts`), `listen()` refuses it. */
function normalise(host: string): string {
  const trimmed = host.trim().toLowerCase();
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
}

/**
 * The addresses to bind for a configured host. The first one is the primary:
 * a failure there is fatal. The others are best-effort — a machine with IPv6
 * disabled must still start.
 *
 * Unlike the app's copy, an exposed host keeps the loopbacks too: the daemon
 * has local clients (CLI, agents, MCP) that all reach it through
 * `apiBaseUrl()`, i.e. `localhost`. Adding the loopback never widens exposure;
 * `::` already covers both families.
 */
export function listenHostsFor(host: string): string[] {
  const address = normalise(host);
  if (LOOPBACK.has(address)) return address === '::1' ? ['::1', '127.0.0.1'] : ['127.0.0.1', '::1'];
  if (address === '::') return [address];
  if (address === '0.0.0.0') return [address, '::1'];
  return [address, '127.0.0.1', '::1'];
}

function bind(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * `listenHostsFor(host)` then `daemon.listen.extraHosts` (the Docker bridge
 * gateway), deduplicated. The extras are secondaries: best-effort, since
 * `docker0` may not be up yet when the daemon starts.
 */
export function listenAddresses(host: string, extraHosts: readonly string[] = []): string[] {
  return [...new Set([...listenHostsFor(host), ...extraHosts.map(normalise)])];
}

/**
 * One HTTP server per address of `listenAddresses(host, extraHosts)`, all
 * serving `handler`. Rejects when the primary cannot bind. The secondaries
 * reuse the primary's effective port, so `port: 0` (tests) still lands them
 * all on the same one.
 */
export async function listenAll(
  handler: RequestListener,
  host: string,
  port: number,
  warn: (message: string) => void = console.warn,
  extraHosts: readonly string[] = [],
): Promise<Server[]> {
  const [primary, ...others] = listenAddresses(host, extraHosts);
  const first = createServer(handler);
  await bind(first, primary!, port);
  const actual = (first.address() as AddressInfo).port;
  const servers = [first];
  for (const address of others) {
    const server = createServer(handler);
    try {
      await bind(server, address, actual);
      servers.push(server);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
      warn(`[timon] not listening on ${address.includes(':') ? `[${address}]` : address}:${actual}: ${code}`);
    }
  }
  return servers;
}

/** Closes every server, idle keep-alive connections first so `close` can finish. */
export function closeAll(servers: Server[]): Promise<void> {
  return Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
    server.closeIdleConnections();
    server.close(error => error ? reject(error) : resolve());
  }))).then(() => undefined);
}
