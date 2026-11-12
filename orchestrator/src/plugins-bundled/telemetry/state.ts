/**
 * The installation's analytics identity and memory, in `<home>/telemetry.json`.
 *
 * `installId` is a random UUID drawn once. It is deliberately NOT derived from
 * anything about the machine or the person (`machineId()`, the licence
 * fingerprint, an email, an account): deleting the file is enough to become
 * someone else, and nothing on our side can link the two.
 *
 * `lastVersion` is what this installation ran at its previous start, so an
 * update can be counted once (`app_updated`).
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ROOKS_HOME } from '../../paths.js';

export const TELEMETRY_STATE_FILE = 'telemetry.json';

const StateSchema = z.object({
  installId: z.uuid(),
  lastVersion: z.string().max(64).nullable().default(null),
  /** UTC day (`YYYY-MM-DD`) of the last `installation_snapshot`. */
  snapshotDay: z.string().max(10).nullable().default(null),
  /** Account slot → UTC day of its last `app_opened`: at most one a day each. */
  openedDays: z.record(z.string().max(8), z.string().max(10)).default({}),
  /** UTC day of the first event: the cohort an installation belongs to. */
  firstSeenDay: z.string().max(10).nullable().default(null),
  /** Set at start, cleared with the exit code on `process.exit`: still set at the next start = no exit recorded. */
  running: z.boolean().default(false),
  lastExitCode: z.number().int().nullable().default(null),
  milestones: z.array(z.string().max(32)).max(32).default([]),
});
export type TelemetryState = z.infer<typeof StateSchema>;

export function telemetryStatePath(home: string = ROOKS_HOME): string {
  return join(home, TELEMETRY_STATE_FILE);
}

function write(path: string, state: TelemetryState): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* Windows has no POSIX modes */ }
}

/**
 * The stored state, created on first use. An unreadable or malformed file is
 * replaced by a fresh identity: it is anonymous, losing it costs a duplicate
 * count, never a leak.
 */
export function loadTelemetryState(home: string = ROOKS_HOME): TelemetryState {
  const path = telemetryStatePath(home);
  try {
    const parsed = StateSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (parsed.success) return parsed.data;
  } catch { /* absent or not JSON: drawn below */ }
  const fresh: TelemetryState = {
    installId: randomUUID(), lastVersion: null, snapshotDay: null, openedDays: {},
    firstSeenDay: null, running: false, lastExitCode: null, milestones: [],
  };
  try { write(path, fresh); } catch { /* read-only home: the id lives for this process */ }
  return fresh;
}

export function saveTelemetryState(state: TelemetryState, home: string = ROOKS_HOME): void {
  try { write(telemetryStatePath(home), state); } catch { /* best effort */ }
}
