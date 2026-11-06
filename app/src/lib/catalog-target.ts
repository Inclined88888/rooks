/**
 * Who a model catalogue is read for: `GET /api/backends/catalog?project=&agent=`
 * (TODO #531, 5-B). The daemon then leaves out a backend whose reserved key this
 * mission would not receive. A filter, never a right: the spawn decides again.
 *
 * Free of React and of `'use client'`, because the Next route forwards the same
 * two parameters the browser's store keys its cache on.
 */

export type CatalogTarget = { project?: string | null; agent?: string | null };

/** `project=…&agent=…`, or `''` for the whole inventory. Nothing else gets through. */
export function catalogTargetQuery(target: CatalogTarget | null | undefined): string {
  const query = new URLSearchParams();
  const project = target?.project?.trim();
  const agent = target?.agent?.trim();
  if (project) query.set('project', project);
  if (agent) query.set('agent', agent);
  return query.toString();
}
