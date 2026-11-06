/**
 * Views that `/agents` used to hold behind a group tab, kept for ONE purpose:
 * translating an old link into the route that serves it today. `grid` was
 * renamed `projects` before the split, so both spellings must resolve.
 */
export type AgentsView = 'canvas' | 'projects' | 'company';
export function isAgentsView(value: string | null | undefined): value is AgentsView {
  return value === 'canvas' || value === 'projects' || value === 'company';
}
export function normalizeAgentsView(value: string | null | undefined): AgentsView | null {
  return value === 'grid' ? 'projects' : isAgentsView(value) ? value : null;
}
