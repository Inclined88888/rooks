/**
 * Folder browser served by the daemon (TIM-0136): the folders of the machine
 * Rooks runs on, one level at a time.
 *
 * A path a setting, a project or an agent stores is read by THIS daemon. A
 * window driving another machine (the machine switcher), or a plain browser,
 * cannot use the OS dialog of the computer it sits on: it would hand back a
 * path of the wrong disk. So the interface asks the daemon that will use the
 * path what its disk holds.
 *
 * Every path is built here, with this machine's `node:path`: the client never
 * joins two segments, so a Linux window browses a Windows daemon correctly.
 *
 * Folders only by default. A listing of the disk is no public read: a
 * signed-in caller who may store a folder somewhere (settings, projects,
 * agents), never anonymous, never an agent mission.
 *
 * File mode (`files`, TODO #791): the same levels with the files they hold,
 * for the pickers whose value is a file the daemon reads (a plugin archive, a
 * CLI binary). Names only, never a file's content. File names say more than
 * folder names (`~/.ssh/id_ed25519`, `~/.aws/credentials`), and both gestures
 * that need them are reserved to a superadmin anyway: file mode is too.
 */
import type { Request, Response, Router } from 'express';
import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { z } from 'zod';
import { forbidden, requireAuth, rejectUnlessAny } from '../../users/identity.js';

/** A home folder rarely holds more; past it the list says it was cut. */
export const DIRECTORY_LIST_MAX = 1000;

/** The rights of the gestures that store a folder path the daemon then reads. */
export const DIRECTORY_BROWSE_PERMISSIONS = ['settings:write', 'projects:manage', 'agents:manage'] as const;

/**
 * `files`: `*` for every file, or the endings a file must have, comma
 * separated (`.tgz,.tar.gz,.zip`). An ending is dots and letters or digits
 * only: no separator, no `..`, nothing a path could be made of.
 */
export const FILES_FILTER_RE = /^(?:\*|\.[A-Za-z0-9]{1,16}(?:\.[A-Za-z0-9]{1,16})?(?:,\.[A-Za-z0-9]{1,16}(?:\.[A-Za-z0-9]{1,16})?){0,15})$/;

const Query = z.object({
  path: z.string().max(4096).optional(),
  files: z.string().max(512).regex(FILES_FILTER_RE).optional(),
}).strict();

/** Which files a file-mode listing shows: every one, or those with one of these endings (lower case). */
export type FileFilter = { endings: readonly string[] | null };

export function parseFileFilter(raw: string): FileFilter {
  if (raw === '*') return { endings: null };
  return { endings: raw.split(',').map((ending) => ending.toLowerCase()) };
}

function fileMatches(name: string, filter: FileFilter): boolean {
  if (!filter.endings) return true;
  // Lower case on both sides: `SETUP.EXE` and `setup.exe` are one file on Windows.
  const lower = name.toLowerCase();
  return filter.endings.some((ending) => lower.endsWith(ending) && lower.length > ending.length);
}

export interface DirectoryEntry {
  name: string;
  path: string;
  /** A dot-folder: the interface folds them away by default. */
  hidden: boolean;
}

export interface DirectoryListing {
  path: string;
  /** `null` at the root of a drive or of the filesystem. */
  parent: string | null;
  entries: DirectoryEntry[];
  truncated: boolean;
  /** Where the browser can jump to: the user's home, then the drives (Windows) or `/`. */
  home: string;
  roots: string[];
  /** File mode only: the files of this level that pass the filter, cut like the folders. */
  files?: DirectoryEntry[];
  /** File mode only: the file the request named, when it named one — this level is its folder. */
  selected?: string;
}

export type DirectoryListError = 'relative_path' | 'not_found' | 'not_a_directory' | 'unreadable';

/** Drive letters that answer on Windows; the one root elsewhere. */
export function filesystemRoots(platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): string[] {
  if (platform !== 'win32') return [parse(homedir()).root || '/'];
  const roots: string[] = [];
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    try { if (exists(root)) roots.push(root); } catch { /* A drive that does not answer is no root. */ }
  }
  return roots;
}

/** A mapped network drive that is gone can make each probe wait for the SMB
 *  timeout: the drives are probed once per window, not at every level. */
const ROOTS_TTL_MS = 30_000;
let rootsCache: { at: number; roots: string[] } | null = null;

