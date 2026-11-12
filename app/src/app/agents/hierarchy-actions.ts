/**
 * Daemon calls behind the hierarchy gestures of the Agents page (drop, node
 * menu, Organization tree, pole dialog). Each returns an error message the
 * caller shows, or null; a move also returns how to undo it.
 */
import type { DropPlan } from '@/lib/hierarchy-drop';
import { apiErrorMessage } from '@/lib/api-error';

async function send(url: string, method: string, body?: unknown): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok) return null;
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    return apiErrorMessage(j, res.statusText || { status: res.status });
  } catch (e) {
    return (e as Error).message;
  }
}

export function setReportsTo(agent: string, manager: string | null): Promise<string | null> {
  return send(`/api/ui/agents/${encodeURIComponent(agent)}/config`, 'PATCH', { reports_to: manager });
}

/** Puts a project in a pole (by the pole's name, the tag projects carry), or
 *  takes it out of any pole with null. */
export function setProjectPole(project: string, poleName: string | null): Promise<string | null> {
  return send(`/api/ui/projects/${encodeURIComponent(project)}/meta`, 'PUT', { workspace: poleName ?? '' });
}

export type PoleInput = { name: string; color: string | null; lead_agent: string | null };

export function createPole(input: PoleInput): Promise<string | null> {
  return send('/api/ui/workspaces', 'POST', input);
}

export function updatePole(slug: string, input: Partial<PoleInput>): Promise<string | null> {
  return send(`/api/ui/workspaces/${encodeURIComponent(slug)}`, 'PATCH', input);
}

export function deletePole(slug: string): Promise<string | null> {
  return send(`/api/ui/workspaces/${encodeURIComponent(slug)}`, 'DELETE');
}

/** What a move changes, read before it runs, so it can be put back. */
export type MoveSnapshot = { reportsTo: string | null; projectPole: string | null };

export async function applyPlan(
  plan: DropPlan,
  before: MoveSnapshot,
): Promise<{ error: string | null; undo?: () => Promise<string | null> }> {
  if (plan.kind === 'reportsTo') {
    const error = await setReportsTo(plan.agent, plan.manager);
    return { error, undo: () => setReportsTo(plan.agent, before.reportsTo) };
  }
  if (plan.kind === 'moveProject') {
    const error = await setProjectPole(plan.project, plan.pole.name);
    if (error) return { error };
    if (plan.clearReportsTo) {
      const cleared = await setReportsTo(plan.agent, null);
      if (cleared) return { error: cleared };
    }
    return {
      error: null,
      undo: async () => {
        const back = await setProjectPole(plan.project, before.projectPole);
        if (back || !plan.clearReportsTo) return back;
        return setReportsTo(plan.agent, before.reportsTo);
      },
    };
  }
  return { error: null };
}
