/**
 * The intermediate of `spawnOrphan` (`detached.ts`): starts the process the
 * spec describes, detached, prints its pid, and exits. Once it has exited,
 * the process it started has a dead parent: `taskkill /T` on the daemon's
 * tree no longer reaches it. Launched locally by the daemon only.
 */
import { spawn } from 'node:child_process';
import { closeSync } from 'node:fs';
import { DETACH_SPEC_ENV, openLog } from './detached.js';

type Spec = { cmd: string; args: string[]; cwd: string; logFile: string };

function readSpec(raw: string | undefined): Spec {
  const spec = JSON.parse(raw ?? '') as Partial<Spec>;
  if (typeof spec.cmd !== 'string' || !Array.isArray(spec.args) || typeof spec.cwd !== 'string' || typeof spec.logFile !== 'string') {
    throw new Error('invalid detach spec');
  }
  return { cmd: spec.cmd, args: spec.args.map(String), cwd: spec.cwd, logFile: spec.logFile };
}

const spec = readSpec(process.env[DETACH_SPEC_ENV]);
const env = { ...process.env };
delete env[DETACH_SPEC_ENV];
const fd = openLog(spec.logFile);
const child = spawn(spec.cmd, spec.args, { cwd: spec.cwd, env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
child.once('error', (err) => {
  console.error(err.message);
  process.exit(1);
});
child.once('spawn', () => {
  closeSync(fd);
  child.unref();
  process.stdout.write(`${child.pid ?? ''}\n`, () => process.exit(0));
});
