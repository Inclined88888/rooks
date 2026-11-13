import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { probeFailureReason } from './health.js';

/**
 * Asks the daemon to start its web app again (TODO #485). The daemon was
 * already up but the interface does not answer: its supervisor may have given
 * up on a Next that crashed in a loop, and waiting the 120 s of the startup
 * view would only end in "the interface did not come up". Rearming it costs
 * no restart, so missions keep running.
 *
 * The route takes the daemon token alone, read from the data directory this
 * shell shares with its daemon. Returns a line for the desktop log; never
 * throws, since the window opens whatever this answers.
 */
export async function requestAppRearm(origin: string, home: string, fetcher: typeof fetch = fetch): Promise<string> {
  const url = new URL(origin);
  // Never send the operator's token anywhere but this machine's daemon.
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.protocol !== 'http:' || url.username || url.password) {
    return 'skipped: not a local daemon';
  }
  let token: string;
  try { token = readFileSync(join(home, 'daemon-token'), 'utf8').trim(); }
  catch (error) { return `skipped: daemon token unreadable (${(error as NodeJS.ErrnoException).code ?? 'error'})`; }
  if (!token) return 'skipped: empty daemon token';
  try {
    const res = await fetcher(new URL('/api/app/rearm', url), {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    let detail = '';
    try {
      const body = await res.json() as { result?: unknown; message?: unknown } | null;
      detail = [body?.result, body?.message].filter((part) => typeof part === 'string').join(': ');
    } catch { /* an older daemon without the route answers 404 in plain text */ }
    return `${res.status}${detail ? ` ${detail}` : ''}`;
  } catch (error) {
    return `failed: ${probeFailureReason(error)}`;
  }
}
