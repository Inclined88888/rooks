/**
 * Launched locally by the desktop (Electron as Node) once its embedded daemon
 * has exited: ends the mission CLIs that daemon left running (TODO #565,
 * `mission-processes.ts`). No HTTP endpoint runs it, and it never loads the
 * database (I7). Prints `{ ended, dropped, kept }` as JSON on stdout.
 */
import { loadConfig } from '../config/load.js';
import { ROOKS_HOME } from '../paths.js';
import { createGenericHost } from './generic.js';
import { endRecordedMissionProcesses, missionProcessDir, sweepOpsFor } from './mission-processes.js';

try {
  const host = createGenericHost(loadConfig(undefined, { readonly: true }));
  const result = await endRecordedMissionProcesses(missionProcessDir(ROOKS_HOME), sweepOpsFor(host));
  process.stdout.write(JSON.stringify({ ended: result.ended.length, dropped: result.dropped, kept: result.kept }));
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
