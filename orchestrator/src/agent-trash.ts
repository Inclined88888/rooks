/**
 * Trash of deleted agents (TODO #476).
 *
 * On 26/10/2026 an agent was deleted by mistake with the nightly backup off:
 * `rmSync` on its folder left nothing to recover. A deletion now MOVES the
 * folder — config, system prompt, identity docs, memory, everything under
 * `agents/<name>/` — to `trash/agents/<entry id>/agent/`, next to an
 * `entry.json` saying who it was and when it left. Restoring moves it back.
 *
 * What is NOT kept: the approval rules, the secret and browser profile grants
 * (TODO #668) and the pending inbox, which `deleteAgent` drops on purpose (an agent recreated under that name must not
 * inherit the old one's permissions). Its memory — agent-scope rules,
 * proposals, learnings — lives in the database keyed by name: it is parked
 * under the entry there (`agent-memory-trash.ts`, TODO #670), so an agent
 * recreated under the same name does not inherit it and a restore gets it back.
 *
 * The agent's own skill attachments (TODO #623) leave the table for
 * `entry.json` (`skills`): out of the table, an agent recreated under the same
 * name does not inherit them; in the entry, a restore puts them back and a
 * purge takes them with the folder. An entry written before that has no
 * `skills` field (`null` from `trashedAgentSkills`): `agent-skills-migration.ts`
 * settles it at boot.
 *
 * Pure filesystem: the bus events and the table stay with `agent.ts`, which
 * calls in here.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { AGENT_TRASH_DIR, agentDir } from './paths.js';
import { settingBool, settingInt } from './settings.js';
import { copyTree } from './tree-copy.js';
import type { HeldSkillAttachment } from './skill-attachments.js';

const DAY_MS = 86_400_000;
const ENTRY_FILE = 'entry.json';
const PAYLOAD_DIR = 'agent';
/** `<YYYYMMDD>-<HHMMSSmmm>-<agent name>`: sortable, one path segment, no `:` (Windows). */
const ENTRY_ID_RE = /^\d{8}-\d{9}-[A-Za-z0-9._-]+$/;

export type AgentTrashEntry = {
  id: string;
  /** The agent's name, the one a restore gives it back. */
  name: string;
  deleted_at: number;
  /** Who deleted it, as the route saw the caller; null when unknown. */
  deleted_by: string | null;
  /** When the automatic purge takes it; null when the trash keeps it until purged by hand. */
  expires_at: number | null;
};

/**
 * The hierarchy references other agents held on the deleted one, taken out of
 * their configs at deletion (a dangling `reports_to` makes their editor refuse
 * to save). Kept with the entry so a restore can put them back.
 */
export type AgentTrashRefs = { reports_to: string[]; orchestrates: string[] };

type StoredEntry = {
  name: string; deleted_at: number; deleted_by: string | null; refs?: AgentTrashRefs;
  /** Absent on an entry written before TODO #623. */
  skills?: HeldSkillAttachment[];
};

export function agentTrashEnabled(): boolean {
  return settingBool('ROOKS_AGENT_TRASH_ENABLED') !== false;
}

/** 0 = no automatic purge. Read at each use: Settings apply without a restart. */
export function agentTrashRetentionDays(): number {
  const days = settingInt('ROOKS_AGENT_TRASH_RETENTION_DAYS');
  return Number.isInteger(days) && days > 0 ? days : 0;
}

export function isAgentTrashId(id: string): boolean {
  return id.length <= 200 && ENTRY_ID_RE.test(id);
}

/** Entry folder, refusing anything that would resolve outside the trash. */
function entryDir(id: string): string | null {
  if (!isAgentTrashId(id)) return null;
  const dir = join(AGENT_TRASH_DIR, id);
  const rel = relative(AGENT_TRASH_DIR, dir);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return dir;
}

