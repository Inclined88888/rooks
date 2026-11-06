import { cpSync, lstatSync, readlinkSync, statSync, symlinkSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export type SymlinkFn = (target: string, path: string, type?: 'dir' | 'file' | 'junction') => void;

/**
 * Recreates the link `source` at `dest`, pointing where it pointed. Windows
 * refuses a directory symlink without Developer Mode (EPERM), yet npm installs
 * a local plugin as a directory JUNCTION, which needs no privilege: the backup
 * of such a plugin failed on every update (TIM-0028). A junction takes an
 * absolute target, which is what a junction already reads back as. The type is
 * ignored outside Windows, where the first attempt succeeds anyway.
 * Exported for the test, with an injectable `symlink`.
 */
export function copyLink(source: string, dest: string, symlink: SymlinkFn = symlinkSync): void {
  const target = readlinkSync(source);
  try {
    symlink(target, dest);
  } catch (error) {
    const absolute = isAbsolute(target) ? target : resolve(dirname(source), target);
    if ((error as NodeJS.ErrnoException).code !== 'EPERM'
      || !statSync(absolute, { throwIfNoEntry: false })?.isDirectory()) throw error;
    symlink(absolute, dest, 'junction');
  }
}

/** `cpSync` that keeps links as links, never following them (external content
 *  is not part of the backup), and survives Windows' symlink privilege.
 *  `filter` may throw to abort, or return `false` to leave an entry out.
 *  Shared with `timon export` / `import` (SUG-0063). */
export function copyTree(from: string, to: string, filter?: (source: string) => boolean | void, symlink?: SymlinkFn): void {
  const links: Array<[string, string]> = [];
  cpSync(from, to, {
    recursive: true,
    filter: (source, destination) => {
      if (filter?.(source) === false) return false;
      if (!lstatSync(source).isSymbolicLink()) return true;
      links.push([source, destination]);
      return false;
    },
  });
  for (const [source, destination] of links) copyLink(source, destination, symlink);
}
