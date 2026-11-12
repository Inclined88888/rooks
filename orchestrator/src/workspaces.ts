/**
 * Workspaces ("poles"): named groups of projects, each optionally led by an
 * agent that orchestrates it.
 *
 * A workspace used to exist only as a free tag on project meta, and its lead
 * was recognised by name (`_main.<ws>`). It is now a row of its own, so an
 * empty pole can exist and its lead is a field. Projects still carry the tag
 * they always had (`projects.workspace`); it matches a pole through
 * `workspaceSlug()` or the pole's name, so "Design Studio" belongs to the pole
 * `design-studio` without rewriting anybody's project meta.
 */
import { getAgent } from './agent.js';
import { dbApi, type WorkspaceRow } from './db.js';

export type Workspace = {
  slug: string;
  name: string;
  color: string | null;
  lead_agent: string | null;
  /** Project slugs in this pole. */
  projects: string[];
};

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** Seed name of the hubs that predate the table — read once, to adopt them. */
const LEGACY_HUB_PREFIX = '_main.';

export function workspaceSlug(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function agentExists(name: string): boolean {
  try { return !!getAgent(name); } catch { return false; }
}

/** Pole a project tag belongs to: by slug, or by the pole's current name —
 *  a renamed pole keeps its slug, and a project tagged with the new name must
 *  join it rather than spawn a second pole. */
function poleOfTag(tag: string, rows: readonly WorkspaceRow[]): string | null {
  const slug = workspaceSlug(tag);
  if (rows.some((r) => r.slug === slug)) return slug;
  const name = tag.trim().toLowerCase();
  return rows.find((r) => r.name.toLowerCase() === name)?.slug ?? null;
}

/** Creates a row for every project tag that has none yet. Idempotent: it runs
 *  on each read, which is how existing installs migrate. A legacy hub agent
 *  `_main.<slug>` becomes the lead of the pole it was named after. */
export function syncWorkspaceTags(): void {
  const rows = dbApi.listWorkspaceRows();
  for (const p of dbApi.listProjectRows()) {
    if (!p.workspace || poleOfTag(p.workspace, rows)) continue;
    const slug = workspaceSlug(p.workspace);
    if (!slug) continue;
    const hub = LEGACY_HUB_PREFIX + slug;
    const row = { slug, name: p.workspace.trim(), color: null, lead_agent: agentExists(hub) ? hub : null };
    dbApi.insertWorkspace(row);
    rows.push({ ...row, created_at: 0, updated_at: 0 });
  }
}

function withProjects(rows: WorkspaceRow[]): Workspace[] {
  const all = dbApi.listWorkspaceRows();
  const bySlug = new Map<string, string[]>();
  for (const p of dbApi.listProjectRows()) {
    if (!p.workspace) continue;
    const slug = poleOfTag(p.workspace, all);
    if (slug) bySlug.set(slug, [...(bySlug.get(slug) ?? []), p.slug]);
  }
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    color: r.color,
    lead_agent: r.lead_agent,
    projects: bySlug.get(r.slug) ?? [],
  }));
}

export function listWorkspaceRecords(): Workspace[] {
  syncWorkspaceTags();
  return withProjects(dbApi.listWorkspaceRows());
}

export function getWorkspace(slug: string): Workspace | null {
  syncWorkspaceTags();
  const row = dbApi.getWorkspaceRow(slug);
  return row ? withProjects([row])[0]! : null;
}

/** The pole a free-text tag designates (by slug or by name, case-insensitive),
 *  or null when none does. Callers that must not mint a pole from a typo ask
 *  this first. */
export function findWorkspaceByTag(tag: string): Workspace | null {
  syncWorkspaceTags();
  const slug = poleOfTag(tag, dbApi.listWorkspaceRows());
  return slug ? getWorkspace(slug) : null;
}

function checkLead(lead: string | null | undefined): void {
  if (lead && !agentExists(lead)) throw new Error(`unknown agent: "${lead}"`);
}

export function createWorkspace(input: { name: string; slug?: string; color?: string | null; lead_agent?: string | null }): Workspace {
  const name = input.name.trim();
  const slug = input.slug ?? workspaceSlug(name);
  if (!name || !SLUG_RE.test(slug)) throw new Error(`invalid workspace name: "${input.name}"`);
  syncWorkspaceTags();
  if (dbApi.getWorkspaceRow(slug)) throw new Error(`workspace already exists: "${slug}"`);
  checkLead(input.lead_agent);
  dbApi.insertWorkspace({ slug, name, color: input.color ?? null, lead_agent: input.lead_agent ?? null });
  return getWorkspace(slug)!;
}

export function updateWorkspace(slug: string, patch: { name?: string; color?: string | null; lead_agent?: string | null }): Workspace {
  if (!getWorkspace(slug)) throw new Error(`unknown workspace: "${slug}"`);
  checkLead(patch.lead_agent);
  const name = patch.name?.trim();
  if (patch.name !== undefined && !name) throw new Error('name must not be empty');
  dbApi.updateWorkspace(slug, { name, color: patch.color, lead_agent: patch.lead_agent });
  return getWorkspace(slug)!;
}

/** Deletes the pole. Its projects stay, without a workspace; its lead agent
 *  stays too — deleting a pole never deletes an agent. */
export function deleteWorkspace(slug: string): void {
  const ws = getWorkspace(slug);
  if (!ws) throw new Error(`unknown workspace: "${slug}"`);
  dbApi.deleteWorkspace(slug, ws.projects);
}
