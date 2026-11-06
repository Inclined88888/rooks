import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Mirrors readDataVersion of orchestrator/src/data-version.ts: an unreadable file counts as absent there.
export function readDataVersion(home) {
  try { return readFileSync(join(home, 'data-version'), 'utf8').trim() || null; }
  catch { return null; }
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** The version `update-approval.json` approves, or null. */
export function approvedUpdateVersion(home) {
  const approval = readJson(join(home, 'update-approval.json'));
  return approval && typeof approval.version === 'string' ? approval.version : null;
}

/** A copy this version could not save, and without which it refuses to migrate (`readSnapshotFailure`). */
function blockingSnapshotFailure(home, version) {
  const failure = readJson(join(home, 'backups', 'snapshot-failure.json'));
  return !!failure && failure.version === version && typeof failure.message === 'string'
    && typeof failure.at === 'number' && failure.blocking !== false;
}

/**
 * Same verdict as `updateNeedsApproval` (orchestrator/src/data-version.ts),
 * the daemon's gate: an offer whenever that daemon will wait for approval,
 * none once it will not. A version the comparator cannot read needs approval
 * there, and an approval already given for this version opens the data
 * (TODO #535). `data-update.test.ts` holds the two to the same table.
 * One exception keeps the window: an approved version whose copy failed in a
 * way that blocks its migration waits again at boot (`createDataUpdate`, phase
 * `failed`), and this window is where that copy is retried.
 * The desktop restore reader supplies its comparator, keeping both directions consistent.
 */
export function localUpdateOffer(home, version, compareVersions) {
  if (!existsSync(join(home, 'timon.db'))) return null;
  const from = readDataVersion(home);
  if (from !== null && (compareVersions(version, from) ?? 1) <= 0) return null;
  if (approvedUpdateVersion(home) === version && !blockingSnapshotFailure(home, version)) return null;
  return { from: from ?? '0.1.0', to: version };
}
