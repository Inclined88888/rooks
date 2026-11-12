/**
 * The source adapters the import ships with, and how the engine runs one on
 * the tree a reader produced: what the adapter returns is merged with what the
 * reader left out, then validated as any `rooks-agent-import` v1 manifest.
 */
import { ManifestError, parseManifest, type AgentImportManifest } from '../manifest.js';
import { listNames, type AdapterTree, type SourceAdapter } from './adapter.js';
import { openbotSource } from './openbot.js';

export * from './adapter.js';
export {
  OPENBOT_FORMAT, OPENBOT_MANIFEST_FILE, OPENBOT_SOURCE_ID, OPENBOT_VERSION, OPENBOT_WANTS,
  decodeSchedule, openbotSource, openbotToManifest,
} from './openbot.js';

export const BUILTIN_SOURCES: readonly SourceAdapter[] = [openbotSource];

/** What the manifest schema holds: 200 warnings of 500 characters. */
const WARNINGS_MAX = 200;
const WARNING_CHARS = 500;

const SKIP_WORDS: Readonly<Record<string, string>> = {
  'blocked': 'secrets, keys or tool folders, never read',
  'nested-archive': 'archives inside the archive, never opened',
  'link': 'links, never followed',
  'special': 'special files',
  'unportable-name': 'names a Windows disk cannot hold',
  'too-large': 'files too large to be read',
  'skill-too-large': 'skills too large to be read',
  'case-collision': 'names that differ only by case',
};

/** One line per reason of what the reader left out, names only. */
export function skippedWarnings(skipped: AdapterTree['skipped']): string[] {
  const byReason = new Map<string, string[]>();
  for (const entry of skipped) byReason.set(entry.reason, [...(byReason.get(entry.reason) ?? []), entry.path]);
  return [...byReason].map(([reason, paths]) => `Left out of the archive, ${SKIP_WORDS[reason] ?? reason}: ${listNames(paths)}.`);
}

function capWarnings(warnings: readonly string[]): string[] {
  const clipped = warnings.map((w) => (w.length > WARNING_CHARS ? `${w.slice(0, WARNING_CHARS - 1)}…` : w));
  if (clipped.length <= WARNINGS_MAX) return clipped;
  return [...clipped.slice(0, WARNINGS_MAX - 1), `${clipped.length - WARNINGS_MAX + 1} more warnings are not shown.`];
}

/** Runs `adapter` on `tree`; throws a `ManifestError` the user can act on. */
export function manifestFromSource(adapter: SourceAdapter, tree: AdapterTree): AgentImportManifest {
  const { manifest, warnings } = adapter.toManifest(tree);
  try {
    return parseManifest({ ...manifest, warnings: capWarnings([...warnings, ...skippedWarnings(tree.skipped)]) });
  } catch (err) {
    // A manifest the adapter built and the schema refuses is the adapter's fault, not the user's file.
    if (err instanceof ManifestError) throw new ManifestError(`${adapter.label}: ${err.message}`);
    throw err;
  }
}
