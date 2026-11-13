import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HealthResult } from './health.js';

/** A packaged shell's build time, from the staged daemon's build-info. Dev has none. */
export function readShellBuiltAt(resourcesPath: string): string | null {
  const file = join(resourcesPath, 'orchestrator', 'build-info.json');
  if (!existsSync(file)) return null;
  try {
    const body = JSON.parse(readFileSync(file, 'utf8')) as { builtAt?: unknown };
    return typeof body.builtAt === 'string' && body.builtAt.length > 0 ? body.builtAt : null;
  } catch {
    return null;
  }
}

export type OwnBuild = { packaged: boolean; version: string; builtAt: string | null };

/**
 * A leftover daemon of this product is stale when this shell is a package and
 * the daemon is not this exact build. A missing version or build time is an
 * older package: two packs can share 0.1.7. A source checkout never forces a
 * replace.
 */
export function daemonIsStale(health: HealthResult, own: OwnBuild): boolean {
  if (!own.packaged || !health.ok || health.identity !== 'timon') return false;
  if (!health.version || health.version !== own.version) return true;
  if (!own.builtAt) return false;
  return health.builtAt !== own.builtAt;
}
