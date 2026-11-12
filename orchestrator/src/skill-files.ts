/**
 * The files a skill folder holds next to its `SKILL.md` (`references/…`,
 * scripts, templates): an imported skill often cites them from its body. A
 * local agent opens them on Rooks's disk; an agent that cannot reach that disk
 * reads them through `skill_get` (id + file), or, with no Rooks MCP either,
 * receives the text ones pasted under a budget (`remoteSkillFiles`).
 *
 * Paths are relative to the skill folder and always written with `/`: they are
 * shown to an agent and sent in a URL, and must read the same on every OS.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { skillDir } from './paths.js';

export type SkillFile = { path: string; size: number };

/** Bounds of a listing: the import copies at most 200 files (`importSkill`). */
export const SKILL_FILES_MAX = 200;
const MAX_DEPTH = 8;
/** One file read through `skill_get`: a reference, not a dataset. */
export const SKILL_FILE_MAX_BYTES = 256 * 1024;
/** Neighbour text pasted per skill for a backend that can read nothing on demand. */
export const REMOTE_SKILL_FILES_BUDGET = 64 * 1024;
/** The same across all the skills of one prompt: they add up, and the prompt is re-sent at every turn. */
export const REMOTE_SKILL_FILES_PROMPT_BUDGET = 128 * 1024;

const ID_RE = /^[a-z0-9._-]+$/;

function validSkillId(id: string): boolean {
  return ID_RE.test(id) && id !== '.' && id !== '..';
}
/** A dot entry is configuration (`.env`, `.git`), never a reference a body cites. */
function hidden(name: string): boolean {
  return name.startsWith('.');
}

/**
 * Regular files under the skill folder, `SKILL.md` excepted, sorted by path.
 * Dot entries and links are skipped: a link could point anywhere on the disk,
 * and its target would then leave for a remote host. For what opens the disk or
 * says what it could not send; `listSkillFiles` is what can be asked for by name.
 */
export function skillFilesOnDisk(id: string): SkillFile[] {
  if (!validSkillId(id)) return [];
  const root = skillDir(id);
  const out: SkillFile[] = [];
  const walk = (dir: string, rel: string[], depth: number): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (out.length >= SKILL_FILES_MAX) return;
      if (hidden(entry.name) || entry.isSymbolicLink()) continue;
      const parts = [...rel, entry.name];
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) walk(join(dir, entry.name), parts, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      // `skill.md` in any case IS the entry on a case-insensitive disk.
      if (rel.length === 0 && entry.name.toLowerCase() === 'skill.md') continue;
      let size = 0;
      try { size = lstatSync(join(dir, entry.name)).size; } catch { continue; }
      out.push({ path: parts.join('/'), size });
    }
  };
  walk(root, [], 0);
  return out;
}

/**
 * The files `readSkillFile` accepts the path of. A POSIX disk can hold a `:` or
 * a `\` in a name, and that guard refuses both because they lead out of the
 * folder on Windows: offering such a file would only earn the reader a 400.
 * Mirrors the guard rather than sharing it, so it can never loosen it;
 * `skill-files.test.ts` holds the two together, character by character.
 */
export function listSkillFiles(id: string): SkillFile[] {
  return skillFilesOnDisk(id).filter((f) => f.path.length <= 512 && !/[\\:]/.test(f.path));
}

/** Why a neighbour file is not served; `status` is the HTTP answer. */
export class SkillFileError extends Error {
  constructor(readonly status: 400 | 404 | 413 | 415, message: string) {
    super(message);
    this.name = 'SkillFileError';
  }
}

/** UTF-8 without a NUL byte: what can be read as text by a model. */
export function decodeText(buf: Buffer): string | null {
  if (buf.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/**
 * The text of one neighbour file. `rel` comes from the network: it must be a
 * relative `/` path of visible segments, and the file it names must be a
 * regular file whose real location is still inside the skill folder (a linked
 * folder on the way is refused, like a link at the end).
 */
export function readSkillFile(id: string, rel: string): { path: string; content: string } {
  if (!validSkillId(id)) throw new SkillFileError(400, 'invalid skill id');
  const parts = rel.split('/');
  const badSegment = (p: string) => p === '' || hidden(p) || /[\\:\0]/.test(p);
  if (rel.length === 0 || rel.length > 512 || parts.some(badSegment)) {
    throw new SkillFileError(400, 'invalid file path: a relative path inside the skill folder, `/` separated, no dot entry');
  }
  if (parts.length === 1 && parts[0]!.toLowerCase() === 'skill.md') {
    throw new SkillFileError(400, 'SKILL.md is read without `file`');
  }
  const root = skillDir(id);
  const file = join(root, ...parts);
  let st;
  try { st = lstatSync(file); } catch { throw new SkillFileError(404, 'file not found in this skill'); }
  if (!st.isFile()) throw new SkillFileError(404, 'file not found in this skill');
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = realpathSync(root);
    realFile = realpathSync(file);
  } catch {
    throw new SkillFileError(404, 'file not found in this skill');
  }
  if (!realFile.startsWith(realRoot + sep)) throw new SkillFileError(404, 'file not found in this skill');
  if (st.size > SKILL_FILE_MAX_BYTES) {
    throw new SkillFileError(413, `file over ${SKILL_FILE_MAX_BYTES / 1024} KB: open it on the host`);
  }
  const content = decodeText(readFileSync(realFile));
  if (content === null) throw new SkillFileError(415, 'not a text file');
  return { path: parts.join('/'), content };
}

export type RemoteSkillFiles = {
  pasted: { path: string; content: string }[];
  /** Not sent, and why: not text, past the budget, or refused or unreadable on disk. */
  left_out: { path: string; reason: 'binary' | 'budget' | 'unreadable' }[];
};

/**
 * What a backend with neither Rooks's MCP nor its disk receives of the
 * neighbour files: whole text files, in path order, while they fit the budget.
 * A file is never cut: half a reference would read as the whole of it. What is
 * left out is named, so the agent knows the body cites something it lacks.
 */
export function remoteSkillFiles(id: string, budget = REMOTE_SKILL_FILES_BUDGET): RemoteSkillFiles {
  const pasted: RemoteSkillFiles['pasted'] = [];
  const left_out: RemoteSkillFiles['left_out'] = [];
  let used = 0;
  for (const f of skillFilesOnDisk(id)) {
    // Decided on the size alone: a file that cannot fit is not read.
    if (f.size > budget - used) {
      left_out.push({ path: f.path, reason: 'budget' });
      continue;
    }
    let text: string;
    try {
      text = readSkillFile(id, f.path).content;
    } catch (err) {
      left_out.push({ path: f.path, reason: err instanceof SkillFileError && err.status === 415 ? 'binary' : 'unreadable' });
      continue;
    }
    pasted.push({ path: f.path, content: text });
    used += f.size;
  }
  return { pasted, left_out };
}
