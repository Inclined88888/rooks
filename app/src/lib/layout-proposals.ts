/**
 * A screen arrangement an agent proposes (`widgets_propose`, and the island
 * layouts after it), shown as a card "Apply this arrangement" in the
 * mission's conversation. Mirrors `LayoutProposalView`
 * (orchestrator/src/plugins-bundled/settings/layout-proposals.ts): the app and
 * the daemon are separate packages, no import possible.
 *
 * The daemon persists the proposal (`layout_proposal`) and its outcome
 * (`layout_proposal_resolved`) as conversation events: a reload replays them,
 * and the card comes back in the state it was left in.
 */

export const LAYOUT_PROPOSAL_EVENT = 'layout_proposal';
export const LAYOUT_PROPOSAL_RESOLVED_EVENT = 'layout_proposal_resolved';

export const PROPOSAL_DECISIONS = ['applied', 'dismissed'] as const;
export type ProposalDecision = (typeof PROPOSAL_DECISIONS)[number];
export type ProposalStatus = 'pending' | ProposalDecision;

export type LayoutProposalView = {
  id: string;
  /** What it arranges: `widgets` today. A kind this build does not know shows as such. */
  kind: string;
  missionId: string;
  agent: string;
  /** Validated by the daemon for its kind; parsed again by the kind's renderer. */
  payload: unknown;
  note: string | null;
  project: string | null;
  missionTitle: string;
  taskId: string | null;
  status: ProposalStatus;
  createdAt: number;
  resolvedAt: number | null;
};

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function isDecision(value: unknown): value is ProposalDecision {
  return typeof value === 'string' && (PROPOSAL_DECISIONS as readonly string[]).includes(value);
}

/** The payload of a `layout_proposal` event (or a row of the list route), or null. */
export function parseLayoutProposal(raw: unknown): LayoutProposalView | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const id = str(p.id);
  const kind = str(p.kind);
  const missionId = str(p.missionId);
  const agent = str(p.agent);
  if (!id || !kind || !missionId || !agent) return null;
  return {
    id,
    kind,
    missionId,
    agent,
    payload: p.payload ?? null,
    note: str(p.note),
    project: str(p.project),
    missionTitle: str(p.missionTitle) ?? '',
    taskId: str(p.taskId),
    status: p.status === 'pending' || isDecision(p.status) ? p.status : 'pending',
    createdAt: typeof p.createdAt === 'number' ? p.createdAt : 0,
    resolvedAt: typeof p.resolvedAt === 'number' ? p.resolvedAt : null,
  };
}

export type ProposalResolution = { id: string; status: ProposalDecision; resolvedAt: number | null };

/** The payload of a `layout_proposal_resolved` event, or null. */
export function parseProposalResolution(raw: unknown): ProposalResolution | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const id = str(p.id);
  if (!id || !isDecision(p.status)) return null;
  return { id, status: p.status, resolvedAt: typeof p.resolvedAt === 'number' ? p.resolvedAt : null };
}

/** A decision is final: a late or replayed event never sends a card back to pending. */
export function applyProposalResolution(view: LayoutProposalView, resolution: ProposalResolution): LayoutProposalView {
  if (view.id !== resolution.id || view.status !== 'pending') return view;
  return { ...view, status: resolution.status, resolvedAt: resolution.resolvedAt };
}

export type ProposalProblem = { code: string; message: string };
export type ProposalResolveError = 'stale' | 'already_decided' | 'forbidden' | 'not_found' | 'failed';
export type ProposalResolveOutcome =
  | { ok: true; proposal: LayoutProposalView | null }
  | { ok: false; error: ProposalResolveError; problems?: ProposalProblem[] };

/**
 * Records the decision. For `applied` it is a claim taken BEFORE the rows are
 * written: two tabs clicking together must not open the same new tab twice,
 * and the daemon checks the proposal again against the grants of now.
 */
export async function resolveLayoutProposal(id: string, decision: ProposalDecision): Promise<ProposalResolveOutcome> {
  let r: Response;
  try {
    r = await fetch(`/api/ui/layout/proposals/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision, origin: decision === 'applied' ? 'ui_card_apply' : 'ui_card_dismiss' }),
    });
  } catch {
    return { ok: false, error: 'failed' };
  }
  const j = await r.json().catch(() => ({})) as { proposal?: unknown; error?: string; problems?: ProposalProblem[] };
  if (r.ok) return { ok: true, proposal: parseLayoutProposal(j.proposal) };
  if (r.status === 409) {
    return j.error === 'stale'
      ? { ok: false, error: 'stale', problems: Array.isArray(j.problems) ? j.problems : [] }
      : { ok: false, error: 'already_decided' };
  }
  if (r.status === 401 || r.status === 403) return { ok: false, error: 'forbidden' };
  if (r.status === 404) return { ok: false, error: 'not_found' };
  return { ok: false, error: 'failed' };
}

/** The mission's proposals as the daemon has them now (decided ones included). */
export async function fetchLayoutProposals(missionId: string, signal?: AbortSignal): Promise<LayoutProposalView[]> {
  const qs = new URLSearchParams({ mission_id: missionId, limit: '500' });
  const r = await fetch(`/api/ui/layout/proposals?${qs.toString()}`, { cache: 'no-store', signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json() as { proposals?: unknown[] };
  return (j.proposals ?? []).map(parseLayoutProposal).filter((x): x is LayoutProposalView => x !== null);
}
