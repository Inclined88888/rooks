/**
 * Persistent device identifier — the `did` the license server binds a token to.
 *
 * The binding is decided by the server, not derived locally: a fingerprint
 * (MAC + hostname) changes when a network card does, and would revoke a paying
 * customer for plugging in a dock. So the daemon draws an opaque id once, keeps
 * it, and shows the same one forever.
 *
 * ONE function, on purpose. `activate` / `renew` / `deactivate` MUST send the
 * value returned here — the very value `verifyLicenseToken` compares the `did`
 * against. A second source of device id would issue tokens this daemon rejects.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEVICE_ID_FILE } from '../paths.js';

/** Shape the server issues (fixture: `dev_2f8c41ba9e6d4c07`). */
const DEVICE_ID_PATTERN = /^dev_[0-9a-f]{16}$/;

function draw(): string {
  return `dev_${randomBytes(8).toString('hex')}`;
}

/**
 * Reads the device id, drawing and persisting one on first call.
 *
 * Throws when the home is unwritable: an id we cannot persist would differ at
 * the next boot, and every token activated with it would then be rejected.
 * Callers turn that into `invalid:machine`, never into a silent pass.
 */
export function deviceId(file = DEVICE_ID_FILE): string {
  try {
    const stored = readFileSync(file, 'utf8').trim();
    if (DEVICE_ID_PATTERN.test(stored)) return stored;
  } catch { /* absent or unreadable: fall through and draw one */ }
  const drawn = draw();
  mkdirSync(dirname(file), { recursive: true });
  try {
    // `wx`: two processes booting at once must not each keep their own id.
    writeFileSync(file, `${drawn}\n`, { mode: 0o600, flag: 'wx' });
    return drawn;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const winner = readFileSync(file, 'utf8').trim();
  if (!DEVICE_ID_PATTERN.test(winner)) {
    // Present but corrupt (truncated write, manual edit): rewrite rather than
    // hand out an id the server never saw.
    writeFileSync(file, `${drawn}\n`, { mode: 0o600 });
    return drawn;
  }
  return winner;
}

/**
 * Draws a new device id, discarding the stored one.
 *
 * The single legitimate caller is the recovery from `409 device_mismatch`
 * (contract §5.8): the server just told us this device id belongs to another
 * machine, which means `~/.timon` was copied onto this one. Keeping the id
 * would loop on the same refusal forever, so we take a fresh one and activate
 * again — ONCE. That costs a seat, or gets `seat_limit`, and both are honest
 * answers; retrying in a loop is not.
 *
 * Any token issued for the old id stops verifying (`invalid:machine`), which
 * is the point: the copy must not keep running on the original's activation.
 */
export function rotateDeviceId(file = DEVICE_ID_FILE): string {
  rmSync(file, { force: true });
  return deviceId(file);
}