function entryId(name: string, at: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const day = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}`;
  const time = `${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}${p(at.getMilliseconds(), 3)}`;
  return `${day}-${time}-${name}`;
}

/**
 * `rename` when it can (same volume, instant), copy-then-remove when it
 * cannot: across volumes (EXDEV), or on Windows when a handle inside the
 * folder makes the rename fail (EPERM/EBUSY) while a copy still reads it.
 */
function moveDir(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err;
    copyTree(from, to);
    rmSync(from, { recursive: true, force: true });
  }
}

function toEntry(id: string, stored: StoredEntry, retentionDays: number): AgentTrashEntry {
  return {
    id,
    name: stored.name,
    deleted_at: stored.deleted_at,
    deleted_by: stored.deleted_by,
    expires_at: retentionDays > 0 ? stored.deleted_at + retentionDays * DAY_MS : null,
  };
}

function names(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function heldSkills(value: unknown): HeldSkillAttachment[] {
  if (!Array.isArray(value)) return [];
  const out: HeldSkillAttachment[] = [];
  for (const v of value as unknown[]) {
    if (!v || typeof v !== 'object') continue;
    const { skill, mode, exclude } = v as Record<string, unknown>;
    if (typeof skill !== 'string') continue;
    out.push({
      skill,
      mode: mode === 'import' ? 'import' : 'include',
      exclude: exclude === true,
    });
  }
  return out;
}

function readStored(dir: string): StoredEntry | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, ENTRY_FILE), 'utf8')) as Partial<StoredEntry>;
    if (typeof raw.name !== 'string' || typeof raw.deleted_at !== 'number') return null;
    const refs = raw.refs && typeof raw.refs === 'object'
      ? { reports_to: names(raw.refs.reports_to), orchestrates: names(raw.refs.orchestrates) }
      : undefined;
    return {
      name: raw.name, deleted_at: raw.deleted_at, deleted_by: typeof raw.deleted_by === 'string' ? raw.deleted_by : null,
      ...(refs ? { refs } : {}),
      ...(raw.skills !== undefined ? { skills: heldSkills(raw.skills) } : {}),
    };
  } catch {
    return null;
  }
}

/** Records the references removed from the other agents, once the deletion took them out. */
export function setTrashedAgentRefs(id: string, refs: AgentTrashRefs): void {
  const dir = entryDir(id);
  if (!dir) return;
  const stored = readStored(dir);
  if (!stored) return;
  writeFileSync(join(dir, ENTRY_FILE), JSON.stringify({ ...stored, refs }, null, 2) + '\n');
}

/**
 * The agent's skill attachments the entry holds; null for an entry written
 * before they were kept (its rows may still be in the table).
 */
export function trashedAgentSkills(id: string): HeldSkillAttachment[] | null {
  const dir = entryDir(id);
  return dir ? readStored(dir)?.skills ?? null : null;
}

/** Records the agent's skill attachments on an entry that had none recorded. */
export function setTrashedAgentSkills(id: string, skills: HeldSkillAttachment[]): void {
  const dir = entryDir(id);
  if (!dir) return;
  const stored = readStored(dir);
  if (!stored) return;
  writeFileSync(join(dir, ENTRY_FILE), JSON.stringify({ ...stored, skills }, null, 2) + '\n');
}

/**
 * Moves `agents/<name>/` to the trash. The caller checked that it exists, and
 * passes the agent's skill attachments, written with the marker: the caller
 * removes them from the table only once they are on disk.
 */
export function trashAgentDir(
  name: string,
  opts: { deletedBy?: string | null; now?: Date; skills?: HeldSkillAttachment[] } = {},
): AgentTrashEntry {
  const now = opts.now ?? new Date();
  const base = entryId(name, now);
  let id = base;
  // Two deletions of the same name in the same millisecond: never overwrite.
  for (let n = 1; existsSync(join(AGENT_TRASH_DIR, id)); n++) id = `${base}-${n}`;
  const dir = join(AGENT_TRASH_DIR, id);
  mkdirSync(dir, { recursive: true });
  const stored: StoredEntry = { name, deleted_at: now.getTime(), deleted_by: opts.deletedBy ?? null, skills: opts.skills ?? [] };
  // The marker first: a move interrupted halfway still leaves an entry that
  // names what it holds, instead of an anonymous folder.
  writeFileSync(join(dir, ENTRY_FILE), JSON.stringify(stored, null, 2) + '\n');
  moveDir(agentDir(name), join(dir, PAYLOAD_DIR));
  return toEntry(id, stored, agentTrashRetentionDays());
}

/** Newest first. Folders without a readable `entry.json` are skipped, not shown. */
export function listAgentTrash(): AgentTrashEntry[] {
  if (!existsSync(AGENT_TRASH_DIR)) return [];
  const days = agentTrashRetentionDays();
  const out: AgentTrashEntry[] = [];
  for (const id of readdirSync(AGENT_TRASH_DIR)) {
    const dir = entryDir(id);
    if (!dir) continue;
    const stored = readStored(dir);
    if (stored) out.push(toEntry(id, stored, days));
  }
  return out.sort((a, b) => b.deleted_at - a.deleted_at || (a.id < b.id ? 1 : -1));
}

export function getAgentTrashEntry(id: string): AgentTrashEntry | null {
  const dir = entryDir(id);
  if (!dir || !existsSync(dir)) return null;
  const stored = readStored(dir);
  return stored ? toEntry(id, stored, agentTrashRetentionDays()) : null;
}

/**
 * The `config.json` a restore would put back, read without restoring. `{}`
 * when the agent had none (a bare agent), null when the entry is gone or the
 * file cannot be parsed: the route judges what a caller may bring back before
 * anything moves, and an unreadable config proves nothing.
 */
export function readTrashedAgentConfig(id: string): Record<string, unknown> | null {
  const dir = entryDir(id);
  if (!dir || !existsSync(join(dir, PAYLOAD_DIR))) return null;
  const file = join(dir, PAYLOAD_DIR, 'config.json');
  if (!existsSync(file)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export type AgentTrashRestore =
  | { ok: true; entry: AgentTrashEntry; refs: AgentTrashRefs | null; skills: HeldSkillAttachment[] }
  | { ok: false; code: 'not_found' | 'conflict'; error: string };

/**
 * Puts the agent back under its own name. Refused while another agent holds
 * that name: the user renames or deletes it first, nothing is merged.
 */
export function restoreAgentDir(id: string): AgentTrashRestore {
  const entry = getAgentTrashEntry(id);
  const dir = entryDir(id);
  if (!entry || !dir || !existsSync(join(dir, PAYLOAD_DIR))) {
    return { ok: false, code: 'not_found', error: `no trashed agent ${id}` };
  }
  if (existsSync(agentDir(entry.name))) {
    return { ok: false, code: 'conflict', error: `an agent named ${entry.name} already exists: rename or delete it first` };
  }
  const stored = readStored(dir);
  moveDir(join(dir, PAYLOAD_DIR), agentDir(entry.name));
  rmSync(dir, { recursive: true, force: true });
  return { ok: true, entry, refs: stored?.refs ?? null, skills: stored?.skills ?? [] };
}

/** Deletes one entry for good. False when there was none. */
export function purgeAgentTrashEntry(id: string): boolean {
  const dir = entryDir(id);
  if (!dir || !existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** Purges the entries older than the retention. Returns their ids. */
export function purgeExpiredAgentTrash(now: number = Date.now()): string[] {
  if (agentTrashRetentionDays() === 0) return [];
  const purged: string[] = [];
  for (const entry of listAgentTrash()) {
    if (entry.expires_at === null || entry.expires_at > now) continue;
    try {
      if (purgeAgentTrashEntry(entry.id)) purged.push(entry.id);
    } catch (err) {
      console.warn(`[agent-trash] purge of ${entry.id} failed: ${(err as Error).message}`);
    }
  }
  return purged;
}
