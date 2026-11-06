/**
 * Machine fingerprint — the `fp` the license server binds an activation to,
 * on top of the device id.
 *
 * `deviceId()` is drawn at random and lives in `~/.timon`. Copying that folder
 * to a second machine carries the same id over, so the server counts one seat
 * and hands both installations a token. The fingerprint is the one value the
 * copy cannot bring along: it comes from the OS, not from our home directory.
 *
 * Deliberately NOT the MAC address nor the hostname. Those change when a dock
 * is plugged in or a laptop is renamed, and revoking a paying customer over a
 * USB-C hub is a worse failure than the sharing it would prevent.
 *
 * What travels is the SHA-256 of the machine id, never the id itself: the raw
 * value identifies the machine across every vendor that ever reads it, and the
 * server has no use for it beyond comparing it to itself.
 *
 * ONE function, like `deviceId()`. `activate` and `renew` MUST send the value
 * returned here — a second source would produce a fingerprint the server sees
 * as another machine, and answer `409 device_mismatch` to the very install
 * that activated.
 *
 * Contract: `timon-site` `docs/PRD-S0.md` §5.8.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Linux: systemd's id, with the older D-Bus location as a fallback. */
const LINUX_MACHINE_ID_FILES = ['/etc/machine-id', '/var/lib/dbus/machine-id'];

function readFirstFile(paths: readonly string[]): string | null {
  for (const path of paths) {
    try {
      const value = readFileSync(path, 'utf8').trim();
      if (value !== '') return value;
    } catch { /* absent or unreadable: try the next one */ }
  }
  return null;
}

function run(command: string, args: readonly string[]): string | null {
  try {
    const out = execFileSync(command, [...args], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() === '' ? null : out;
  } catch { return null; }
}

/**
 * The raw OS machine id. Exported for the tests only — production code goes
 * through `fingerprint()`, which is the only thing allowed to leave the host.
 */
export function machineId(platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'darwin') {
    // Absolute path first: a daemon started by launchd or by the app may run
    // with a PATH that lacks /usr/sbin, and a missing id switched the licence
    // off (TIM-0024).
    const out = runFirst(['/usr/sbin/ioreg', 'ioreg'], ['-rd1', '-c', 'IOPlatformExpertDevice']); // portability: macOS system binary, darwin branch only
    return out?.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] ?? null;
  }
  if (platform === 'win32') {
    const system = join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', 'reg.exe');
    const out = runFirst([system, 'reg'], ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']);
    return out?.match(/MachineGuid\s+REG_SZ\s+(\S+)/i)?.[1] ?? null;
  }
  return readFirstFile(LINUX_MACHINE_ID_FILES);
}

function runFirst(commands: readonly string[], args: readonly string[]): string | null {
  for (const command of commands) {
    const out = run(command, args);
    if (out !== null) return out;
  }
  return null;
}

/**
 * The OS machine id does not change while a process runs, but READING it can
 * fail for a moment (a slow `ioreg` past its timeout). Kept once read, so the
 * local re-check every minute cannot turn a transient failure into a licence
 * switched off (TIM-0024).
 */
let knownMachineId: string | null = null;
function currentMachineId(): string | null {
  if (knownMachineId === null) knownMachineId = machineId();
  return knownMachineId;
}

/** Can this process read its machine id right now? A mismatch and an
 *  unreadable id both fail verification; only the first is a verdict. */
export function fingerprintReadable(): boolean {
  return currentMachineId() !== null;
}

/**
 * SHA-256 (lowercase hex, 64 chars) of the OS machine id.
 *
 * Throws when the OS gives us nothing, the way `deviceId()` throws on an
 * unwritable home: sending a made-up fingerprint would bind the activation to
 * a machine that does not exist, and the next boot would read
 * `409 device_mismatch` on a perfectly legitimate install. Callers surface the
 * failure, never a silent pass.
 */
export function fingerprint(raw: string | null = currentMachineId()): string {
  if (raw === null || raw.trim() === '') {
    throw new Error('no OS machine id available for the license fingerprint');
  }
  return createHash('sha256').update(raw.trim()).digest('hex');
}
