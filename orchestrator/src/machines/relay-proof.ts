/**
 * Proof that a call comes from the app's relay, not from a browser.
 *
 * `GET /api/machines/:id/credential` hands out a device token in clear. The
 * person is identified by their session cookie like anywhere else — but a
 * browser holding that cookie must never be able to read the token: the
 * relay uses it server side, and that is the whole point of relaying.
 *
 * The app's server holds this daemon's token (`ROOKS_DAEMON_TOKEN`, or
 * `<ROOKS_HOME>/daemon-token`); a browser never does. The relay proves itself
 * with an HMAC keyed by that token, over a timestamp and the machine id, sent
 * in its own header. The daemon-token itself never travels, and is never an
 * identity here: the account is the session's, the proof only says "the app".
 *
 * ── Contract (the app's relay, P2d, computes the same thing) ────────────────
 *
 *   X-Rooks-Relay-Proof: <unix seconds>.<hex HMAC-SHA256>
 *   HMAC key   = the daemon-token, UTF-8
 *   HMAC input = "rooks-machine-credential\n<unix seconds>\n<machine id>"
 *
 *   Accepted within ±RELAY_PROOF_WINDOW_S of the daemon's clock, for that
 *   machine id only. A request that carries a browser's fetch metadata
 *   (`Sec-Fetch-Site`, `Sec-Fetch-Dest`, `Origin`) is refused even with a
 *   valid proof.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export const RELAY_PROOF_HEADER = 'x-rooks-relay-proof';
export const RELAY_PROOF_WINDOW_S = 60;
const LABEL = 'rooks-machine-credential';

export function relayProof(daemonToken: string, machineId: string, nowMs: number = Date.now()): string {
  const ts = Math.floor(nowMs / 1000);
  const mac = createHmac('sha256', daemonToken).update(`${LABEL}\n${ts}\n${machineId}`).digest('hex');
  return `${ts}.${mac}`;
}

/**
 * Headers only a browser's own request carries: their presence means "not the
 * relay". `Sec-Fetch-Mode` is not one of them — Node's `fetch`, which the
 * relay is, sends `sec-fetch-mode: cors` on its own.
 */
export function carriesBrowserMetadata(headers: IncomingHttpHeaders): boolean {
  return headers['sec-fetch-site'] !== undefined
    || headers['sec-fetch-dest'] !== undefined
    || headers.origin !== undefined;
}

export function verifyRelayProof(
  value: string | string[] | undefined,
  daemonToken: string,
  machineId: string,
  nowMs: number = Date.now(),
): boolean {
  if (typeof value !== 'string' || !daemonToken) return false;
  const match = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(value.trim());
  if (!match) return false;
  const ts = Number(match[1]);
  if (Math.abs(Math.floor(nowMs / 1000) - ts) > RELAY_PROOF_WINDOW_S) return false;
  const expected = createHmac('sha256', daemonToken).update(`${LABEL}\n${ts}\n${machineId}`).digest();
  const given = Buffer.from(match[2]!, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
