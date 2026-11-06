#!/usr/bin/env node
/**
 * Make the `timon` CLI reachable from the user's $PATH in host mode.
 *
 * Agents spawned by a host-running orchestrator inherit the user's
 * environment, so they need to find the same `timon` shim. We symlink
 * it into a directory that should already be on PATH for the
 * user — `~/.local/bin` by default — falling back to printing an
 * instruction when that's not the case.
 *
 * Idempotent: re-runs replace an existing timon symlink that points
 * elsewhere, but refuse to overwrite a real file.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoBin = resolvePath(__dirname, '..', 'bin', 'timon');
if (!existsSync(repoBin)) {
  console.error(`timon shim not found at ${repoBin}`);
  process.exit(1);
}

const binDir = join(homedir(), '.local', 'bin');
const target = join(binDir, 'timon');
mkdirSync(binDir, { recursive: true });

if (existsSync(target)) {
  const st = lstatSync(target);
  if (st.isSymbolicLink()) {
    const cur = readlinkSync(target);
    if (cur === repoBin) {
      console.log(`timon already linked at ${target} → ${cur}`);
    } else {
      console.log(`replacing stale symlink ${target} (was → ${cur})`);
      unlinkSync(target);
      symlinkSync(repoBin, target);
      console.log(`linked ${target} → ${repoBin}`);
    }
  } else {
    console.error(
      `refusing to overwrite ${target} (not a symlink). ` +
      `Remove it manually or pick a different target dir.`,
    );
    process.exit(1);
  }
} else {
  symlinkSync(repoBin, target);
  console.log(`linked ${target} → ${repoBin}`);
}

const path = process.env.PATH || '';
if (!path.split(':').includes(binDir)) {
  console.warn(
    `\n⚠  ${binDir} is NOT in your $PATH right now.\n` +
    `   Add it (eg. in ~/.bashrc / ~/.zshrc):\n` +
    `     export PATH="$HOME/.local/bin:$PATH"\n`,
  );
}
