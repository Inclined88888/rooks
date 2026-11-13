/**
 * A private folder a provider writes its per-mission state into — the system
 * prompt a CLI reads from a file, its MCP configuration, a turn's images, the
 * session store of a CLI that keeps it next to the mission (S3,
 * `docs/PROVIDERS-SDK.md` § 6.1) — and the operations that go wrong on a user's
 * machine if each provider writes them by hand.
 *
 * Leaf on purpose: the daemon builds one over `<ROOKS_HOME>/provider-runs/…`, and
 * the testing kit builds one over a temporary folder, so a provider is exercised
 * against the same code.
 *
 *   - every path is RELATIVE to the folder and resolved inside it: `..`, an
 *     absolute path and a link that leads outside are refused;
 *   - a file is written 0600, in a folder that is 0700 (Windows ignores the modes:
 *     the folder sits in the user's profile, whose ACL already shuts others out);
 *   - `writeFile` hands the content to `swap` first, which is where the daemon
 *     turns the references of `launch-seal.ts` back into values;
 *   - `link` exposes a credential file of the user's to the mission with the
 *     chain a CLI's auth file taught the product (TIM-0009): a symbolic link, then
 *     a hard link, then a copy — Windows without the privilege refuses the first.
 */

import {
  chmodSync, copyFileSync, linkSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** How a reference is written back: as the inside of a JSON or TOML string, or raw (`launch-seal.ts` knows the same two). */
export type ScratchEscape = 'none' | 'json';

export type ScratchLinkMethod = 'symlink' | 'hardlink' | 'copy';

export type ScratchWriteOptions = {
  /** How a secret reference inside a text is written back: inside a JSON/TOML string, or as is. Default by extension: `.json`, `.toml`, `.jsonc` escape, the rest not. */
  readonly escape?: ScratchEscape;
};

export type ProviderScratchDir = {
  /** Absolute path of the folder: what to hand a CLI (`GROK_HOME`, `--prompt-file`). */
  readonly path: string;
  /** Absolute path of `name` inside the folder; throws if it would leave it. Creates nothing. */
  resolve(name: string): string;
  /** Writes `content` (text, or bytes untouched) at `name`, folders included, 0600. Returns the absolute path. */
  writeFile(name: string, content: string | Uint8Array, options?: ScratchWriteOptions): string;
  /**
   * Exposes `source` — a file under one of the credential folders this provider
   * declared (`declares.credentialDirs`) — at `name`: a symbolic link, else a hard
   * link, else a copy. Returns which. A source anywhere else is refused.
   */
  link(source: string, name: string): ScratchLinkMethod;
  /** Whether `name` exists inside the folder (a link counts, even a dangling one). */
  has(name: string): boolean;
  /** Removes `name` (a file or a folder) if it exists. */
  remove(name: string): void;
};

export const MAX_SCRATCH_FILE_BYTES = 64 * 1024 * 1024;

export class ScratchPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScratchPathError';
  }
}

export type ScratchDirOptions = {
  readonly root: string;
  /** Turns the text a provider writes into the text that reaches the disk. Identity outside the daemon. */
  swap?(text: string, escape: ScratchEscape): string;
  /** Absolute folders `link` may take a source from. Empty = `link` refuses everything. */
  readonly linkRoots?: readonly string[];
  /** Test seam: the attempts `link` makes, in order. Default: symbolic link, hard link, copy. */
  readonly linkChain?: (real: string, target: string) => Array<[ScratchLinkMethod, () => void]>;
};

function insideOf(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** Throws if `name` is not a plain relative path. */
function relativeName(name: string): string {
  if (typeof name !== 'string' || name === '' || name.includes('\0')) throw new ScratchPathError('a scratch file needs a non-empty name');
  if (isAbsolute(name) || /^[A-Za-z]:/.test(name) || name.startsWith('/') || name.startsWith('\\')) {
    throw new ScratchPathError(`\`${name}\` is absolute: scratch paths are relative to the mission's folder`);
  }
  if (name.split(/[\\/]/).some((part) => part === '..')) throw new ScratchPathError(`\`${name}\` goes up with \`..\``);
  return name;
}

function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dir, 0o700);
}

export function createScratchDir(options: ScratchDirOptions): ProviderScratchDir {
  privateDir(options.root);
  const root = resolve(options.root);
  const realRoot = realpathSync(root);
  const swap = options.swap ?? ((text: string) => text);

  const resolveInside = (name: string): string => {
    const target = resolve(root, relativeName(name));
    if (!insideOf(root, target)) throw new ScratchPathError(`\`${name}\` leaves the mission's folder`);
    return target;
  };

  /** The folder that will hold `target`, created, and proved to be inside the real folder (no link leads out). */
  const parentOf = (target: string): string => {
    const parent = dirname(target);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (!insideOf(realRoot, realpathSync(parent))) throw new ScratchPathError('a link inside the mission\'s folder leads outside it');
    return parent;
  };

  const linkRoots = (options.linkRoots ?? []).flatMap((dir) => {
    try { return [realpathSync(dir)]; } catch { return []; }
  });

  return {
    path: root,
    resolve: resolveInside,
    writeFile(name, content, writeOptions = {}) {
      const target = resolveInside(name);
      parentOf(target);
      // A link at the destination would be followed by the write: replace it, never write through it.
      try { if (lstatSync(target).isSymbolicLink()) rmSync(target, { force: true }); } catch { /* absent */ }
      let data: string | Uint8Array = content;
      if (typeof content === 'string') {
        const escape = writeOptions.escape ?? (/\.(json|jsonc|toml)$/i.test(name) ? 'json' : 'none');
        data = swap(content, escape);
      }
      const size = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength;
      if (size > MAX_SCRATCH_FILE_BYTES) throw new ScratchPathError(`\`${name}\` is ${size} bytes, over the ${MAX_SCRATCH_FILE_BYTES} a scratch file may hold`);
      writeFileSync(target, data, { mode: 0o600 });
      if (process.platform !== 'win32') chmodSync(target, 0o600);
      return target;
    },
    link(source, name) {
      let real: string;
      try { real = realpathSync(source); } catch { throw new ScratchPathError(`\`${source}\` does not exist`); }
      if (!linkRoots.some((allowed) => insideOf(allowed, real))) {
        throw new ScratchPathError(`\`${source}\` is not under a credential folder this provider declared (\`declares.credentialDirs\`)`);
      }
      if (!statSync(real).isFile()) throw new ScratchPathError(`\`${source}\` is not a file`);
      const target = resolveInside(name);
      parentOf(target);
      rmSync(target, { force: true });
      const attempts: Array<[ScratchLinkMethod, () => void]> = options.linkChain?.(real, target) ?? [
        ['symlink', () => symlinkSync(real, target)],
        ['hardlink', () => linkSync(real, target)],
        ['copy', () => copyFileSync(real, target)],
      ];
      const errors: string[] = [];
      for (const [method, attempt] of attempts) {
        try {
          attempt();
          return method;
        } catch (error) {
          errors.push(`${method}: ${(error as Error).message}`);
        }
      }
      throw new ScratchPathError(`cannot expose \`${source}\` to the mission: ${errors.join('; ')}`);
    },
    has(name) {
      try { lstatSync(resolveInside(name)); return true; } catch (error) {
        if (error instanceof ScratchPathError) throw error;
        return false;
      }
    },
    remove(name) {
      rmSync(resolveInside(name), { recursive: true, force: true });
    },
  };
}
