/**
 * Ceilings of the source readers. What an import carries is agent
 * configuration — prompts, identity files, skills, schedules — i.e. text: a
 * real export weighs a few megabytes. Every ceiling below sits one or two
 * orders of magnitude above that, so a legitimate source never meets one, and
 * a hostile or mistaken one (a home directory, a zip bomb) is refused before
 * it costs memory or disk.
 */

const MiB = 1024 * 1024;

/**
 * Bytes a whole source may hold: for a zip, the declared expanded size of ALL
 * its entries, checked on the central directory before anything is inflated;
 * for a folder, the files kept after the deny list and `wants`. 500 MiB is
 * what the tree may cost in the daemon's memory at worst, and still 100× a
 * large Hermes or Grok Bot export.
 */
export const SOURCE_MAX_BYTES = 500 * MiB;

/**
 * Files a source may hold: every entry of a zip's central directory (folders
 * included), or the files a folder walk keeps. An agent setup with dozens of
 * skills stays under a few hundred files; 5,000 leaves room for a whole team.
 */
export const SOURCE_MAX_FILES = 5_000;

/**
 * One file of the tree. No instruction file, skill script or schedule is
 * 10 MiB of text; past that it is a dataset, a model or a log, and it is
 * skipped (with a notice) rather than read.
 */
export const FILE_MAX_BYTES = 10 * MiB;

/**
 * One skill — a folder holding a `SKILL.md` and everything below it. A skill
 * is a prompt plus a few references: 10 MiB and 200 files bound it with a
 * wide margin, and keep one oversized skill from crowding out the others (it
 * is dropped whole, with a notice, the rest of the import goes on).
 */
export const SKILL_MAX_BYTES = 10 * MiB;
export const SKILL_MAX_FILES = 200;

/**
 * The upload of a zip, streamed to a temporary file. Deliberately far below
 * SOURCE_MAX_BYTES: the bytes cross the Next proxy, which buffers request
 * bodies, and an export of text compresses to a few megabytes. A route may
 * pass a lower ceiling, never a higher one.
 */
export const ZIP_UPLOAD_MAX_BYTES = 50 * MiB;

/**
 * Expansion ratio of one zip entry, declared size over compressed size,
 * refused before inflating. Text deflates 3–10×, repetitive JSON or
 * whitespace up to ~100×; a bomb is in the thousands. The ratio only applies
 * past ZIP_RATIO_FLOOR_BYTES: a tiny file of spaces can legitimately show
 * a huge ratio and costs nothing.
 */
export const ZIP_MAX_RATIO = 200;
export const ZIP_RATIO_FLOOR_BYTES = 1 * MiB;

/**
 * Folder walk: entries looked at (kept or not) and depth. The walk only
 * descends where a `wants` glob can still match, so these only stop a
 * pathological tree (a root pointed at a home directory, a deep generated
 * hierarchy) instead of bounding a normal one.
 */
export const DIR_MAX_VISITED = 100_000;
export const DIR_MAX_DEPTH = 32;

export type ReaderLimits = {
  maxBytes: number;
  maxFiles: number;
  maxFileBytes: number;
  maxSkillBytes: number;
  maxSkillFiles: number;
  maxRatio: number;
  ratioFloorBytes: number;
  maxVisited: number;
  maxDepth: number;
};

export const DEFAULT_READER_LIMITS: Readonly<ReaderLimits> = Object.freeze({
  maxBytes: SOURCE_MAX_BYTES,
  maxFiles: SOURCE_MAX_FILES,
  maxFileBytes: FILE_MAX_BYTES,
  maxSkillBytes: SKILL_MAX_BYTES,
  maxSkillFiles: SKILL_MAX_FILES,
  maxRatio: ZIP_MAX_RATIO,
  ratioFloorBytes: ZIP_RATIO_FLOOR_BYTES,
  maxVisited: DIR_MAX_VISITED,
  maxDepth: DIR_MAX_DEPTH,
});

/** Tests and routes tighten a ceiling; nothing loosens one past the default. */
export function resolveLimits(overrides?: Partial<ReaderLimits>): ReaderLimits {
  const out: ReaderLimits = { ...DEFAULT_READER_LIMITS };
  if (!overrides) return out;
  for (const key of Object.keys(out) as (keyof ReaderLimits)[]) {
    const value = overrides[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      out[key] = Math.min(value, DEFAULT_READER_LIMITS[key]);
    }
  }
  return out;
}
