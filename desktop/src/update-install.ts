import { constants } from 'node:fs';
import { access, chmod, copyFile, link, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { sha256Of } from './update-download.js';

/**
 * The assisted installation of a verified update (docs/AUTO-UPDATE.md §5, §7
 * P3), without any certificate: the system's own installer does the work, and
 * the "Update Rooks from X to Y" screen of the next launch takes over.
 *
 *  - AppImage: the file the user launched is replaced by the verified one, in
 *    its own folder (one atomic rename), then the shell relaunches it. The
 *    previous file stays beside it until the new version has started.
 *  - `.deb`: root is required, so nothing is installed here: the package opens
 *    in the system's software manager, and the command to type is shown.
 *  - `.pkg` (macOS): Installer.app, which asks for the password itself.
 *  - NSIS (Windows): the installer window, visibly; the shell then quits so it
 *    does not hold `Rooks.exe` (the installer pauses the service itself).
 *
 * Every path needs the user's gesture; nothing here elevates anything.
 */

export type MissionCount = { live: number; working: number | null };

const countSchema = z.object({ live: z.number().int().min(0), working: z.number().int().min(0) });
const resourcesSchema = z.object({ liveMissions: z.number().int().min(0) });

export class DaemonAnswerError extends Error {
  constructor(readonly status: number) {
    super(`daemon answered ${status}`);
    this.name = 'DaemonAnswerError';
  }
}

export type DaemonGet = (path: string) => Promise<unknown>;

/**
 * How many missions an update would stop, asked to the daemon that runs them.
 * `GET /api/updates/missions` gives the missions inside a turn; a daemon older
 * than that route (the version being replaced) only knows its live missions
 * (`GET /api/health/resources`), counted then as working: better a needless
 * question than a silent stop. `null` when the daemon cannot tell — none is
 * running, or it refuses: then there is nothing it can lose either.
 */
export async function readMissionCount(get: DaemonGet): Promise<MissionCount | null> {
  try {
    const parsed = countSchema.safeParse(await get('/api/updates/missions'));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (!(error instanceof DaemonAnswerError) || error.status !== 404) return null;
  }
  try {
    const parsed = resourcesSchema.safeParse(await get('/api/health/resources'));
    return parsed.success ? { live: parsed.data.liveMissions, working: null } : null;
  } catch {
    return null;
  }
}

/** The number a person is told: the missions in a turn, or every live one when the daemon cannot tell them apart. */
export function missionsAtStake(count: MissionCount | null): number {
  if (!count) return 0;
  return count.working ?? count.live;
}

/** Where the replaced AppImage waits until the new one has started. Hidden, in the same folder. */
export function appImageBackupPath(appImage: string): string {
  return join(dirname(appImage), `.${basename(appImage)}.previous`);
}

function stagingPath(appImage: string): string {
  return join(dirname(appImage), `.${basename(appImage)}.rooks-update`);
}

export type AppImageFs = {
  access: (path: string, mode: number) => Promise<void>;
  copyFile: (from: string, to: string) => Promise<void>;
  link: (from: string, to: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  rm: (path: string) => Promise<void>;
  chmod: (path: string, mode: number) => Promise<void>;
  mode: (path: string) => Promise<number>;
  sha256: (path: string) => Promise<string>;
};

const realFs: AppImageFs = {
  access: (path, mode) => access(path, mode),
  copyFile: (from, to) => copyFile(from, to),
  link: (from, to) => link(from, to),
  rename: (from, to) => rename(from, to),
  rm: (path) => rm(path, { force: true }),
  chmod: (path, mode) => chmod(path, mode),
  mode: async (path) => {
    const info = await stat(path);
    if (!info.isFile()) throw new Error('The running AppImage is not a file.');
    return info.mode & 0o7777;
  },
  sha256: sha256Of,
};

export type AppImageReplacement =
  | { status: 'replaced'; restore: () => Promise<void> }
  /** Its folder cannot be written: the verified file stays in Rooks's data folder. */
  | { status: 'not_writable' };

/**
 * Puts the verified AppImage where the running one is.
 *
 * Staged in the same folder (a rename never crosses a file system), made
 * executable with the running file's mode, hashed again, then renamed over the
 * running file: the path is never missing, and the running process keeps its
 * mounted image. The previous file is kept as a hard link (a copy where links
 * are not supported); `restore` puts it back, for a relaunch that cannot be
 * queued. Any failure before the rename leaves the running AppImage as it was.
 */
export async function replaceAppImage(
  input: { appImage: string; verified: string; sha256: string },
  fs: AppImageFs = realFs,
): Promise<AppImageReplacement> {
  const { appImage } = input;
  if (!isAbsolute(appImage) || appImage.includes('\0')) throw new Error('The AppImage path is not absolute.');
  const mode = await fs.mode(appImage);
  try {
    await fs.access(dirname(appImage), constants.W_OK);
  } catch {
    return { status: 'not_writable' };
  }
  const staged = stagingPath(appImage);
  const backup = appImageBackupPath(appImage);
  try {
    await fs.rm(staged);
    await fs.copyFile(input.verified, staged);
    await fs.chmod(staged, mode | 0o755);
    if (await fs.sha256(staged) !== input.sha256) throw new Error('The new AppImage changed while it was copied.');
    await fs.rm(backup);
    try {
      await fs.link(appImage, backup);
    } catch {
      await fs.copyFile(appImage, backup);
    }
    await fs.rename(staged, appImage);
  } catch (error) {
    await fs.rm(staged).catch(() => undefined);
    await fs.rm(backup).catch(() => undefined);
    throw error;
  }
  return { status: 'replaced', restore: () => fs.rename(backup, appImage) };
}

/** Called once the new version runs: the previous AppImage is no longer needed. */
export async function removeAppImageBackup(appImage: string | undefined, remove: (path: string) => Promise<void> = (path) => rm(path, { force: true })): Promise<void> {
  if (!appImage || !isAbsolute(appImage)) return;
  await remove(appImageBackupPath(appImage));
  await remove(stagingPath(appImage));
}

/** POSIX single quotes: the path is shown to be pasted in a terminal, spaces and quotes included. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The command that installs a downloaded `.deb`; apt resolves its dependencies. */
export function debInstallCommand(path: string): string {
  return `sudo apt install ${shellQuote(path)}`;
}
