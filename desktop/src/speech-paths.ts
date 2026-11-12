import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';

/**
 * Where the dictation models and the recognizer addon live.
 *
 * Pure functions: platform, environment and filesystem probes are passed in,
 * so the Windows branch is tested on any OS.
 */

export function hasNonAscii(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x7f) return true;
  }
  return false;
}

/**
 * One place the models may live. `shared` is set on a machine-wide fallback:
 * `root` is the directory it was derived from (`C:\ProgramData`), the
 * boundary under which the folder must be owned and locked down before use
 * (`speech-dir-guard.ts`, TODO #445).
 */
export type SpeechModelsCandidate = { dir: string; shared: { root: string } | null };

/**
 * Candidate directories for the models, best first. The Rooks home is the
 * natural place; on Windows a home with a non-ASCII character (`C:\Users\Zoé`)
 * cannot be used, because sherpa-onnx 1.12 opens model files with narrow-char
 * APIs and fails on such paths. The fallbacks are machine-wide ASCII roots,
 * keyed by a hash of the home so two homes never share a cache. The home stays
 * last: a failing fallback must not make dictation impossible to set up.
 */
export function speechModelsDirPlan(
  home: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): SpeechModelsCandidate[] {
  const flavor = platform === 'win32' ? win32 : posix;
  const preferred = flavor.join(home, 'speech', 'models');
  if (platform !== 'win32' || !hasNonAscii(preferred)) return [{ dir: preferred, shared: null }];
  const key = createHash('sha256').update(win32.resolve(home).toLowerCase()).digest('hex').slice(0, 16);
  const roots = [
    env.ProgramData,
    env.PROGRAMDATA,
    env.ALLUSERSPROFILE,
    env.PUBLIC ? win32.join(env.PUBLIC, 'Documents') : undefined,
    env.SystemDrive ? win32.join(`${env.SystemDrive}\\`, 'ProgramData') : undefined,
  ];
  const candidates: SpeechModelsCandidate[] = [];
  for (const root of roots) {
    if (!root || hasNonAscii(root) || !win32.isAbsolute(root)) continue;
    const dir = win32.join(root, 'Rooks', 'speech-models', key);
    if (!candidates.some((c) => c.dir === dir)) candidates.push({ dir, shared: { root: win32.resolve(root) } });
  }
  candidates.push({ dir: preferred, shared: null });
  return candidates;
}

export function speechModelsDirCandidates(
  home: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return speechModelsDirPlan(home, platform, env).map((candidate) => candidate.dir);
}

const FALLBACK_TAIL = /\\Rooks\\speech-models\\[0-9a-f]{16}$/;

/**
 * Whether `dir` has the exact shape of a machine-wide models folder:
 * `<drive>:\…\Rooks\speech-models\<16 hex>`, no `.`/`..` or empty segment,
 * no forward slash, no UNC share. Uninstall deletes only folders that pass.
 */
export function isSpeechModelsFallbackDir(dir: string): boolean {
  if (dir.includes('/') || !/^[A-Za-z]:\\/.test(dir) || !FALLBACK_TAIL.test(dir)) return false;
  return dir.slice(3).split('\\').every((part) => part !== '' && part !== '.' && part !== '..');
}

/**
 * The machine-wide folders this home's models may have been put in, recomputed
 * from the home alone (TODO #444): never read from a file another account
 * could have written. Empty outside Windows and for an ASCII home, whose
 * models live inside the home.
 */
export function speechModelsFallbackDirs(
  home: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return speechModelsDirPlan(home, platform, env)
    .filter((candidate) => candidate.shared && isSpeechModelsFallbackDir(candidate.dir))
    .map((candidate) => candidate.dir);
}

/**
 * The first candidate `prepare` accepts. A refusal (a shared folder another
 * account owns, a creation error) moves on to the next one; throws the last
 * error when none is accepted.
 */
export async function prepareSpeechModelsDir<T extends string | SpeechModelsCandidate>(
  candidates: readonly T[],
  prepare: (candidate: T) => void | Promise<void>,
  log: (message: string) => void = () => undefined,
): Promise<T> {
  let lastError: unknown = new Error('No directory candidate for speech models.');
  for (const candidate of candidates) {
    try {
      await prepare(candidate);
      return candidate;
    } catch (error) {
      lastError = error;
      const dir = typeof candidate === 'string' ? candidate : candidate.dir;
      log(`[speech] models folder ${dir} skipped: ${(error as Error)?.message ?? 'error'}`);
    }
  }
  throw lastError;
}

/** The npm package that carries the recognizer for this OS, or null when none is published. */
export function sherpaPackageName(platform: NodeJS.Platform, arch: string): string | null {
  const supported = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']);
  const key = `${platform}-${arch}`;
  if (!supported.has(key)) return null;
  return platform === 'win32' ? 'sherpa-onnx-win-x64' : `sherpa-onnx-${key}`;
}

export type AddonLocation = {
  platform: NodeJS.Platform;
  arch: string;
  packaged: boolean;
  /** `process.resourcesPath` of a packaged app. */
  resourcesPath: string | undefined;
  /** Resolves a package's entry in a source checkout; throws when it is not installed. */
  resolvePackage: (name: string) => string;
  exists: (path: string) => boolean;
};

/**
 * Directory of the recognizer addon, or null when this machine has none.
 * In a package the addon sits in `app.asar.unpacked` (see `asarUnpack` in
 * electron-builder.yml): the OS loader cannot open a file inside the archive.
 */
export function sherpaAddonDir(location: AddonLocation): string | null {
  const name = sherpaPackageName(location.platform, location.arch);
  if (!name) return null;
  const flavor = location.platform === 'win32' ? win32 : posix;
  let dir: string;
  if (location.packaged) {
    if (!location.resourcesPath) return null;
    dir = flavor.join(location.resourcesPath, 'app.asar.unpacked', 'node_modules', name);
  } else {
    try {
      dir = flavor.dirname(location.resolvePackage(name));
    } catch {
      return null;
    }
  }
  return location.exists(flavor.join(dir, 'sherpa-onnx.node')) ? dir : null;
}
