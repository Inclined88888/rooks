/** Browser credentials live in isolated engine storage, never copied from a
 * more general profile. This registry stores identity and access policy only. */
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { db, ownerSql, rowVisible, type DbViewer, type MissionRow } from './db.js';
import { loadConfig, validName } from './agent-config.js';
import { browserProfileDir } from './paths.js';

export type BrowserProfileScope = 'general' | 'project' | 'agent' | 'custom';
export type BrowserProfileGrants = { agent_names?: string[]; workflow_slugs?: string[] };
export type BrowserProfile = {
  id: string;
  owner_user_id: string | null;
  name: string;
  scope_kind: BrowserProfileScope;
  scope_ref: string | null;
  grants: BrowserProfileGrants;
  created_at: number;
  updated_at: number;
};
type StoredProfile = Omit<BrowserProfile, 'grants'> & { grants: string };
export type CreateBrowserProfileInput = {
  name: string;
  owner_user_id?: string | null;
  scope_kind?: BrowserProfileScope;
  scope_ref?: string | null;
  grants?: BrowserProfileGrants;
};
export type BrowserProfileResolution = {
  ownerUserId: string | null;
  agentName?: string;
  project?: string | null;
  workflowSlug?: string;
  /** undefined = inherit; null = explicitly no browser. */
  selection?: string | null;
};

export const isBrowserProfileId = (id: unknown): id is string =>
  typeof id === 'string' && /^bp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);

function decode(row: StoredProfile): BrowserProfile {
  return { ...row, grants: JSON.parse(row.grants) as BrowserProfileGrants };
}

export function listBrowserProfiles(viewer?: DbViewer | null): BrowserProfile[] {
  const owner = ownerSql(viewer, 'browser_profiles');
  return (db.prepare(`SELECT * FROM browser_profiles WHERE ${owner.sql} ORDER BY name, id`).all(...owner.params) as StoredProfile[]).map(decode);
}

export function getBrowserProfile(id: string, viewer?: DbViewer | null): BrowserProfile | null {
  if (!isBrowserProfileId(id)) return null;
  const row = rowVisible(db.prepare('SELECT * FROM browser_profiles WHERE id=?').get(id) as StoredProfile | undefined, viewer, 'browser_profiles');
  return row ? decode(row) : null;
}

export function createBrowserProfile(input: CreateBrowserProfileInput, viewer?: DbViewer | null): BrowserProfile {
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 160) throw new Error('browser profile name must be 1–160 characters');
  const kind = input.scope_kind ?? 'custom';
  if (!['general', 'project', 'agent', 'custom'].includes(kind)) throw new Error('invalid browser profile scope');
  const ref = input.scope_ref ?? null;
  if ((kind === 'general' || kind === 'custom') && ref !== null) throw new Error('this browser profile scope does not accept a reference');
  if ((kind === 'project' || kind === 'agent') && (typeof ref !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/.test(ref))) throw new Error('browser profile scope requires a valid reference');
  // A privileged viewer can inspect all rows, but cannot silently assign
  // credentials owned by somebody else to their own missions.
  const owner = input.owner_user_id === undefined ? viewer?.id ?? null : input.owner_user_id;
  if (owner !== null && (typeof owner !== 'string' || !owner || owner.length > 200)) throw new Error('invalid browser profile owner');
  if (viewer && owner !== viewer.id) throw new Error('browser profile owner must be the current user');
  const grants: BrowserProfileGrants = {};
  if (input.grants !== undefined && (!input.grants || typeof input.grants !== 'object' || Array.isArray(input.grants))) throw new Error('invalid browser profile grants');
  for (const key of ['agent_names', 'workflow_slugs'] as const) {
    const values = input.grants?.[key];
    if (values !== undefined) {
      if (!Array.isArray(values) || values.length > 1000 || values.some((value) => typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/.test(value))) throw new Error(`invalid browser profile ${key}`);
      grants[key] = [...new Set(values)];
    }
  }
  const now = Date.now();
  const profile: BrowserProfile = { id: `bp-${randomUUID()}`, owner_user_id: owner, name: input.name.trim(), scope_kind: kind, scope_ref: ref, grants, created_at: now, updated_at: now };
  db.prepare('INSERT INTO browser_profiles (id, owner_user_id, name, scope_kind, scope_ref, grants, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(profile.id, owner, profile.name, kind, ref, JSON.stringify(grants), now, now);
  return profile;
}

