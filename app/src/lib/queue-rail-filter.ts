/**
 * The "Tasks" rail's project filter, as pure functions. A mission carries no
 * project of its own — it follows its agent's; a task follows its own `project`
 * when it was created with one, else its agent's (same rule as the Kanban board,
 * `taskProject`).
 */
import { ALL_FILTER, taskProject } from './kanban-filters';

/** Per browser, like the Project TO DO widget's choice. */
export const QUEUE_RAIL_PROJECT_KEY = 'timon.queue-rail.project';

type QueueTask = { agent_name: string; project?: string | null };
type QueueMission = { agent_name: string };

/**
 * `slug` is the project to keep; `ALL_FILTER` (or null) keeps everything. The
 * agent map is passed whole, so an agent absent from it belongs to no project
 * and is hidden while a project is selected.
 */
export function filterQueueByProject<M extends QueueMission, T extends QueueTask>(
  missions: readonly M[],
  tasks: readonly T[],
  slug: string | null,
  projectByAgent: ReadonlyMap<string, string | null>,
): { missions: M[]; tasks: T[] } {
  if (!slug || slug === ALL_FILTER) return { missions: [...missions], tasks: [...tasks] };
  return {
    missions: missions.filter((m) => (projectByAgent.get(m.agent_name) ?? null) === slug),
    tasks: tasks.filter((t) => taskProject(t, projectByAgent) === slug),
  };
}

export function readQueueRailProject(storage: Pick<Storage, 'getItem'> | null): string {
  try { return storage?.getItem(QUEUE_RAIL_PROJECT_KEY) || ALL_FILTER; } catch { return ALL_FILTER; }
}

export function writeQueueRailProject(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, slug: string): void {
  try {
    if (slug === ALL_FILTER) storage?.removeItem(QUEUE_RAIL_PROJECT_KEY);
    else storage?.setItem(QUEUE_RAIL_PROJECT_KEY, slug);
  } catch { /* private mode: the choice just isn't kept */ }
}
