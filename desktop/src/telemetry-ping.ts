import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Tells the local daemon the desktop app was opened, once per launch, so its
 * anonymous usage statistics can count it (`desktop_app_opened`). The daemon
 * decides whether anything is sent — it holds the person's preference and the
 * destination; the shell only says "opened", with its version.
 *
 * Same channel as the web app rearm: the daemon token read from the data
 * directory, never sent anywhere but this machine's loopback daemon. Never
 * throws and never delays the window: a daemon without the route answers 404.
 */
let sent = false;

export async function reportDesktopOpened(
  origin: string,
  home: string,
  version: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  if (sent) return 'skipped: already reported';
  const url = new URL(origin);
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.protocol !== 'http:' || url.username || url.password) {
    return 'skipped: not a local daemon';
  }
  let token: string;
  try { token = readFileSync(join(home, 'daemon-token'), 'utf8').trim(); }
  catch (error) { return `skipped: daemon token unreadable (${(error as NodeJS.ErrnoException).code ?? 'error'})`; }
  if (!token) return 'skipped: empty daemon token';
  sent = true;
  try {
    const res = await fetcher(new URL('/api/telemetry/desktop-opened', url), {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version }),
      signal: AbortSignal.timeout(3000),
    });
    return String(res.status);
  } catch (error) {
    return `failed: ${(error as Error).name}`;
  }
}

/** Tests only: forget that this launch already reported. */
export function resetDesktopOpenedForTests(): void {
  sent = false;
}
