/**
 * The agent step's two round trips to the daemon: read the main agent as it
 * stands (its seat, its config), then create it — the name first (the seed is
 * renamed and recorded as the main agent, `POST /api/setup/main-agent/name`),
 * then everything else in one config PATCH on the name the daemon answered.
 *
 * Both are the existing routes of the wizard's browser session; the step adds
 * none. The chat step after it finds the agent named and opens its conversation.
 */
import type { AgentConfigPatch } from './agent-draft';

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export const MAIN_AGENT_STATUS_PATH = '/api/ui/setup/main-agent';
export const MAIN_AGENT_NAME_PATH = '/api/ui/setup/main-agent/name';
export const agentPath = (name: string): string => `/api/ui/agents/${encodeURIComponent(name)}`;
export const agentConfigPath = (name: string): string => `${agentPath(name)}/config`;

/** What the step needs of the agent before it is created. */
export type MainAgentState = {
  /** The seat's current name (`_main` on a fresh install). */
  name: string | null;
  /** The name step already ran: the field shows that name, not a drawn one. */
  named: boolean;
  backend: string | null;
  model: string | null;
  skills: string[];
  mcpServers: string[];
  look: unknown;
  /** `config.role`: the default look the mascot starts from when none was picked. */
  role: string | null;
};

const EMPTY: MainAgentState = { name: null, named: false, backend: null, model: null, skills: [], mcpServers: [], look: null, role: null };

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** Never throws: an agent that cannot be read is created from scratch, and the creation says what failed. */
export async function loadMainAgent(fetcher: Fetcher = fetch): Promise<MainAgentState> {
  try {
    const res = await fetcher(MAIN_AGENT_STATUS_PATH, { cache: 'no-store' });
    if (!res.ok) return EMPTY;
    const status = await res.json() as { name?: unknown; named?: unknown };
    const name = text(status.name);
    if (!name) return EMPTY;
    const state: MainAgentState = { ...EMPTY, name, named: status.named === true };
    const details = await fetcher(agentPath(name), { cache: 'no-store' });
    if (!details.ok) return state;
    const agent = await details.json() as Record<string, unknown>;
    return {
      ...state,
      backend: text(agent.backend),
      model: text(agent.model),
      skills: strings(agent.skills),
      mcpServers: strings(agent.mcp_servers),
      look: agent.look ?? null,
      role: text(agent.role),
    };
  } catch {
    return EMPTY;
  }
}

/** The daemon's refusal codes the step words itself (`mainAgentSetup.<code>`); anything else is `failed`. */
const NAME_ERRORS = new Set(['invalid_name', 'name_taken', 'rename_failed', 'workspace_unavailable', 'main_agent_unavailable']);

export type CreationResult = { ok: true; name: string } | { ok: false; error: string; stage: 'name' | 'config' };

export async function createMainAgent(name: string, patch: AgentConfigPatch, fetcher: Fetcher = fetch): Promise<CreationResult> {
  let created: string;
  try {
    const res = await fetcher(MAIN_AGENT_NAME_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const body = await res.json().catch(() => ({})) as { name?: unknown; error?: unknown };
    if (!res.ok || typeof body.name !== 'string') {
      const code = typeof body.error === 'string' && NAME_ERRORS.has(body.error) ? body.error : 'failed';
      return { ok: false, error: code, stage: 'name' };
    }
    created = body.name;
  } catch {
    return { ok: false, error: 'failed', stage: 'name' };
  }
  try {
    const res = await fetcher(agentConfigPath(created), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return { ok: false, error: 'configFailed', stage: 'config' };
  } catch {
    return { ok: false, error: 'configFailed', stage: 'config' };
  }
  return { ok: true, name: created };
}

/* ---------- The sheet's lists: the daemon's skills and MCP servers ---------- */

export type CatalogItem = { id: string; label: string };
export type SheetCatalogs = { skills: CatalogItem[]; mcp: CatalogItem[] };

/** The product's own skills (`rooks-*`) are attached by the product where they belong: not a choice to offer here. */
const PRODUCT_SKILL = /^rooks-/;
/** Imported from the person's AI account or CLI config: on by default, turned off elsewhere (`excluded_mcp_servers`). */
const OPT_OUT_MCP = new Set(['claude_ai', 'claude_cli']);

export function sheetSkills(raw: unknown): CatalogItem[] {
  const list = Array.isArray(raw) ? raw as Record<string, unknown>[] : [];
  return list
    .filter((s) => typeof s.id === 'string' && !PRODUCT_SKILL.test(s.id) && s.shadowed !== true)
    .map((s) => ({ id: s.id as string, label: text(s.title) ?? (s.id as string) }));
}

export function sheetMcp(raw: unknown): CatalogItem[] {
  const list = Array.isArray(raw) ? raw as Record<string, unknown>[] : [];
  return list
    .filter((s) => typeof s.id === 'string' && !(typeof s.source === 'string' && OPT_OUT_MCP.has(s.source)))
    .map((s) => ({ id: s.id as string, label: text(s.name) ?? (s.id as string) }));
}

/** Empty lists when the daemon refuses or cannot be reached: the sheet says there is nothing to pick. */
export async function loadSheetCatalogs(fetcher: Fetcher = fetch): Promise<SheetCatalogs> {
  const read = async (path: string, key: string): Promise<unknown> => {
    try {
      const res = await fetcher(path, { cache: 'no-store' });
      return res.ok ? ((await res.json()) as Record<string, unknown>)[key] : [];
    } catch { return []; }
  };
  const [skills, mcp] = await Promise.all([read('/api/ui/skills', 'skills'), read('/api/ui/mcp', 'servers')]);
  return { skills: sheetSkills(skills), mcp: sheetMcp(mcp) };
}
