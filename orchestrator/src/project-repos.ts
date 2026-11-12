/**
 * The git repositories of one project (TODO #923).
 *
 * A project folder can hold more than its own repository: a private notes
 * repository nested in a public one, which the outer repository ignores, is
 * invisible to every command run at the root. The Git widget lists them so
 * their branches and unpushed commits can be read too.
 *
 * A repository is named by its path relative to the project folder (`''` is
 * the root). That path comes from the network: it is checked twice, as text
 * (no absolute path, no `..`) and on disk (its realpath stays under the
 * project's, so a symbolic link cannot lead out).
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { getHost } from './host/index.js';
import { parseWorktreeLinks, WORKTREE_LINKS_FILE } from './worktree.js';

export type ProjectRepo = {
  /** Path relative to the project folder, `/`-separated; `''` is the root. */
  path: string;
  /** What the picker shows: the folder's name, the project's for the root. */
  name: string;
};

/** Thrown when a `repo` does not name a folder inside the project. */
export class RepoOutsideProjectError extends Error {
  constructor() { super('repo is not a folder inside the project'); }
}

/** Splits on both separators: a Windows client may send either. */
function segments(path: string): string[] {
  return path.split(/[\\/]+/);
}

/**
 * The text check of a `repo` parameter. The disk check (`resolveRepoCwd`) runs
 * after it: a path can be clean as text and still leave through a link.
 */
export const REPO_PATH = z.string().min(1).max(255).refine((p) => {
  if (p.includes('\0') || isAbsolute(p) || /^[A-Za-z]:/.test(p) || /^[\\/]/.test(p)) return false;
  return segments(p).every((s) => s !== '' && s !== '.' && s !== '..');
}, { message: 'invalid repo path' });

function isInside(root: string, path: string): boolean {
  if (path === root) return true;
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/**
 * The folder of `repo` inside the project folder `projectCwd`; the project
 * folder itself when `repo` is absent. Throws `RepoOutsideProjectError` when
 * the path is not a directory or resolves outside the project.
 */
export function resolveRepoCwd(projectCwd: string, repo?: string): string {
  if (repo === undefined || repo === '') return projectCwd;
  if (!REPO_PATH.safeParse(repo).success) throw new RepoOutsideProjectError();
  const candidate = join(projectCwd, ...segments(repo));
  try {
    const root = realpathSync(projectCwd);
    const real = realpathSync(candidate);
    if (!isInside(root, real) || real === root || !statSync(real).isDirectory()) throw new RepoOutsideProjectError();
  } catch (err) {
    if (err instanceof RepoOutsideProjectError) throw err;
    throw new RepoOutsideProjectError();
  }
  return candidate;
}

/** A `.git` folder, or the `.git` file of a worktree or submodule. */
function hasGit(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

/** Which of `names` the repository at `cwd` ignores; none on any failure. */
async function ignoredBy(cwd: string, names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  try {
    // Exit 1 means "none ignored"; any other failure reads as none too.
    const r = await getHost().execAsync('git', ['check-ignore', '--', ...names], { cwd, timeout: 5000 });
    if (r.code !== 0) return new Set();
    return new Set(r.stdout.split(/\r?\n/).map((l) => l.trim().replace(/[\\/]+$/, '')).filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * The repositories of a project: the root, then each folder of
 * `.worktreelinks` that holds a repository, then each first-level folder that
 * holds one and that the root ignores. A tracked subfolder with its own `.git`
 * (a submodule) is left out: the root already shows it.
 */
export async function discoverRepos(projectCwd: string): Promise<ProjectRepo[]> {
  const repos: ProjectRepo[] = [{ path: '', name: basename(projectCwd) }];
  const seen = new Set<string>(['']);
  const add = (rel: string): void => {
    const path = segments(rel).join('/');
    if (seen.has(path)) return;
    try { resolveRepoCwd(projectCwd, path); } catch { return; }
    seen.add(path);
    repos.push({ path, name: path });
  };

  let links: string[] = [];
  try { links = parseWorktreeLinks(readFileSync(join(projectCwd, WORKTREE_LINKS_FILE), 'utf8')); } catch { /* no file */ }
  for (const rel of links) if (hasGit(join(projectCwd, rel))) add(rel);

  let children: string[] = [];
  try {
    children = readdirSync(projectCwd, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== '.git' && hasGit(join(projectCwd, d.name)))
      .map((d) => d.name)
      .sort();
  } catch { /* unreadable folder: the root alone */ }
  const ignored = await ignoredBy(projectCwd, children);
  for (const name of children) if (ignored.has(name)) add(name);
  return repos;
}
