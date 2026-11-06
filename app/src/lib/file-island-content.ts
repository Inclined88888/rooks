import type { IslandContent, IslandParams } from './island-tree';

/**
 * The file content type of the island workspace, named apart from its
 * component (`components/chat/file-island.tsx`): the viewer windows hand
 * their file over to the workspace, and the component paints their bodies.
 */
export const FILE_ISLAND_KEY = 'file';
export const FILE_ISLAND_TYPE = `@timon/files-widget:${FILE_ISLAND_KEY}`;

/** What a source hands the workspace for a file of `agentId`'s folder. */
export function fileIslandContent(agentId: string, path: string, { external = false, mode = 'preview' }: { external?: boolean; mode?: 'preview' | 'edit' } = {}): IslandContent {
  return { type: FILE_ISLAND_TYPE, params: { agentId, path, mode, external } };
}

/** Same shape as the daemon's agent name segment. */
const AGENT = /^[A-Za-z0-9._-]{1,128}$/;
/** Leaves room for the other params under the 1 KiB a tab may store. */
const MAX_PATH = 900;

/**
 * `{ agentId, path, mode, external }`. A path inside the folder is relative and
 * never climbs out of it; an external one is absolute, a file the user agreed
 * to open. The daemon checks both again, and the session's rights with them.
 */
export function parseFileIslandParams(raw: unknown): IslandParams | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { agentId, path: rawPath, mode, external } = raw as Record<string, unknown>;
  if (typeof agentId !== 'string' || !AGENT.test(agentId) || agentId === '.' || agentId === '..') return null;
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > MAX_PATH || rawPath.includes('\0')) return null;
  const outside = external === true;
  const path = normalizeFilePath(rawPath, outside);
  if (!outside && path.split('/').includes('..')) return null;
  return { agentId, path, mode: mode === 'edit' ? 'edit' : 'preview', external: outside };
}

/**
 * One spelling per file, whatever OS named it. A Windows daemon answers
 * `docs\a.md` where the tree says `docs/a.md`: two tabs for one file, and a
 * rename in the tree that misses one of them. A path of the folder takes `/`
 * (the `..` guard has always read `\` as a separator there); an external one
 * only when it is a Windows drive path, which the daemon reads either way: a
 * `\` in a Linux or macOS file name is a character, not a separator.
 */
export function normalizeFilePath(path: string, external: boolean): string {
  if (external && !/^[\\/]?[A-Za-z]:[\\/]/.test(path)) return path;
  return path.replace(/\\/g, '/');
}
