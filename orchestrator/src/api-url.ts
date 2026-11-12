/**
 * Where THIS daemon actually answers.
 *
 * Never hardcode the API address in anything an agent reads. A port written by
 * hand is right until the day it isn't: on 03/09/2026 the seeded `_main` prompt
 * named a port this daemon did not listen on, and the agent that followed it
 * sent its writes to a different instance entirely. The installations differ —
 * a packaged desktop answers on `:3010`, a source checkout on `:3001` — and
 * only this module knows which.
 *
 * Everything that names the API to an agent must go through here, and this
 * must be the same source the server listens on (`boot.ts`), so the two can
 * never drift apart.
 */

import { config } from './config/load.js';
import { resolve } from './settings.js';

/**
 * Port the HTTP API listens on.
 *
 * `PORT` wins: it is what the systemd/launchd unit sets, and it is what the
 * server has always honoured. Without it, the portable config file decides —
 * its own default is 3000, so an install with neither is unchanged.
 */
export function apiPort(): number {
  const fromEnv = Number(process.env.PORT);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return config().daemon.listen.port;
}

let bound: string | null = null;

/**
 * Address the HTTP server actually bound, once `listen` succeeded. Read off
 * the socket rather than the config: what the machine exposes is the fact the
 * Settings pane must show, whatever `daemon.listen.host` asks for.
 */
export function boundAddress(): string | null {
  return bound;
}

export function recordBoundAddress(address: string | null): void {
  bound = address;
}

/**
 * Base URL an agent should use to reach the orchestrator.
 *
 * `ROOKS_ORCH_URL` wins when it was explicitly set (reverse proxy, remote
 * daemon): its DEFAULT value cannot be trusted here, being a hardcoded
 * `http://localhost:3000` that knows nothing of the port in force.
 */
export function apiBaseUrl(): string {
  const orchUrl = resolve('ROOKS_ORCH_URL');
  if (orchUrl && orchUrl.source !== 'default') return String(orchUrl.value);
  return `http://localhost:${apiPort()}`;
}
