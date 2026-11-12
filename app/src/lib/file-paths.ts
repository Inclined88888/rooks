/** Path helpers of the Files widget. Paths are relative to the agent's folder, '' is its root. */

/** Where a new entry goes: `name` typed under `dir`. */
export function inDir(dir: string, name: string): string {
  const n = name.trim();
  return dir ? dir + '/' + n : n;
}

/** The folder holding `rel` ('' for a root entry). */
export function parentDir(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

/** Whether dragging `from` onto the folder `toDir` can do anything: not where it already is, not into itself. */
export function canDrop(from: string, toDir: string): boolean {
  if (!from || parentDir(from) === toDir) return false;
  return toDir !== from && !toDir.startsWith(from + '/');
}

/** How much of `name` the rename field preselects: a file's stem, so typing keeps its extension; a dotfile or a folder whole. */
export function stemLength(name: string, kind: string): number {
  if (kind === 'dir') return name.length;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? dot : name.length;
}
