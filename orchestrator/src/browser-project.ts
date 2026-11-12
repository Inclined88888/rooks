/**
 * The one answer to "which project does this browser belong to?" (TODO #309).
 *
 * The side panel (`/api/native-browser/resolve`), a mission at spawn, a mission
 * on later turns, a workflow node and the agent config check each rebuilt this
 * chain by hand, with different operators (`??` here, `||` there) and different
 * links. A mission and the panel that shows it could therefore land on two
 * profiles for the same agent: a login made in one was missing from the other.
 *
 * Only the project slug is decided here. The profile key (owner, scope kind,
 * scope ref) stays in `browser-profiles.ts` and is not touched by this module.
 */
import { dbApi } from './db.js';
import { projectFromCwd, projectFromRegisteredCwd, type RegisteredProject } from './task-project.js';

export type BrowserProjectInput = {
  /** `cfg.project` of the agent the browser belongs to. */
  agentProject?: string | null;
  workflowProject?: string | null;
  /** `task.project` of the task the mission runs. */
  taskProject?: string | null;
  /** The mission's own cwd (a task worktree); tried before the agent's. */
  cwdOverride?: string | null;
  agentCwd?: string | null;
  /** `?project=` of the panel: the project the user is looking at. Last. */
  requested?: string | null;
};

/** An empty or blank slug is "no project", never a project named `''`. */
const slugOrNull = (value: string | null | undefined): string | null => {
  const slug = typeof value === 'string' ? value.trim() : '';
  return slug || null;
};

/** Registered projects, one query. A cwd the registry has no row for is not guessed. */
export function registeredProjects(): RegisteredProject[] {
  return dbApi.listProjectRows().map((row) => ({ slug: row.slug, cwd: row.cwd }));
}

/**
 * Precedence: agent project → workflow project → task project → the
 * `…/projects/<slug>` marker of the mission cwd, then of the agent cwd → the
 * registered project that contains one of those cwds → `requested`.
 *
 * The marker comes before the registry so a slug that resolves today keeps
 * resolving to the same project (and the same profile, with its logins).
 * The mission cwd is a task worktree, which says nothing about the project:
 * the agent cwd is tried when it yields nothing.
 */
export function resolveBrowserProject(
  input: BrowserProjectInput,
  registered: () => RegisteredProject[] = registeredProjects,
): string | null {
  const direct = slugOrNull(input.agentProject) ?? slugOrNull(input.workflowProject) ?? slugOrNull(input.taskProject);
  if (direct) return direct;
  const cwds = [input.cwdOverride, input.agentCwd].filter((cwd): cwd is string => typeof cwd === 'string' && cwd.trim() !== '');
  for (const cwd of cwds) {
    const marked = slugOrNull(projectFromCwd(cwd));
    if (marked) return marked;
  }
  if (cwds.length) {
    const projects = registered();
    for (const cwd of cwds) {
      const known = slugOrNull(projectFromRegisteredCwd(cwd, projects));
      if (known) return known;
    }
  }
  return slugOrNull(input.requested);
}

/** `task.project` of a task id read from a spawn source or a mission row. */
export function projectOfTask(taskId: unknown): string | null {
  if (typeof taskId !== 'string' || !taskId) return null;
  return slugOrNull(dbApi.getTask(taskId)?.project);
}

/** The task a spawn is made for: the dispatcher names it in its source meta. */
export function taskIdOfSource(source: { channel: string; meta?: unknown } | undefined): string | null {
  const meta = source?.meta;
  if (!meta || typeof meta !== 'object') return null;
  const id = (meta as { task_id?: unknown }).task_id;
  return typeof id === 'string' && id ? id : null;
}
