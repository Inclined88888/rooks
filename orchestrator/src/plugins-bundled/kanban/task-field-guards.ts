/**
 * The refusals a task's fields get before any write, shared by the HTTP routes
 * (`routes.ts`) and the plugin facade (`plugins/tasks-facade.ts`): a task a
 * plugin creates must be refused for exactly what an agent's is.
 *
 * Extracted verbatim from `createTaskFromBody` and `PUT /api/tasks/:id`; each
 * returns the refusal text, `null` when the value is acceptable. They refuse
 * rather than guess — a value left unrecognised used to be dropped silently
 * at dispatch (a review that never ran, a backend that fell back to the
 * agent's default).
 */
import { asBackendName, backendCatalog } from '../../backends/index.js';
import { PIPELINES, dbApi } from '../../db.js';
import { parsePlanGroup } from '../../series-service.js';

/** A group of volets is a label: non-empty, bounded, never interpreted. */
export function planGroupRefusal(planGroup: unknown): string | null {
  const parsed = parsePlanGroup(planGroup);
  return parsed.ok ? null : parsed.error;
}

/** An unknown pipeline would silently disable the review. */
export function pipelineRefusal(pipeline: string | null | undefined): string | null {
  if (pipeline != null && !(PIPELINES as readonly string[]).includes(pipeline)) {
    return `invalid pipeline "${pipeline}" (expected: ${PIPELINES.join(' | ')})`;
  }
  return null;
}

/**
 * An unknown backend would be silently dropped at dispatch (`asBackendName`
 * returns null) and the task would start on the agent's config. Same guard for the
 * fallback, plus the 'none' sentinel (= "no automatic fallback for this task").
 */
export function backendRefusal(
  body: { backend_override?: string | null; fallback_backend_override?: string | null },
): string | null {
  if (body.backend_override != null && !asBackendName(body.backend_override)) {
    return `unknown backend "${body.backend_override}" `
      + `(available: ${backendCatalog().map((b) => b.id).join(' | ')})`;
  }
  if (
    body.fallback_backend_override != null &&
    body.fallback_backend_override !== 'none' &&
    !asBackendName(body.fallback_backend_override)
  ) {
    return `unknown fallback_backend_override "${body.fallback_backend_override}" `
      + `(available: none | ${backendCatalog().map((b) => b.id).join(' | ')})`;
  }
  return null;
}

/** An unknown slug would resolve no role: the task would start without chaining. */
export function projectRefusal(project: string | null | undefined): string | null {
  if (project != null && project !== '' && !dbApi.getProjectRow(project)) {
    return `unknown project "${project}" `
      + `(known: ${dbApi.listProjectRows().map((p) => p.slug).join(' | ') || '(none)'})`;
  }
  return null;
}

export { isPlausibleGitRef } from '../../task-git.js';
