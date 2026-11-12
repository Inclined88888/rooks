/**
 * Reading an agent setup from a folder on the daemon's own disk.
 *
 * The root is ALWAYS one the daemon chose (a detected `~/.hermes`,
 * `%LOCALAPPDATA%\hermes`…), never a path sent by a browser: the route layer
 * owns that guarantee, this module only reads. The root itself is resolved
 * like any path the daemon picked (a dotfiles manager may link `~/.hermes`);
 * below it, nothing is followed: every entry is `lstat`ed, a symbolic link or
 * a Windows junction is reported and left alone, so is a file with more than
 * one hard link, and a file is reopened without following links and checked
 * to be the one that was listed.
 */
import { constants } from 'node:fs';
import { lstat, open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveLimits, type ReaderLimits } from './limits.js';
import {
  compileWants, globMatches, globMayMatchBelow, isDeniedSegment, isNestedArchive, isUnportableSegment,
  planSelection, ReaderError, type Candidate, type SkippedEntry, type SourceTree,
} from './policy.js';

export type DirReadOptions = { limits?: Partial<ReaderLimits> };

type FileRef = { abs: string; dev: number; ino: number };

// Absent on Windows, where `lstat` + the identity check below carry the guarantee.
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

async function readExactly(ref: FileRef, size: number, path: string): Promise<Uint8Array> {
  let handle;
  try {
    handle = await open(ref.abs, constants.O_RDONLY | NO_FOLLOW);
  } catch {
    throw new ReaderError('changed', `${path} could not be reopened (it changed while the source was read)`);
  }
  try {
    const st = await handle.stat();
    // An inode of 0 means the platform does not report one: only the type and size are compared.
    const sameFile = st.isFile() && st.size === size && st.nlink <= 1
      && (ref.ino === 0 || (st.ino === ref.ino && st.dev === ref.dev));
    if (!sameFile) throw new ReaderError('changed', `${path} changed while the source was read`);
    const bytes = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
      if (bytesRead === 0) throw new ReaderError('changed', `${path} shrank while the source was read`);
      offset += bytesRead;
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

/**
 * Walks `root`, keeps the regular files that pass the deny list THEN one of
 * the `wants` globs, and returns them as relative POSIX path → bytes.
 */
export async function readDirSource(
  root: string,
  wants: readonly string[],
  options: DirReadOptions = {},
): Promise<SourceTree> {
  const limits = resolveLimits(options.limits);
  const globs = compileWants(wants);

  let rootStat;
  try {
    rootStat = await stat(root);
  } catch {
    throw new ReaderError('not-a-directory', 'the source folder does not exist');
  }
  if (!rootStat.isDirectory()) throw new ReaderError('not-a-directory', 'the source is not a folder');

  const skipped: SkippedEntry[] = [];
  const candidates: Candidate<FileRef>[] = [];
  let visited = 0;

  // `raw` keeps the names as the disk spells them (for fs calls), `segments`
  // their NFC form (for matching and for the tree).
  const stack: { raw: string[]; segments: string[] }[] = [{ raw: [], segments: [] }];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    let names: string[];
    try {
      names = await readdir(join(root, ...dir.raw));
    } catch {
      // An unreadable folder (permissions) is left out rather than failing the whole source.
      continue;
    }
    names.sort();
    for (const name of names) {
      if (++visited > limits.maxVisited) {
        throw new ReaderError('too-many-files', `the source folder holds more than ${limits.maxVisited} entries`);
      }
      const raw = [...dir.raw, name];
      const segments = [...dir.segments, name.normalize('NFC')];
      const path = segments.join('/');
      if (isDeniedSegment(name)) {
        skipped.push({ path, reason: 'blocked' });
        continue;
      }
      let st;
      try {
        st = await lstat(join(root, ...raw));
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        skipped.push({ path, reason: 'link' });
        continue;
      }
      if (st.isDirectory()) {
        if (!globs.some((g) => globMayMatchBelow(g, segments))) continue;
        if (segments.length >= limits.maxDepth) {
          throw new ReaderError('too-deep', `the source folder is nested deeper than ${limits.maxDepth} levels`);
        }
        stack.push({ raw, segments });
        continue;
      }
      if (!globs.some((g) => globMatches(g, segments))) continue;
      if (!st.isFile()) {
        skipped.push({ path, reason: 'special' });
        continue;
      }
      // A second name for a file outside the root (`ln ~/.ssh/key skills/x/notes.md`)
      // passes every check above; a source of text files has no use for one.
      if (st.nlink > 1) {
        skipped.push({ path, reason: 'hard-link' });
        continue;
      }
      if (isNestedArchive(name)) {
        skipped.push({ path, reason: 'nested-archive' });
        continue;
      }
      if (segments.some(isUnportableSegment)) {
        skipped.push({ path, reason: 'unportable-name' });
        continue;
      }
      candidates.push({ path, size: st.size, ref: { abs: join(root, ...raw), dev: st.dev, ino: st.ino } });
    }
  }

  const plan = planSelection(candidates, limits);
  const files = new Map<string, Uint8Array>();
  let totalBytes = 0;
  for (const c of plan.keep) {
    files.set(c.path, await readExactly(c.ref, c.size, c.path));
    totalBytes += c.size;
  }
  skipped.push(...plan.skipped);
  skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, skipped, notices: [], totalBytes };
}
