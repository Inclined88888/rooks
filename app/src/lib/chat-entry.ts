/**
 * Which agent a `/chat` opened without `?agent=` belongs to.
 *
 * The page used to answer `_main`, the name the seed gives the main agent.
 * Onboarding renames it, so on most installs that name matches nobody: the
 * chat and the workspace provider each asked the daemon for it, and each got
 * a 404 (TIM-0011). The main agent is found by ROLE (`agentPrincipal()`), and
 * this is resolved BEFORE the chat mounts, so nothing ever asks for an agent
 * by a name nobody chose.
 */
import { agentPrincipal, type AgentInstalle } from '@/plugins-client/agent-chat/instances';
import { sharedGet } from '@/lib/shared-read';
import { apiErrorMessage } from '@/lib/api-error';
import { mainSeatCandidates } from '@/lib/main-agent';

type Fetcher = (url: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'json'>>;

async function readJson(fetcher: Fetcher, url: string): Promise<unknown> {
  try {
    const res = await fetcher(url, { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * The agent to open, or `null` when the install has no main agent to offer.
 *
 * A mission-only link opens the mission's owner: defaulting to the main agent
 * would bind the requested id to someone else's conversation list. A task-only
 * link (a notification about a task that never got a mission, e.g. a BLOCKED
 * one) opens the task's assignee for the same reason (TIM-0079).
 */
export async function resolveChatAgent(
  params: URLSearchParams,
  fetcher: Fetcher = fetch,
): Promise<string | null> {
  const explicit = params.get('agent');
  if (explicit) return explicit;
  const mission = params.get('mission');
  if (mission) {
    const owner = missionOwnerAgent(await readJson(fetcher, '/api/ui/missions/' + encodeURIComponent(mission)));
    if (owner) return owner;
  }
  const task = params.get('task');
  if (task) {
    const detail = await readJson(fetcher, '/api/ui/tasks/' + encodeURIComponent(task)) as
      { task?: { agent_name?: unknown } } | null;
    const owner = detail?.task?.agent_name;
    if (typeof owner === 'string' && owner) return owner;
  }
  const list = await readJson(fetcher, '/api/ui/agents') as { agents?: AgentInstalle[] } | null;
  return agentPrincipal(Array.isArray(list?.agents) ? list.agents : []);
}

/**
 * Why a bare `/chat` found no main agent. The screen used to say only "Unable
 * to find the main agent", for a list the daemon refused and for a list that
 * named nobody alike, so a tester's report could not tell the two apart
 * (TIM-0079). It also lists who can take the seat, so the screen can offer it.
 */
export type MissingMainAgent =
  | { kind: 'unreadable'; status: number | null }
  | { kind: 'undesignated'; candidates: string[] }
  | { kind: 'none' };

type StatusFetcher = (url: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'json' | 'status'>>;

export async function explainMissingMainAgent(fetcher: StatusFetcher = fetch): Promise<MissingMainAgent> {
  let res: Pick<Response, 'ok' | 'json' | 'status'>;
  try { res = await fetcher('/api/ui/agents', { cache: 'no-store' }); } catch { return { kind: 'unreadable', status: null }; }
  if (!res.ok) return { kind: 'unreadable', status: res.status };
  const body = await res.json().catch(() => null) as { agents?: unknown } | null;
  if (!Array.isArray(body?.agents)) return { kind: 'unreadable', status: res.status };
  const listed = (body.agents as Array<Record<string, unknown>>)
    .filter((a) => typeof a?.name === 'string')
    .map((a) => ({
      name: a.name as string,
      role: typeof a.role === 'string' ? a.role : null,
      project: typeof a.project === 'string' ? a.project : null,
      ephemeral: a.ephemeral === true,
    }));
  const candidates = mainSeatCandidates(listed);
  return candidates.length > 0 ? { kind: 'undesignated', candidates } : { kind: 'none' };
}

/** Seats `name` as the main agent (`PUT /api/agents/main`): the error the
 *  daemon gave, or `null` once it is done. */
export async function designateMainAgent(name: string, fetcher: StatusFetcher = fetch): Promise<string | null> {
  try {
    const res = await fetcher('/api/ui/agents/main', {
      method: 'PUT',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (res.ok) return null;
    const data = await res.json().catch(() => null) as { error?: unknown } | null;
    return apiErrorMessage(data, { status: res.status });
  } catch (err) {
    return (err as Error).message;
  }
}

/** The agent a mission detail (`GET /api/ui/missions/:id`) belongs to. */
export function missionOwnerAgent(detail: unknown): string | null {
  if (!detail || typeof detail !== 'object') return null;
  const owner = (detail as { agent_name?: unknown }).agent_name;
  return typeof owner === 'string' && owner ? owner : null;
}

/**
 * The chat URL once a mission is bound: `?mission=` names it and `?agent=` its
 * owner, the shape every "open this mission" link already writes. A mission
 * picked from the project's rail may belong to another agent than the one in
 * the URL (TODO #460). `null` when the URL already says so.
 */
export function pinnedChatUrl(url: URL, missionId: string, owner: string | null): string | null {
  const agentOk = !owner || url.searchParams.get('agent') === owner;
  if (agentOk && url.searchParams.get('mission') === missionId) return null;
  const next = new URL(url.toString());
  if (owner) next.searchParams.set('agent', owner);
  next.searchParams.set('mission', missionId);
  next.searchParams.delete('fresh');
  return next.toString();
}

/**
 * The history state to write a pinned URL with. Next's own state (`__NA`)
 * makes its patched `replaceState` leave the router alone: right for a
 * mission of the same agent, bound in place. A change of agent must reach
 * the router instead (`null`): the route tab's title, the top bar's open
 * chat and the view all read `useSearchParams`, and kept on the previous
 * agent while the chat showed another one (TIM-0140).
 */
export function pinnedChatHistoryState<S>(url: URL, owner: string | null, current: S): S | null {
  return owner && url.searchParams.get('agent') !== owner ? null : current;
}

/**
 * What the page's chat writes into the address bar once a conversation is
 * bound, `null` when the URL already says it. `kept`: the page's panel of a
 * split view kept another agent's conversation (`keepInView`, TIM-0140) — the
 * URL names the mission under the view's agent, and the router hears it
 * (`null` state), so that the panel's tab reads what the workspace keeps.
 * Otherwise the URL takes the mission's owner (`pinnedChatUrl`), told to the
 * router when it changes agent (`pinnedChatHistoryState`).
 */
export function chatPin<S>(url: URL, missionId: string, owner: string | null, kept: boolean, current: S): { href: string; state: S | null } | null {
  if (kept) {
    const href = pinnedChatUrl(url, missionId, null);
    return href ? { href, state: null } : null;
  }
  const href = pinnedChatUrl(url, missionId, owner);
  return href ? { href, state: pinnedChatHistoryState(url, owner, current) } : null;
}

/**
 * The conversation a chat is asked to open. A chat with its own agent (an
 * island, a card, a multichat cell) never takes the page's `?mission=`: a
 * fresh island bound the route's conversation, another agent's, under its
 * own name (TIM-0140).
 */
export function requestedChatMission(forcedAgent: string | undefined, forcedMission: string | undefined, urlMission: string | null): string | null {
  if (forcedMission) return forcedMission;
  return forcedAgent ? null : urlMission || null;
}

/** The same chat URL, with its agent spelled out. */
export function chatUrlWithAgent(params: URLSearchParams, agent: string): string {
  const next = new URLSearchParams(params.toString());
  next.set('agent', agent);
  return '/chat?' + next.toString();
}

// Share only overlapping reads: settled identities must not survive a new
// visit or account. Each consumer owns its response body and cancellation.
export function fetchAgentDetails(agent: string): Promise<Response> {
  return sharedGet('/api/ui/agents/' + encodeURIComponent(agent));
}