/** Scope and optional grants restrict use, while owner equality is mandatory
 * even for a superadmin's mission. Grant lists are an explicit allowlist (OR). */
export function browserProfileAllows(profile: BrowserProfile, context: BrowserProfileResolution): boolean {
  if (profile.owner_user_id !== context.ownerUserId) return false;
  const { agent_names, workflow_slugs } = profile.grants;
  if (agent_names !== undefined || workflow_slugs !== undefined) {
    return !!((context.agentName && agent_names?.includes(context.agentName)) || (context.workflowSlug && workflow_slugs?.includes(context.workflowSlug)));
  }
  if (profile.scope_kind === 'agent') return profile.scope_ref === context.agentName;
  if (profile.scope_kind === 'project') return profile.scope_ref === context.project;
  return true;
}

function scopedProfile(owner: string | null, kind: BrowserProfileScope, ref: string | null): BrowserProfile | null {
  const row = db.prepare('SELECT * FROM browser_profiles WHERE owner_user_id IS ? AND scope_kind=? AND scope_ref IS ?').get(owner, kind, ref) as StoredProfile | undefined;
  return row ? decode(row) : null;
}

function requireAllowed(profile: BrowserProfile | null, context: BrowserProfileResolution): BrowserProfile {
  if (!profile || !browserProfileAllows(profile, context)) throw new Error('browser profile not found or forbidden for this agent/workflow');
  return profile;
}

export function resolveBrowserProfile(context: BrowserProfileResolution): BrowserProfile | null {
  if (context.agentName) validName(context.agentName);
  let selection = context.selection;
  if (selection === undefined && context.agentName) selection = loadConfig(context.agentName).browser_profile_id;
  if (selection === null) return null;
  if (selection !== undefined) return requireAllowed(getBrowserProfile(selection), context);
  const agent = context.agentName ? scopedProfile(context.ownerUserId, 'agent', context.agentName) : null;
  if (agent) return requireAllowed(agent, context);
  const kind = context.project ? 'project' : 'general';
  const ref = context.project || null;
  const inherited = scopedProfile(context.ownerUserId, kind, ref) ?? createBrowserProfile({
    name: context.project ? `Project ${context.project}` : 'General',
    owner_user_id: context.ownerUserId,
    scope_kind: kind,
    scope_ref: ref,
  });
  return requireAllowed(inherited, context);
}

/** A persisted assignment retains its original project scope across turns,
 * even if the agent's cwd/project changes. Owner and grants are still checked. */
export function resolveMissionBrowserProfile(
  mission: Pick<MissionRow, 'owner_user_id' | 'agent_name' | 'browser_profile_id' | 'browser_profile_resolved'>,
  context: { project?: string | null; workflowSlug?: string } = {},
): BrowserProfile | null {
  const fixed = mission.browser_profile_resolved && mission.browser_profile_id ? getBrowserProfile(mission.browser_profile_id) : null;
  return resolveBrowserProfile({
    ownerUserId: mission.owner_user_id, agentName: mission.agent_name,
    project: fixed?.scope_kind === 'project' ? fixed.scope_ref : context.project,
    workflowSlug: context.workflowSlug,
    selection: mission.browser_profile_resolved ? mission.browser_profile_id : undefined,
  });
}

/**
 * The reference an agent's own profile carries while the agent is in the
 * trash (TODO #668): `trash:<entry id>`. An agent name never holds `:`, so no
 * agent — least of all one recreated under the deleted name — resolves to it.
 */
export const TRASHED_AGENT_PROFILE_PREFIX = 'trash:';

/**
 * Takes `agent` out of every profile's `agent_names` allowlist. The key stays,
 * even emptied: an empty list admits nobody, while a missing one would open the
 * profile to its whole scope. Returns how many profiles changed.
 */
export function revokeAgentBrowserGrants(agent: string): number {
  return rewriteAgentNameGrants((name) => name !== agent);
}

/** Same, for every name `keep` refuses. */
export function rewriteAgentNameGrants(keep: (name: string) => boolean): number {
  const rows = db.prepare(`SELECT id, grants FROM browser_profiles WHERE grants LIKE '%"agent_names"%'`).all() as Array<{ id: string; grants: string }>;
  const update = db.prepare('UPDATE browser_profiles SET grants = ?, updated_at = ? WHERE id = ?');
  let changed = 0;
  for (const row of rows) {
    let grants: { agent_names?: unknown } & Record<string, unknown>;
    try { grants = JSON.parse(row.grants) as typeof grants; } catch { continue; }
    const names = grants.agent_names;
    if (!Array.isArray(names)) continue;
    const next = names.filter((n: unknown) => typeof n !== 'string' || keep(n));
    if (next.length === names.length) continue;
    update.run(JSON.stringify({ ...grants, agent_names: next }), Date.now(), row.id);
    changed++;
  }
  return changed;
}

