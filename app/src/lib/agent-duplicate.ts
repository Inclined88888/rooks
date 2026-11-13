/**
 * Duplicating an agent from a right-click menu: read the source through the
 * existing routes, write the copy with `POST /api/agents` (same guards as the
 * editor's save — `agents:manage`, cwd, MCP and privilege checks).
 *
 * What the copy does NOT inherit, on purpose: the "main" seat (there is one),
 * the role pinned in a project's `roles.json` (the copy must not steal it from
 * a project agent), and everything the source lived through — sessions,
 * missions, memory and learnings start empty.
 */

import type { SkillAttachment } from './skill-attachments';

/** Same alphabet as the daemon's `validName`. */
export const AGENT_NAME_RE = /^[A-Za-z0-9._-]+$/;

export type DuplicateNameProblem = 'empty' | 'invalid' | 'taken';

/**
 * Why `name` cannot be the copy's name, or null. The match on existing names
 * ignores case: a case-insensitive disk (Windows, macOS) would merge two
 * folders that differ only by it, and `POST /api/agents` upserts — a taken name
 * would overwrite the other agent.
 */
export function duplicateNameProblem(name: string, existing: readonly string[]): DuplicateNameProblem | null {
  const trimmed = name.trim();
  if (!trimmed) return 'empty';
  if (!AGENT_NAME_RE.test(trimmed)) return 'invalid';
  const lower = trimmed.toLowerCase();
  if (existing.some((n) => n.toLowerCase() === lower)) return 'taken';
  return null;
}

/** The agent as `GET /api/agents/:name` returns it (the part a copy carries). */
export type DuplicateSource = {
  system_prompt?: string;
  backend?: string;
  model?: string | null;
  cwd?: string | null;
  project?: string | null;
  browser_profile_id?: string | null;
  permission_mode?: string | null;
  allowed_tools?: string[];
  disallowed_tools?: string[];
  skills?: string[];
  mcp_servers?: string[];
  excluded_mcp_servers?: string[];
  memory_scope?: string | null;
  role?: string | null;
  directives?: string | null;
  reasoning_effort?: string | null;
  global_context?: boolean;
  reports_to?: string | null;
  team?: string | null;
  emoji?: string | null;
  color?: string | null;
  icon_url?: string | null;
  /** Mascot look and picked head: copied as they are, the daemon checks them. */
  look?: unknown;
  avatar?: string | null;
};

type CopyConfig = Record<string, unknown>;

/** Body of the `POST /api/agents` that writes the copy. */
export function duplicateBody(source: DuplicateSource, name: string): { name: string; system_prompt: string; config: CopyConfig } {
  const config: CopyConfig = {};
  const keep = (key: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== '') config[key] = value;
  };
  keep('cwd', source.cwd);
  keep('project', source.project);
  keep('browser_profile_id', source.browser_profile_id);
  keep('backend', source.backend);
  keep('model', source.model);
  keep('permission_mode', source.permission_mode);
  if (source.allowed_tools?.length) config.allowed_tools = [...source.allowed_tools];
  if (source.disallowed_tools?.length) config.disallowed_tools = [...source.disallowed_tools];
  // The daemon writes these as catalogue attachments of the copy, not into its
  // config.json; `copyOwnAttachments` then restores the source's modes.
  if (source.skills?.length) config.skills = [...source.skills];
  if (source.mcp_servers?.length) config.mcp_servers = [...source.mcp_servers];
  // Always written, even empty: a fresh agent without this key gets the
  // default-deny list of external connectors, not the source's choice.
  config.excluded_mcp_servers = [...(source.excluded_mcp_servers ?? [])];
  if (source.memory_scope && source.memory_scope !== 'NONE') config.memory_scope = source.memory_scope;
  keep('role', source.role);
  keep('directives', source.directives);
  keep('reasoningEffort', source.reasoning_effort);
  if (source.global_context) config.global_context = true;
  keep('reports_to', source.reports_to);
  keep('team', source.team);
  keep('emoji', source.emoji);
  keep('color', source.color);
  keep('icon_url', source.icon_url);
  if (typeof source.look === 'object' && source.look !== null) config.look = source.look;
  keep('avatar', source.avatar);
  return { name, system_prompt: source.system_prompt ?? '', config };
}

export type DuplicateResult =
  /** `skillsNotCopied`: source attachments the copy could not get (the agent exists anyway). */
  | { ok: true; name: string; skillsNotCopied?: string[] }
  | { ok: false; problem: DuplicateNameProblem }
  | { ok: false; error: string };

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

async function errorOf(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
  } catch { /* not JSON: use the text */ }
  return text.slice(0, 160) || response.statusText || String(response.status);
}

/** Names of every agent, read fresh: the guard must not trust a stale list. */
export async function listAgentNames(fetcher: Fetcher = fetch): Promise<string[]> {
  const response = await fetcher('/api/ui/agents', { cache: 'no-store' });
  if (!response.ok) throw new Error(await errorOf(response));
  const body = (await response.json()) as { agents?: Array<{ name: string }> };
  return (body.agents ?? []).map((a) => a.name);
}

/** The source's own attachments (agent scope), read before anything is written. */
async function ownAttachments(sourceName: string, fetcher: Fetcher): Promise<SkillAttachment[]> {
  const qs = new URLSearchParams({ scope: 'agent', target: sourceName });
  const response = await fetcher(`/api/ui/skill-attachments?${qs.toString()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(await errorOf(response));
  const body = (await response.json()) as { attachments?: SkillAttachment[] };
  return (body.attachments ?? []).filter((a) => a.scope === 'agent');
}

/**
 * `skills` gave the copy one catalogue (`include`) attachment per checked
 * skill; what that list cannot say — an `import`, an exclusion of an inherited
 * skill — is written as the source has it. Returns the skills that failed.
 */
async function copyOwnAttachments(own: SkillAttachment[], name: string, fetcher: Fetcher): Promise<string[]> {
  const failed: string[] = [];
  for (const a of own) {
    if (a.mode === 'include' && !a.exclude) continue;
    const response = await fetcher('/api/ui/skill-attachments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ skill: a.skill, scope: 'agent', target: name, mode: a.mode, exclude: a.exclude }),
    }).catch(() => null);
    if (!response?.ok) failed.push(a.skill);
  }
  return failed;
}

/**
 * Create `newName` as a copy of `sourceName`. The name is re-checked against a
 * fresh list right before the POST (the route upserts, so a name taken in the
 * meantime would be overwritten), never trusting the dialog's own check.
 */
export async function duplicateAgent(sourceName: string, newName: string, fetcher: Fetcher = fetch): Promise<DuplicateResult> {
  const name = newName.trim();
  try {
    const problem = duplicateNameProblem(name, await listAgentNames(fetcher));
    if (problem) return { ok: false, problem };
    const read = await fetcher('/api/ui/agents/' + encodeURIComponent(sourceName), { cache: 'no-store' });
    if (!read.ok) return { ok: false, error: await errorOf(read) };
    const source = (await read.json()) as DuplicateSource;
    const own = await ownAttachments(sourceName, fetcher);
    const write = await fetcher('/api/ui/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(duplicateBody(source, name)),
    });
    if (!write.ok) return { ok: false, error: await errorOf(write) };
    const failed = await copyOwnAttachments(own, name, fetcher);
    return failed.length ? { ok: true, name, skillsNotCopied: failed } : { ok: true, name };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
