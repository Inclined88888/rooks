import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A standalone build (desktop package) ships neither `next.config.mjs` nor the
 * webpack Next would load it with: the config serialized at build time must be
 * handed over, exactly as the `server.js` Next generates for standalone does.
 * Any other build keeps loading `next.config.mjs`. Returns whether it did.
 */
export function useStandaloneConfig(dir: string, env: Record<string, string | undefined> = process.env): boolean {
  const manifest = join(dir, env.NEXT_DIST_DIR || '.next', 'required-server-files.json');
  if (!existsSync(manifest)) return false;
  const { config } = JSON.parse(readFileSync(manifest, 'utf8')) as { config?: { output?: string } };
  if (config?.output !== 'standalone') return false;
  env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config);
  return true;
}
