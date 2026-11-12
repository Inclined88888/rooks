/**
 * What dropping one node onto another means, for the Agents graph and the
 * Organization tree alike. Pure: the caller executes the plan.
 *
 *  - agent onto agent            → the agent now reports to the target;
 *  - project lead onto a pole    → the whole project moves into that pole
 *    (onto its grouping node, or onto the agent leading it), and a manager
 *    set by hand is dropped so the project hangs from its new pole;
 *  - any other agent onto a pole → refused: a pole groups projects, and only
 *    the project's lead carries the project with it.
 */
import { workspaceNodeId, type Hierarchy, type HierarchyAgent } from './hierarchy';

export type DropPole = { slug: string; name: string };

export type DropPlan =
  | { kind: 'reportsTo'; agent: string; manager: string }
  | { kind: 'moveProject'; agent: string; project: string; pole: DropPole; clearReportsTo: boolean }
  | { kind: 'none'; reason: 'same' | 'unchanged' | 'pole-source' | 'not-a-project' | 'not-the-lead' | 'unknown' };

const POLE_PREFIX = workspaceNodeId('');

export function planDrop(
  source: string,
  target: string,
  agents: readonly HierarchyAgent[],
  poles: readonly DropPole[],
  hierarchy: Hierarchy,
): DropPlan {
  if (source === target) return { kind: 'none', reason: 'same' };
  if (source.startsWith(POLE_PREFIX)) return { kind: 'none', reason: 'pole-source' };
  const agent = agents.find((a) => a.name === source);
  if (!agent) return { kind: 'none', reason: 'unknown' };

  const targetPole = target.startsWith(POLE_PREFIX)
    ? target.slice(POLE_PREFIX.length)
    : hierarchy.workspaceOfLead.get(target) ?? null;
  const project = agent.project?.toLowerCase() ?? null;
  const leadsProject = !!project && hierarchy.leadOfProject.get(project) === agent.name;

  if (targetPole && (leadsProject || target.startsWith(POLE_PREFIX))) {
    const pole = poles.find((p) => p.slug === targetPole);
    if (!pole) return { kind: 'none', reason: 'unknown' };
    if (!project) return { kind: 'none', reason: 'not-a-project' };
    if (!leadsProject) return { kind: 'none', reason: 'not-the-lead' };
    if (hierarchy.workspaceOfProject.get(project) === pole.slug && !agent.reports_to) return { kind: 'none', reason: 'unchanged' };
    return { kind: 'moveProject', agent: agent.name, project: agent.project!, pole, clearReportsTo: !!agent.reports_to };
  }

  if (!agents.some((a) => a.name === target)) return { kind: 'none', reason: 'unknown' };
  const current = hierarchy.parentOf.get(agent.name);
  if (current?.kind === 'agent' && current.id === target) return { kind: 'none', reason: 'unchanged' };
  return { kind: 'reportsTo', agent: agent.name, manager: target };
}