function cachedRoots(): string[] {
  const now = Date.now();
  if (!rootsCache || now - rootsCache.at > ROOTS_TTL_MS) rootsCache = { at: now, roots: filesystemRoots() };
  return rootsCache.roots;
}

function isDirectory(full: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  // A link to a folder is a folder to the user; a dangling one is not.
  try { return statSync(full).isDirectory(); } catch { return false; }
}

function isFile(full: string, entry: Dirent): boolean {
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  // `/usr/bin/claude` is often a link: a file to the user, unless it dangles.
  try { return statSync(full).isFile(); } catch { return false; }
}

const byName = (a: DirectoryEntry, b: DirectoryEntry): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });

/**
 * The folders in `requested` (the home when absent), or why there are none.
 * With `files`, the files of the level too; a `requested` naming a file then
 * opens its folder with that file as `selected` when it passes the filter,
 * so a pin such as `/usr/local/bin/claude` reopens where it was rather than
 * on the home.
 */
export function listDirectories(
  requested: string | undefined,
  files?: FileFilter,
): { ok: true; listing: DirectoryListing } | { ok: false; error: DirectoryListError } {
  const home = homedir();
  const raw = requested?.trim() ? requested.trim() : home;
  if (!isAbsolute(raw)) return { ok: false, error: 'relative_path' };
  let path = resolve(raw);
  let stats;
  try { stats = statSync(path); } catch (err) {
    return { ok: false, error: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'unreadable' };
  }
  let selected: string | undefined;
  if (!stats.isDirectory()) {
    if (!files || !stats.isFile()) return { ok: false, error: 'not_a_directory' };
    // Out of the filter, the file opens its folder unselected: a selection
    // the listing does not hold would let a pin bypass the filter.
    if (fileMatches(basename(path), files)) selected = path;
    path = dirname(path);
  }
  let dirents: Dirent[];
  try { dirents = readdirSync(path, { withFileTypes: true }); } catch { return { ok: false, error: 'unreadable' }; }
  const entry = (name: string): DirectoryEntry => ({ name, path: join(path, name), hidden: name.startsWith('.') });
  const folders = dirents
    .filter((dirent) => isDirectory(join(path, dirent.name), dirent))
    .map((dirent) => entry(dirent.name))
    .sort(byName);
  const parent = dirname(path);
  const listing: DirectoryListing = {
    path,
    parent: parent === path ? null : parent,
    entries: folders.slice(0, DIRECTORY_LIST_MAX),
    truncated: folders.length > DIRECTORY_LIST_MAX,
    home,
    roots: cachedRoots(),
  };
  if (files) {
    const found = dirents
      .filter((dirent) => fileMatches(dirent.name, files) && isFile(join(path, dirent.name), dirent))
      .map((dirent) => entry(dirent.name))
      .sort(byName);
    listing.files = found.slice(0, DIRECTORY_LIST_MAX);
    listing.truncated ||= found.length > DIRECTORY_LIST_MAX;
    if (selected !== undefined) listing.selected = selected;
  }
  return { ok: true, listing };
}

const STATUS: Record<DirectoryListError, number> = {
  relative_path: 400,
  not_a_directory: 400,
  not_found: 404,
  unreadable: 403,
};

export function registerDirectoryRoutes(app: Router): void {
  app.get('/api/host/directories', (req: Request, res: Response) => {
    // `requireAuth` first: `rejectUnlessAny` lets an anonymous caller through
    // while no account exists yet, and a disk listing is never that open.
    const auth = requireAuth(req, res);
    if (!auth) return;
    if (auth.kind === 'api-token' && auth.missionId) {
      forbidden(req, res, {
        kind: 'scope',
        reason: 'the folder browser is a gesture of the interface, not of an agent mission',
        hint: 'An agent lists folders with its own shell, inside its working directory.',
      });
      return;
    }
    if (rejectUnlessAny(req, res, DIRECTORY_BROWSE_PERMISSIONS)) return;
    // Before the query is read: a refused caller learns nothing of its filter.
    if (req.query.files !== undefined && !auth.isSuperadmin) {
      forbidden(req, res, { kind: 'operator' });
      return;
    }
    const query = Query.safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: 'invalid_query' }); return; }
    const filter = query.data.files === undefined ? undefined : parseFileFilter(query.data.files);
    const out = listDirectories(query.data.path, filter);
    if (!out.ok) { res.status(STATUS[out.error]).json({ error: out.error }); return; }
    res.setHeader('cache-control', 'private, no-store');
    res.json(out.listing);
  });
}
