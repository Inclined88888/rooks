import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * What the package builder stamped on this build (`orchestrator/build-info.json`,
 * gitignored, written when the package is assembled). It is how a beta build
 * learns it is a beta and when it stops running, without any server round-trip.
 *
 * Absent, unreadable or malformed means `dev` with no expiry: the repository,
 * the sandbox and the tests behave exactly as before. That default is
 * deliberate — a stamp that cannot be read must never brick a daemon — and it
 * is why the stamp has to be part of the release's verified file inventory.
 */
export type BuildChannel = 'beta' | 'stable' | 'dev';

export type BuildInfo = {
  channel: BuildChannel;
  /** ISO 8601 end of the build, `null` for a build that never expires. */
  expiresAt: string | null;
  /** Same, in epoch milliseconds (`null` when `expiresAt` is). */
  expiresAtMs: number | null;
  builtAt: string | null;
  builtAtMs: number | null;
};

const Schema = z.object({
  channel: z.enum(['beta', 'stable', 'dev']),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  builtAt: z.string().datetime({ offset: true }),
});

export const DEV_BUILD: BuildInfo = { channel: 'dev', expiresAt: null, expiresAtMs: null, builtAt: null, builtAtMs: null };

/** Never throws: every failure is the `dev` build. */
export function readBuildInfo(file: URL | string = new URL('../build-info.json', import.meta.url)): BuildInfo {
  try {
    const parsed = Schema.parse(JSON.parse(readFileSync(file, 'utf8')) as unknown);
    return {
      channel: parsed.channel,
      expiresAt: parsed.expiresAt,
      expiresAtMs: parsed.expiresAt === null ? null : Date.parse(parsed.expiresAt),
      builtAt: parsed.builtAt,
      builtAtMs: Date.parse(parsed.builtAt),
    };
  } catch {
    return DEV_BUILD;
  }
}

let cached: BuildInfo | undefined;
let override: BuildInfo | undefined;

/** The stamp of the running build, read once. */
export function buildInfo(): BuildInfo {
  return override ?? (cached ??= readBuildInfo());
}

/** Tests only: pretend to be another build. `undefined` restores the real stamp. */
export function overrideBuildInfo(info: Partial<Pick<BuildInfo, 'channel' | 'expiresAt' | 'builtAt'>> | undefined): void {
  if (info === undefined) { override = undefined; return; }
  override = {
    channel: info.channel ?? 'dev',
    expiresAt: info.expiresAt ?? null,
    expiresAtMs: info.expiresAt ? Date.parse(info.expiresAt) : null,
    builtAt: info.builtAt ?? null,
    builtAtMs: info.builtAt ? Date.parse(info.builtAt) : null,
  };
}
