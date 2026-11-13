import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Two packages can share a version. The cache key includes the build time. */
export function shellCacheKey(version: string, builtAt: string | null): string {
  return builtAt ? `${version}@${builtAt}` : version;
}

export function cacheNeedsClear(stored: string | null, key: string): boolean {
  return stored !== key;
}

/** Clears the Chromium HTTP cache when the stored key is not this build, then records the key. */
export async function clearShellCacheIfBuildChanged(
  userData: string,
  key: string,
  clearCache: () => Promise<void>,
): Promise<boolean> {
  const file = join(userData, 'shell-cache-version');
  let stored: string | null = null;
  try { stored = readFileSync(file, 'utf8').trim(); } catch { stored = null; }
  if (!cacheNeedsClear(stored, key)) return false;
  await clearCache();
  mkdirSync(userData, { recursive: true });
  writeFileSync(file, key, 'utf8');
  return true;
}
