/**
 * `orchestrator/build-info.json`: what a package says about itself — its
 * channel and when it stops working. The daemon reads it (beta build
 * isolation); this module is the writer's side of that contract.
 *
 *   { channel: 'beta' | 'stable' | 'dev', expiresAt: ISO8601 | null, builtAt: ISO8601 }
 *
 * Rooks does not stop on a date. `noExpiry` is allowed on every channel.
 * A `dev` package is a test build: it never carries an expiry.
 *
 * The file is written in the build worktree by `scripts/build-rc.mjs` and
 * `scripts/build-all.mjs`, never committed (gitignored), staged by
 * `prepare-daemon-release.mjs` and signed with the rest of the daemon: an
 * edited expiry breaks the release manifest.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const BUILD_INFO_FILE = 'build-info.json';
/** What a build script may ask for; `dev` is what an unpackaged daemon reports, never a package. */
export const PACKAGE_CHANNELS = ['beta', 'stable'];
export const CHANNELS = [...PACKAGE_CHANNELS, 'dev'];
export const DEFAULT_CHANNEL = 'beta';
export const DEFAULT_EXPIRY_DAYS = 90;
const DAY_MS = 24 * 60 * 60_000;
// A time without an offset is read in the machine's zone: three build hosts
// would disagree on the same `--expires`.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/** An ISO 8601 date (UTC midnight) or date-time with an explicit offset, as a canonical UTC string. */
export function parseIsoDate(value, what = 'date') {
  if (typeof value !== 'string' || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${what}: "${value}" is not an ISO 8601 date (2026-12-31 or 2026-12-31T00:00:00Z; a time needs Z or an offset)`);
  }
  // `2026-02-31` may roll over to March in V8: refuse what is not a real day.
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) throw new Error(`${what}: "${value}" is not a real calendar day`);
  const date = new Date(value);
  return date.toISOString();
}

/**
 * The content of build-info.json for a build started at `now`.
 * `expires` (ISO) wins over the default; `noExpiry` is for a stable build only.
 */
export function createBuildInfo({ channel = DEFAULT_CHANNEL, expires, noExpiry = false, now = new Date() } = {}) {
  const dev = channel === 'dev';
  if (!dev && !PACKAGE_CHANNELS.includes(channel)) throw new Error(`--channel must be one of ${PACKAGE_CHANNELS.join(', ')} (got "${channel}")`);
  if (dev && !noExpiry) throw new Error('a dev package does not expire: pass noExpiry');
  if (noExpiry && expires !== undefined && expires !== null) throw new Error('--no-expiry and --expires exclude each other');
  const built = new Date(now);
  if (Number.isNaN(built.getTime())) throw new Error('build date is invalid');
  const builtAt = built.toISOString();
  const expiresAt = dev || noExpiry
    ? null
    : expires === undefined || expires === null
      ? new Date(built.getTime() + DEFAULT_EXPIRY_DAYS * DAY_MS).toISOString()
      : parseIsoDate(expires, '--expires');
  return { channel, expiresAt, builtAt };
}

/** Throws unless `value` honours the contract; returns it typed-checked. A beta may leave `expiresAt` null. */
export function validateBuildInfo(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${BUILD_INFO_FILE} must be a JSON object`);
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['builtAt', 'channel', 'expiresAt'])) {
    throw new Error(`${BUILD_INFO_FILE} must hold exactly channel, expiresAt and builtAt (got ${keys.join(', ') || 'nothing'})`);
  }
  if (!CHANNELS.includes(value.channel)) throw new Error(`${BUILD_INFO_FILE}: channel "${value.channel}" is not one of ${CHANNELS.join(', ')}`);
  parseIsoDate(value.builtAt, 'builtAt');
  if (value.expiresAt !== null) parseIsoDate(value.expiresAt, 'expiresAt');
  return value;
}

export function buildInfoPath(orchestratorDir) {
  return join(orchestratorDir, BUILD_INFO_FILE);
}

/** Writes the file into `<worktree>/orchestrator/`; returns its path. */
export function writeBuildInfo(worktree, info) {
  validateBuildInfo(info);
  const file = buildInfoPath(join(worktree, 'orchestrator'));
  writeFileSync(file, JSON.stringify(info, null, 2) + '\n');
  return file;
}

export function readBuildInfo(file) {
  if (!existsSync(file)) {
    throw new Error(`${file} is missing: a package carries its channel and expiry. Build through the release scripts (build-rc.mjs or build-all.mjs), which write it.`);
  }
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
  catch (cause) { throw new Error(`${file} is not valid JSON`, { cause }); }
  return validateBuildInfo(parsed);
}

/**
 * The packed daemon (`resources/orchestrator`) must hold the build-info the
 * release was prepared with. The signed inventory already fails when the file
 * is absent; this says WHY, and catches a stale copy left by an earlier build.
 */
export function assertPackagedBuildInfo(installedDir, expected) {
  const file = buildInfoPath(installedDir);
  if (!existsSync(file)) {
    throw new Error(`No ${BUILD_INFO_FILE} in ${installedDir}: the extraResources entry of electron-builder.yml did not embed it, and the daemon refuses a package that cannot tell when it expires`);
  }
  const packaged = readBuildInfo(file);
  if (JSON.stringify(packaged) !== JSON.stringify(validateBuildInfo(expected))) {
    throw new Error(`The ${BUILD_INFO_FILE} embedded in ${installedDir} is not the one this release was prepared with`);
  }
  return packaged;
}
