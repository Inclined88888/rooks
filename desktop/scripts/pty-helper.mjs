/**
 * node-pty's macOS prebuild ships `spawn-helper` without its executable bit
 * (npm extracts it 0644): every spawn then fails with "posix_spawnp failed"
 * and the built-in terminal never starts (observed 08/10/2026 on the Mac).
 * `prepare-daemon-deps.mjs` fixes it before signing: the packaged app cannot
 * be modified afterwards.
 */
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Sets 0755 on every `spawn-helper` of `dir` that lacks it; returns those fixed. */
export function makeHelpersExecutable(dir) {
  const fixed = [];
  for (const entry of readdirSync(dir)) {
    if (entry !== 'spawn-helper') continue;
    const path = join(dir, entry);
    if ((statSync(path).mode & 0o111) === 0o111) continue;
    chmodSync(path, 0o755);
    fixed.push(path);
  }
  return fixed;
}

/**
 * The ConPTY that node-pty ships next to its Windows prebuild. The daemon
 * spawns terminals with `useConptyDll` on Windows (TODO #440,
 * `orchestrator/src/terminal-host/pty.ts`): without these two files every
 * terminal fails with "Cannot find conpty.dll". Returns the missing ones.
 */
export const CONPTY_FILES = [join('conpty', 'conpty.dll'), join('conpty', 'OpenConsole.exe')];

export function missingConptyFiles(dir) {
  return CONPTY_FILES.filter((file) => !existsSync(join(dir, file)));
}
