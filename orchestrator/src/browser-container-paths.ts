/**
 * Where the project folder lives inside the embedded browser's container.
 *
 * The container is Linux whatever the host. On Linux and macOS the project is
 * mounted at the SAME absolute path as on the host, so a path an agent hands to
 * `upload_file` is valid on both sides as is. On Windows that is impossible:
 * `D:\Projects\X` is not a Linux path, and its drive-letter colon broke the
 * `-v source:target:ro` spec outright (TIM-0120). There the target is a stable
 * POSIX path derived from the source (`D:\Projects\X` → `/host/d/Projects/X`),
 * and every host path an agent uploads goes through `toContainerPath` first —
 * otherwise Chromium attaches a 0-byte file without any error.
 *
 * PURE: the platform is a parameter, so the three OSes are testable from Linux.
 */
import { posix, win32 } from 'node:path';

/** Root of the translated mounts in the container (Windows hosts only). */
export const CONTAINER_HOST_ROOT = '/host';

export type ProjectMount = {
  /** Path handed to docker as the bind source, in the host's own syntax. */
  source: string;
  /** Absolute POSIX path of the same folder inside the container. */
  target: string;
};

/** `\\?\D:\x` → `D:\x`, `\\?\UNC\srv\share` → `\\srv\share`, `/` → `\`, `..` resolved. */
function normalizeWindowsPath(path: string): string {
  let p = path.replace(/\//g, '\\');
  if (/^\\\\\?\\UNC\\/i.test(p)) p = `\\\\${p.slice(8)}`;
  else if (p.startsWith('\\\\?\\')) p = p.slice(4);
  p = win32.normalize(p);
  // Keep `D:\` as is, drop the trailing separator of anything longer.
  if (p.length > 3 && p.endsWith('\\')) p = p.slice(0, -1);
  return p;
}

/** Container path of an absolute Windows path, or null if it has no drive or UNC root. */
function windowsTarget(normalized: string): string | null {
  const drive = /^([A-Za-z]):(?:\\(.*))?$/.exec(normalized);
  if (drive) return joinTarget(posix.join(CONTAINER_HOST_ROOT, drive[1]!.toLowerCase()), drive[2] ?? '');
  const unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\(.*))?$/.exec(normalized);
  if (unc) return joinTarget(posix.join(CONTAINER_HOST_ROOT, 'unc', unc[1]!, unc[2]!), unc[3] ?? '');
  return null;
}

/** The container is Linux whatever the host: its paths are always POSIX. */
function joinTarget(root: string, rest: string): string {
  return posix.join(root, ...rest.split('\\').filter(Boolean));
}

/**
 * Bind mount of the project folder, or null when the path cannot be mounted
 * (empty, relative, or a Windows path with neither drive nor UNC root).
 */
export function containerProjectMount(
  hostPath: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): ProjectMount | null {
  if (!hostPath) return null;
  if (platform !== 'win32') return hostPath.startsWith('/') ? { source: hostPath, target: hostPath } : null;
  const source = normalizeWindowsPath(hostPath);
  const target = windowsTarget(source);
  return target ? { source, target } : null;
}

/**
 * Container path of a host file, or null when it lies outside the mounted
 * project (the browser could not read it). Identity outside Windows, where
 * both sides share the same path — what was there before TIM-0120.
 */
export function toContainerPath(
  filePath: string,
  mount: ProjectMount,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== 'win32') return filePath;
  const file = normalizeWindowsPath(filePath);
  // Windows paths are case-insensitive: `d:\projects\x` is the mounted `D:\Projects\X`.
  const lowerFile = file.toLowerCase();
  const lowerSource = mount.source.toLowerCase();
  const prefix = lowerSource.endsWith('\\') ? lowerSource : `${lowerSource}\\`;
  if (lowerFile !== lowerSource && !lowerFile.startsWith(prefix)) return null;
  return joinTarget(mount.target, file.slice(mount.source.length));
}
