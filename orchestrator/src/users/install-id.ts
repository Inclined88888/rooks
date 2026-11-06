/**
 * The installation identifier the site relay pairs a verified email with
 * (`docs/EMAIL-CODES.md`). The relay only mails a reset code to an address
 * confirmed for THIS installation, so the id must outlive every restart.
 *
 * Neither existing id fits, on purpose:
 * - the licence `device-id` (`license/device.ts`) is rotated when the licence
 *   server reports a binding conflict — the verified pair would be lost with it;
 * - the telemetry `installId` (`plugins-bundled/telemetry/state.ts`) is
 *   promised to be unlinkable to a person: sending it next to an email would
 *   break that promise.
 * So it is a third one, drawn once, kept in its own file next to `device-id`
 * rather than in `timon.config.json`, which is the operator's file to edit.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { INSTALL_ID_FILE } from '../paths.js';

const INSTALL_ID_PATTERN = /^ins_[0-9a-f]{32}$/;

function draw(): string {
  return `ins_${randomBytes(16).toString('hex')}`;
}

/**
 * Reads the id, drawing and persisting one on first call. Throws when the home
 * is unwritable: an id that changes at the next boot would orphan the pair the
 * relay recorded, and the owner would silently lose password recovery.
 */
export function installId(file = INSTALL_ID_FILE): string {
  try {
    const stored = readFileSync(file, 'utf8').trim();
    if (INSTALL_ID_PATTERN.test(stored)) return stored;
  } catch { /* absent or unreadable: draw one */ }
  const drawn = draw();
  mkdirSync(dirname(file), { recursive: true });
  try {
    // `wx`: two first calls racing must agree on a single id.
    writeFileSync(file, `${drawn}\n`, { mode: 0o600, flag: 'wx' });
    return drawn;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const winner = readFileSync(file, 'utf8').trim();
  if (INSTALL_ID_PATTERN.test(winner)) return winner;
  // Present but corrupt (truncated write, manual edit): a fresh id is better
  // than one the relay can never have seen.
  writeFileSync(file, `${drawn}\n`, { mode: 0o600 });
  return drawn;
}
