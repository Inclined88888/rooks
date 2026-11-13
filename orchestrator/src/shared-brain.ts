/**
 * One local brain — shared layout under `ROOKS_HOME` (`~/.rooks`).
 *
 * The Desk daemon (this package), `rooks-code`, and helper agents agree on these
 * relative paths. Terminal Python mirrors them in `rooks_code/local_brain.py`.
 *
 * Self-evolution / dream-loop agents are intentionally out of scope here.
 */
import { join } from 'node:path';
import { GLOBAL_MEMORY_DIR, ROOKS_HOME, SKILLS_DIR } from './paths.js';

/** Relative layout every surface should honour (absolute = join(ROOKS_HOME, …)). */
export const SHARED_BRAIN = {
  /** Terminal TOML + keys + offline facts. */
  configDir: 'config',
  terminalToml: 'config/rooks.toml',
  terminalKeys: 'config/rooks-keys.json',
  terminalMemory: 'config/terminal-memory.json',
  /** Bridge file written when Desk is open. */
  appLink: 'run/app.json',
  /** Terminal / browser Needs-you drops for Desk. */
  needsYouDir: 'run/needs-you',
  /** Colour scheme readable without the daemon. */
  appearance: 'appearance.json',
  /** Daemon secrets (CLI reads as key fallback; `rooks login` mirrors into it). */
  secretsEnv: 'secrets.env',
  /** Skills registry (same folder Desk `/capabilities?tab=skills` lists). */
  skillsDir: 'skills',
  /** Daemon global memory files. */
  memoryDir: 'memory',
} as const;

export function sharedBrainPaths(home: string = ROOKS_HOME): {
  home: string;
  configDir: string;
  terminalToml: string;
  terminalKeys: string;
  terminalMemory: string;
  appLink: string;
  needsYouDir: string;
  appearance: string;
  secretsEnv: string;
  skillsDir: string;
  memoryDir: string;
} {
  const under = (rel: string) => join(home, rel);
  return {
    home,
    configDir: under(SHARED_BRAIN.configDir),
    terminalToml: under(SHARED_BRAIN.terminalToml),
    terminalKeys: under(SHARED_BRAIN.terminalKeys),
    terminalMemory: under(SHARED_BRAIN.terminalMemory),
    appLink: under(SHARED_BRAIN.appLink),
    needsYouDir: under(SHARED_BRAIN.needsYouDir),
    appearance: under(SHARED_BRAIN.appearance),
    secretsEnv: under(SHARED_BRAIN.secretsEnv),
    // When called with the process ROOKS_HOME, reuse the canonical exports.
    skillsDir: home === ROOKS_HOME ? SKILLS_DIR : under(SHARED_BRAIN.skillsDir),
    memoryDir: home === ROOKS_HOME ? GLOBAL_MEMORY_DIR : under(SHARED_BRAIN.memoryDir),
  };
}
