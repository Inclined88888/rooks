/**
 * After an update, Chromium can keep an older UI (HTTP cache / Cache Storage)
 * while the new shell talks to a matching daemon — the Mac report that still
 * showed the pre-tip agent step. Clear those caches once per app version.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function shellCacheVersionFile(userData: string): string {
  return join(userData, 'shell-cache-version');
}

export function readShellCacheVersion(userData: string, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): string | null {
  try {
    const value = read(shellCacheVersionFile(userData)).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeShellCacheVersion(
  userData: string,
  version: string,
  write: (path: string, data: string) => void = (path, data) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  },
): void {
  write(shellCacheVersionFile(userData), `${version.trim()}\n`);
}

/** True when the shell should wipe renderer HTTP caches before opening windows. */
export function shellCacheClearNeeded(userData: string, version: string): boolean {
  return readShellCacheVersion(userData) !== version.trim();
}