/** Parks the agent's own profiles under its trash entry. Returns how many. */
export function holdAgentBrowserProfiles(agent: string, trashId: string): number {
  return db.prepare(`UPDATE browser_profiles SET scope_ref = ?, updated_at = ? WHERE scope_kind = 'agent' AND scope_ref = ?`)
    .run(`${TRASHED_AGENT_PROFILE_PREFIX}${trashId}`, Date.now(), agent).changes;
}

/**
 * Gives a restored agent its parked profiles back. One that a profile created
 * since for the same owner and name blocks is deleted — its trash entry is
 * gone with the restore, nothing could reach it again — and named in the result.
 */
export function restoreAgentBrowserProfiles(agent: string, trashId: string): { restored: number; dropped: string[] } {
  const parked = `${TRASHED_AGENT_PROFILE_PREFIX}${trashId}`;
  const restored = db.prepare(`UPDATE OR IGNORE browser_profiles SET scope_ref = ?, updated_at = ? WHERE scope_kind = 'agent' AND scope_ref = ?`)
    .run(agent, Date.now(), parked).changes;
  const stranded = db.prepare(`SELECT id, name FROM browser_profiles WHERE scope_kind = 'agent' AND scope_ref = ?`).all(parked) as Array<{ id: string; name: string }>;
  dropProfiles(stranded);
  return { restored, dropped: stranded.map((r) => r.name) };
}

/** Deletes for good the profiles of a deleted agent that nothing will restore. */
export function dropAgentBrowserProfiles(agent: string): number {
  return dropProfiles(db.prepare(`SELECT id FROM browser_profiles WHERE scope_kind = 'agent' AND scope_ref = ?`).all(agent) as Array<{ id: string }>);
}

/** Same, for the profiles parked under a trash entry that is gone. */
export function dropTrashedAgentBrowserProfiles(trashId: string): number {
  return dropProfiles(db.prepare(`SELECT id FROM browser_profiles WHERE scope_kind = 'agent' AND scope_ref = ?`)
    .all(`${TRASHED_AGENT_PROFILE_PREFIX}${trashId}`) as Array<{ id: string }>);
}

/** The trash entry ids agent profiles are parked under. */
export function listParkedAgentBrowserProfileEntries(): string[] {
  return (db.prepare(`SELECT DISTINCT scope_ref FROM browser_profiles WHERE scope_kind = 'agent' AND scope_ref LIKE ?`)
    .all(`${TRASHED_AGENT_PROFILE_PREFIX}%`) as Array<{ scope_ref: string }>)
    .map((r) => r.scope_ref.slice(TRASHED_AGENT_PROFILE_PREFIX.length));
}

/** The names agent-scope profiles are attached to, parked ones excluded. */
export function listAgentBrowserProfileOwners(): string[] {
  return (db.prepare(`SELECT DISTINCT scope_ref FROM browser_profiles WHERE scope_kind = 'agent' AND scope_ref IS NOT NULL AND scope_ref NOT LIKE ?`)
    .all(`${TRASHED_AGENT_PROFILE_PREFIX}%`) as Array<{ scope_ref: string }>)
    .map((r) => r.scope_ref);
}

/**
 * The row goes, then the engine storage the desktop keeps under the same home
 * (cookies, signed-in sessions): left behind, it would outlive the only thing
 * that could ever reach it. Best effort — a desktop on another machine keeps its
 * own copy, and a file still open (Windows) leaves the folder behind, logged.
 */
function dropProfiles(rows: ReadonlyArray<{ id: string }>): number {
  const remove = db.prepare('DELETE FROM browser_profiles WHERE id = ?');
  let dropped = 0;
  for (const { id } of rows) {
    dropped += remove.run(id).changes;
    if (!isBrowserProfileId(id)) continue;
    try { rmSync(browserProfileDir(id), { recursive: true, force: true }); }
    catch (err) { console.warn(`[browser-profiles] storage of ${id} not removed: ${(err as Error).message}`); }
  }
  return dropped;
}
