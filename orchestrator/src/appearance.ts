/**
 * The install's light/dark scheme, readable WITHOUT the daemon.
 *
 * The desktop shell paints windows before the daemon answers — the main
 * window's background, the update window, which runs before any daemon of the
 * new version starts. They could only guess dark, so an install set to light
 * flashed dark on every launch and update (#132). This file is their source:
 * absent means "no install yet", and the shell then follows the OS.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dbApi, isColorScheme, type ColorScheme } from './db.js';
import { TIMON_HOME } from './paths.js';

export const appearanceFile = (home: string = TIMON_HOME): string => join(home, 'appearance.json');

export function writeAppearance(scheme: ColorScheme, home: string = TIMON_HOME): void {
  try {
    writeFileSync(appearanceFile(home), `${JSON.stringify({ scheme })}\n`, { mode: 0o600 });
  } catch (err) {
    console.warn(`[appearance] could not record the scheme: ${(err as Error).message}`);
  }
}

export function readAppearance(home: string = TIMON_HOME): ColorScheme | null {
  try {
    const scheme = (JSON.parse(readFileSync(appearanceFile(home), 'utf8')) as { scheme?: unknown }).scheme;
    return isColorScheme(scheme) ? scheme : null;
  } catch {
    return null;
  }
}

/**
 * An install made before this file existed records what its first account
 * sees today, so the shell stops guessing from the next update on.
 */
export function recordExistingAppearance(home: string = TIMON_HOME): void {
  if (readAppearance(home)) return;
  const owner = dbApi.listUsers().find((user) => user.is_superadmin);
  if (!owner) return;
  writeAppearance(dbApi.userPrefsGet(owner.id).scheme, home);
}
