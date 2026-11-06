/**
 * The Files widget's image gallery: the other pictures of the folder a picture
 * was opened from, in the order the folder is listed. Pure, so the order and the
 * stops are pinned without mounting anything.
 */
import { previewKindFor } from './kind';

type Listed = { name: string; kind: string };

/** Paths of the previewable images among `entries`, the listing of `dir` ('' = root), in listing order. */
export function imagePathsIn(dir: string, entries: readonly Listed[] | undefined): string[] {
  const out: string[] = [];
  for (const e of entries ?? []) {
    if (e.kind === 'dir' || previewKindFor(e.name) !== 'image') continue;
    out.push(dir ? dir + '/' + e.name : e.name);
  }
  return out;
}

/** The picture `delta` steps from `current`, or null at either end (no wrap-around) or when `current` is not in the list. */
export function neighbourImage(paths: readonly string[], current: string, delta: -1 | 1): string | null {
  const i = paths.indexOf(current);
  if (i < 0) return null;
  return paths[i + delta] ?? null;
}

/** "3 / 12" position of `current` in `paths`, or null when it is alone or absent (nothing to browse). */
export function galleryPosition(paths: readonly string[], current: string): { index: number; total: number } | null {
  const i = paths.indexOf(current);
  return i < 0 || paths.length < 2 ? null : { index: i + 1, total: paths.length };
}
