/**
 * Onboarding step 2 — resuming an installation that already has a life.
 *
 * `firstRun` means one thing only: `rooks.config.json` does not exist. It says
 * nothing about the rest of the home, and the two drift apart more often than
 * it looks — a config removed by hand, a home carried over from another
 * machine, an install that reached the cockpit before the wizard existed.
 * Those users met a wizard that offered to configure a machine they had
 * already been working on, with no way to say "this is mine, let me back in".
 *
 * So the screen asks the daemon whether there is anything to come back to, and
 * `resumeExistingInstance` is the way back: it writes the configuration that
 * was missing — the single reason the gate held them — and marks the remaining
 * steps answered. It creates no agent, renames nothing and never overwrites a
 * config (`applySetup` refuses that on its own).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { backupsDir } from './data-version.js';
import { expandTilde } from './config/load.js';
import { db, dbApi } from './db.js';
import { mainAgentName } from './main-agent.js';
import { MAIN_AGENT_STEP_KEY } from './onboarding-main-agent.js';
import { readTeamState, writeTeamState } from './onboarding-team-state.js';
import { AGENTS_DIR, ROOKS_HOME } from './paths.js';
import { applySetup, isFirstRun, type SetupInput } from './setup.js';

export class ResumeError extends Error {}

/** Seeded by the product, so present on a home nobody has worked in yet.
 *  Declared here rather than imported: `librarian.ts` pulls in the agent
 *  runtime, and this module is read by a first-run screen. */
const SEEDED_AGENTS = ['_main', 'ROOKS.librarian'];

export type ExistingInstance = {
  /** Is there anything here that setup did not put there itself? */
  present: boolean;
  agents: number;
  projects: number;
  missions: number;
  /** The projects folder this home used before, to prefill the wizard; null
   *  when nothing on disk says it (#120). */
  workspacesRoot: string | null;
};

function count(table: string): number {
  try {
    return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  } catch {
    return 0; // A table a migration has not created yet is simply empty.
  }
}

export function existingInstance(): ExistingInstance {
  const seeded = new Set([...SEEDED_AGENTS, mainAgentName() ?? '_main']);
  const agents = existsSync(AGENTS_DIR)
    ? readdirSync(AGENTS_DIR).filter((name) => !seeded.has(name)).length
    : 0;
  const projects = count('projects');
  const missions = count('missions');
  return {
    present: agents > 0 || projects > 0 || missions > 0, agents, projects, missions,
    workspacesRoot: previousWorkspacesRoot(),
  };
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** The configuration an update copied aside before it ran, newest first. */
function backedUpWorkspacesRoot(home: string): string | null {
  let dirs: string[];
  try { dirs = readdirSync(backupsDir(home)).filter((name) => name.startsWith('pre-')); } catch { return null; }
  const configs = dirs
    .map((name) => join(backupsDir(home), name, 'rooks.config.json'))
    .filter((file) => existsSync(file))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const file of configs) {
    try {
      const root = (JSON.parse(readFileSync(file, 'utf8')) as { workspacesRoot?: unknown }).workspacesRoot;
      if (typeof root === 'string' && root.trim() && isDirectory(expandTilde(root.trim()))) return root.trim();
    } catch { /* a damaged copy says nothing */ }
  }
  return null;
}

/** Deepest folder holding every path, or null when only a filesystem root does. */
export function commonParent(paths: string[]): string | null {
  if (paths.length === 0) return null;
  let parent = dirname(paths[0]!);
  const inside = (path: string) => {
    const rel = relative(parent, path);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  while (!paths.every(inside)) {
    const up = dirname(parent);
    if (up === parent) return null;
    parent = up;
  }
  return dirname(parent) === parent ? null : parent;
}

/**
 * Where this home kept its projects: the configuration saved by the last
 * update first, then the folder that holds the registered projects.
 */
export function previousWorkspacesRoot(home: string = ROOKS_HOME): string | null {
  const saved = backedUpWorkspacesRoot(home);
  if (saved) return saved;
  let cwds: string[] = [];
  try {
    cwds = (db.prepare(`SELECT cwd FROM projects WHERE cwd IS NOT NULL AND cwd != ''`).all() as { cwd: string }[])
      .map((row) => row.cwd)
      .filter((cwd) => isAbsolute(cwd));
  } catch { /* no projects table yet */ }
  const parent = commonParent(cwds);
  return parent && isDirectory(parent) ? parent : null;
}

/**
 * Ends onboarding for someone who already has an instance.
 *
 * `input` carries what the screen holds at that moment (pinned binaries, the
 * supervisor the machine reported, the projects root) so resuming does not
 * silently discard the answers already given. Everything else keeps its
 * default — this is not the moment to reconfigure a machine that works.
 */
export function resumeExistingInstance(input: SetupInput = {}): { path: string; config: Record<string, unknown> } {
  if (!isFirstRun()) throw new ResumeError('setup_complete');
  if (!existingInstance().present) throw new ResumeError('nothing_to_resume');
  const written = applySetup(input);
  // Steps 3 and 4 exist to populate an empty instance. This one is not empty,
  // and the gate would otherwise send the user straight back into them.
  dbApi.setSetting(MAIN_AGENT_STEP_KEY, 'complete');
  const team = readTeamState();
  if (team && team.status !== 'complete') writeTeamState({ ...team, status: 'complete' });
  return written;
}
