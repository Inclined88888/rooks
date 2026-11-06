/**
 * Agents deleted before TODO #668 left their access behind: the secret grants
 * and the browser profile allowlists naming them, and their own browser
 * profiles, all matched by name — so an agent recreated under that name got
 * them without anyone giving them. `deleteAgent` now revokes them; this sweep
 * settles what earlier deletions left, at every boot (idempotent).
 *
 * A grant naming no agent on disk is revoked, whatever the reason: a deleted
 * agent, a trashed one (a restore does not bring grants back), or a name typed
 * before the agent existed — the very hole this closes. Plugin addresses
 * (`plugin:<id>`) are not agent names and are left alone. An own profile goes
 * to its agent's newest trash entry when there is one, is deleted otherwise;
 * one parked under an entry that is gone (purged by hand on disk) is deleted.
 */
import { existsSync } from 'node:fs';
import { getAgentTrashEntry, listAgentTrash } from './agent-trash.js';
import {
  dropAgentBrowserProfiles, dropTrashedAgentBrowserProfiles, holdAgentBrowserProfiles,
  listAgentBrowserProfileOwners, listParkedAgentBrowserProfileEntries, rewriteAgentNameGrants,
} from './browser-profiles.js';
import { validName } from './agent-config.js';
import { dbApi } from './db.js';
import { AGENTS_DIR, agentDir } from './paths.js';

export type DeletedAgentGrantsSweep = { secretGrants: number; allowlists: number; parked: number; dropped: number };

function isAgentName(name: string): boolean {
  try { validName(name); return true; } catch { return false; }
}

export function sweepDeletedAgentGrants(): DeletedAgentGrantsSweep {
  const out: DeletedAgentGrantsSweep = { secretGrants: 0, allowlists: 0, parked: 0, dropped: 0 };
  // No agents folder means a home not set up yet, or not mounted: every grant
  // would look orphaned, and none is.
  if (!existsSync(AGENTS_DIR)) return out;
  const gone = (name: string) => isAgentName(name) && !existsSync(agentDir(name));
  for (const ref of dbApi.listSecretGrantAgents()) {
    if (gone(ref)) out.secretGrants += dbApi.deleteSecretGrantsForAgent(ref);
  }
  out.allowlists = rewriteAgentNameGrants((name) => !gone(name));
  const newest = new Map<string, string>();
  for (const entry of listAgentTrash()) if (!newest.has(entry.name)) newest.set(entry.name, entry.id);
  for (const ref of listAgentBrowserProfileOwners()) {
    if (!gone(ref)) continue;
    const trashId = newest.get(ref);
    if (trashId) out.parked += holdAgentBrowserProfiles(ref, trashId);
    else out.dropped += dropAgentBrowserProfiles(ref);
  }
  for (const trashId of listParkedAgentBrowserProfileEntries()) {
    if (!getAgentTrashEntry(trashId)) out.dropped += dropTrashedAgentBrowserProfiles(trashId);
  }
  if (out.secretGrants || out.allowlists || out.parked || out.dropped) {
    console.log(`[agent-grants] deleted agents: ${out.secretGrants} secret grant(s) and ${out.allowlists} browser allowlist(s) revoked, ${out.parked} browser profile(s) parked in the trash, ${out.dropped} deleted`);
  }
  return out;
}
