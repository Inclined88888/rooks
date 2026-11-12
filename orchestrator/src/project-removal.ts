/**
 * Removing a project and deciding what becomes of its agents (TIM-0054).
 *
 * `deleteProject` only drops the row and the folder; the project's agents kept
 * pointing at a slug that no longer existed, and the agents grid re-created a
 * card for that slug from them: the project looked undeleted. Deleting is now
 * a choice the caller makes explicitly, since deleting an agent destroys its
 * identity and memory.
 */
import { resolve } from 'node:path';
import { deleteAgent, killRunningForAgent, listAgents, loadConfig, patchAgentConfig } from './agent.js';
import { canonicalAgentName } from './agent-config.js';
import { dbApi } from './db.js';
import { mainAgentName } from './main-agent.js';
import { deleteProject, readMeta } from './projects.js';
import { projectFromCwd } from './task-project.js';

export type AgentsFate = { mode: 'delete' } | { mode: 'detach' } | { mode: 'move'; to: string };

export type RemovedAgent = { name: string; fate: AgentsFate['mode'] };

/** The project still has agents and the caller did not say what to do with them. */
export class ProjectHasAgentsError extends Error {
  constructor(readonly slug: string, readonly agents: string[]) {
    super(`project "${slug}" still has ${agents.length} agent(s): choose to delete, detach or move them`);
  }
}

/** Agents attached to the project, by `config.project` or, failing that, by the folder they work in. */
export function agentsOfProject(slug: string): string[] {
  const key = slug.toLowerCase();
  return listAgents().filter((a) => a.project?.toLowerCase() === key).map((a) => a.name);
}

function sameDir(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && resolve(a) === resolve(b);
}

/** Every refusal is raised before the first change, so a refused removal leaves everything as it was. */
function checkFate(slug: string, names: string[], fate: AgentsFate): void {
  if (fate.mode === 'move') {
    if (fate.to.toLowerCase() === slug.toLowerCase()) throw new Error('cannot move the agents to the project being removed');
    if (!dbApi.getProjectRow(fate.to)) throw new Error(`target project not found: "${fate.to}"`);
  }
  if (fate.mode === 'delete') {
    const seat = mainAgentName();
    const main = seat && names.find((n) => canonicalAgentName(n) === canonicalAgentName(seat));
    if (main) throw new Error(`${main} is the main orchestrator: designate another one before removing it`);
  }
}

export function removeProject(slug: string, fate?: AgentsFate): { agents: RemovedAgent[] } {
  const names = agentsOfProject(slug);
  if (names.length && !fate) throw new ProjectHasAgentsError(slug, names);
  const agents: RemovedAgent[] = [];
  if (fate && names.length) {
    checkFate(slug, names, fate);
    const oldCwd = readMeta(slug).cwd;
    const newCwd = fate.mode === 'move' ? readMeta(fate.to).cwd : null;
    for (const name of names) {
      // A live process carries the old project and folder.
      killRunningForAgent(name);
      if (fate.mode === 'delete') {
        deleteAgent(name);
      } else {
        const cwd = loadConfig(name).cwd;
        if (fate.mode === 'move') {
          // An agent working in the project's own folder follows it to the new project's folder.
          patchAgentConfig(name, { project: fate.to, ...(newCwd && sameDir(cwd, oldCwd) ? { cwd: newCwd } : {}) });
        } else {
          // `project` is also inferred from the folder: an agent still working in `.../projects/<slug>` would stay attached.
          const inferred = projectFromCwd(cwd)?.toLowerCase() === slug.toLowerCase();
          patchAgentConfig(name, { project: undefined, ...(inferred ? { cwd: undefined } : {}) });
        }
      }
      agents.push({ name, fate: fate.mode });
    }
  }
  deleteProject(slug);
  return { agents };
}
