/** Local uninstall policy. No caller can supply a deletion path over IPC. */
import { lstatSync, realpathSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { speechModelsFallbackDirs } from './speech-paths.js';
import { sharedSpeechDirRemovable, windowsSecurityProbe } from './speech-dir-guard.js';
import { LOCALE_TAG_PATTERN } from './i18n-core.js';
import { shellText } from './shell-i18n.js';

export const UNINSTALL_INFO_CHANNEL = 'rooks:uninstall-info';
export const UNINSTALL_CHANNEL = 'rooks:uninstall';
export const UNINSTALL_HELPER_FLAG = '--rooks-uninstall-helper';
export type UninstallMode = 'keep' | 'delete';
/** `locale`: the app's language (any tag); the shell negotiates it among the languages it has. */
export type UninstallRequest = { mode: UninstallMode; confirmation: string; locale: string };
export type CleanupPlan = { home: string; device: number; inode: number; mode: UninstallMode };
export type CleanupCopy = { done: string; deleted: string; kept: string; leftover: string; incomplete: string };

export function uninstallRequest(value: unknown): UninstallRequest {
  const input = value as Partial<UninstallRequest> | null;
  if (!input || (input.mode !== 'keep' && input.mode !== 'delete')
    || typeof input.locale !== 'string' || !LOCALE_TAG_PATTERN.test(input.locale)
    || (input.mode === 'delete' && input.confirmation !== 'SUPPRIMER')) {
    throw new Error('Invalid uninstall confirmation.');
  }
  return { mode: input.mode, confirmation: input.confirmation ?? '', locale: input.locale };
}

export function canUninstall(sender: { isWindow: boolean; isMainFrame: boolean; url: string }, origin: string): boolean {
  try {
    const url = new URL(sender.url);
    // Settings is a dialog over any page: its desktop tab is named by the
    // `settings` query parameter, not by the path underneath.
    return sender.isWindow && sender.isMainFrame && url.origin === new URL(origin).origin
      && url.searchParams.get('settings') === 'system/desktop';
  } catch { return false; }
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

export function cleanupPlan(home: string, mode: UninstallMode, executable: string, userHome = homedir()): CleanupPlan {
  if (!isAbsolute(home) || resolve(home) !== home || realpathSync(home) !== home) throw new Error('The data directory must be canonical.');
  const info = lstatSync(home);
  const user = realpathSync(userHome);
  const reserved = ['Desktop', 'Documents', 'Downloads', 'Developer', 'Library', 'AppData', '.config', '.local', '.ssh', '.claude', '.codex', '.grepai'];
  if (!info.isDirectory() || dirname(home) === home || contains(home, user)
    || contains(home, realpathSync(executable))
    || reserved.some(name => home === join(user, name))) {
    throw new Error('This data directory is shared or contains the running application. Automatic cleanup is refused.');
  }
  if (!['rooks.config.json', 'rooks.db', 'desktop-bootstrap.json'].some(name => existsSync(join(home, name)))) {
    throw new Error('This directory cannot be identified as a Rooks installation.');
  }
  return { home, device: info.dev, inode: info.ino, mode };
}

type CleanupFs = Pick<typeof import('node:fs'), 'lstat' | 'rm' | 'rmdir'>;

export type CleanupOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /**
   * Removes a machine-wide models folder, given `[…\Rooks, …\speech-models, …\<hash>]`.
   * Resolves when it is gone or not ours to delete; rejects when it stays.
   */
  removeShared?: (chain: string[]) => Promise<void>;
};

/** Called in a separate process only AFTER the shell and its Chromium sessions
 * have exited. Never traverse a symlink to a project or external CLI directory.
 * Resolves with the folders outside the home that could not be removed. */
export async function cleanupData(plan: CleanupPlan, options: CleanupOptions = {}): Promise<string[]> {
  const current = lstatSync(plan.home);
  if (!current.isDirectory() || current.isSymbolicLink() || realpathSync(plan.home) !== plan.home
    || current.dev !== plan.device || current.ino !== plan.inode) {
    throw new Error('The data directory changed during uninstall. No data was removed.');
  }
  const fs: typeof import('node:fs') = createRequire(import.meta.url)(process.versions.electron ? 'original-fs' : 'node:fs');
  const leftovers: string[] = [];
  if (plan.mode === 'delete') {
    // A Windows home with a non-ASCII character keeps the dictation models
    // under ProgramData (TODO #444). Best effort: a folder left behind is
    // reported, it never stops the home from being deleted.
    const env = options.env ?? process.env;
    const removeShared = options.removeShared ?? (async (chain: string[]) => {
      // Owners read as SIDs, as when the folder was locked down (TODO #445).
      if (sharedSpeechDirRemovable(await windowsSecurityProbe(env).inspect(chain))) await removeSharedChain(chain, fs);
    });
    for (const dir of speechModelsFallbackDirs(plan.home, options.platform ?? process.platform, env)) {
      const models = win32.dirname(dir);
      try { await removeShared([win32.dirname(models), models, dir]); } catch { leftovers.push(dir); }
    }
  }
  const target = plan.mode === 'delete' ? plan.home : join(plan.home, 'desktop-runtime');
  await promisify(fs.rm)(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  return leftovers;
}

/**
 * Deletes the last folder of `chain` once every folder of it is checked to be
 * a real directory: a junction planted by another account in the chain would
 * otherwise redirect the deletion. The parents go too, only when left empty:
 * other accounts keep their own models there.
 */
export async function removeSharedChain(chain: readonly string[], fs: CleanupFs): Promise<void> {
  const leaf = chain[chain.length - 1];
  if (!leaf) return;
  const lstat = promisify(fs.lstat);
  for (const dir of chain) {
    let info: import('node:fs').Stats;
    try { info = await lstat(dir); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Not a plain directory: ${dir}`);
  }
  await promisify(fs.rm)(leaf, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  for (const parent of chain.slice(0, -1).reverse()) {
    try { await promisify(fs.rmdir)(parent); } catch { return; }
  }
}

export function removalInstructions(platform: NodeJS.Platform, locale: string, appImage?: string): string {
  const t = shellText(locale);
  if (platform === 'darwin') return t('uninstall.finishMac');
  if (platform === 'win32') return t('uninstall.finishWindows');
  if (appImage) return t('uninstall.finishAppImage', { path: appImage });
  return t('uninstall.finishLinux');
}

/**
 * What the cleanup helper says once the app is gone, worded here: the
 * helper is a bare process that reads no language file.
 */
export function cleanupCopy(locale: string, home: string): CleanupCopy {
  const t = shellText(locale);
  return {
    done: t('uninstall.done'),
    deleted: t('uninstall.deleted'),
    kept: t('uninstall.kept', { home }),
    leftover: t('uninstall.leftover'),
    incomplete: t('uninstall.cleanupIncomplete', { home }),
  };
}
