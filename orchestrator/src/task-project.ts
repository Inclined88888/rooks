/**
 * Resolution of a task's project slug — PURE logic (no database or FS access),
 * to be testable without opening SQLite (db.ts migrates when the module loads).
 *
 * `projectFromCwd` lived in agent.ts, which imports db.js: it is moved here
 * and re-exported from agent.ts so as to break no existing import.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Project slug inferred from an agent's cwd.
 *
 * In host-mode (the real production mode), cwds are paths like
 * `/home/user/projects/app`: without the 3rd pattern, `projectFromCwd`
 * always returned null outside Docker → every project resolution relying
 * on it failed silently (masked only because agents set
 * `cfg.project` hard-coded). The `projects/<slug>` segment is the reliable marker.
 *
 * /workspace alone is not a project — an orchestrator with cwd=/workspace stays
 * cross-project (project: null). Same for `…/projects` with no slug behind.
 */
export function projectFromCwd(cwd: string | undefined | null): string | null {
  if (!cwd) return null;
  const nested = /^\/workspace\/projects\/([A-Za-z0-9._-]+)/.exec(cwd);
  if (nested) return nested[1]!;
  // Host mode: .../projects/<slug> anywhere in the absolute path.
  const host = /\/projects\/([A-Za-z0-9._-]+)(?:\/|$)/.exec(cwd);
  if (host) return host[1]!;
  const flat = /^\/workspace\/([A-Za-z0-9._-]+)/.exec(cwd);
  return flat ? flat[1]! : null;
}

/** A project as the registry knows it: its slug and the root it was registered with. */
export type RegisteredProject = { slug: string; cwd: string | null };

/**
 * Slug of the registered project whose root contains `cwd` (the root itself
 * included). `projectFromCwd` only recognises the `…/projects/<slug>` layout;
 * a folder registered anywhere else (macOS `~/Documents/<name>`, a Windows
 * drive) has no such marker, so the registry is the only thing that says which
 * project it belongs to. The deepest root wins when projects are nested.
 *
 * Pure, and NOT folded into `projectFromCwd`: that one feeds secret injection
 * and memory capture, whose scope must not widen as a side effect.
 */
export function projectFromRegisteredCwd(
  cwd: string | undefined | null,
  projects: readonly RegisteredProject[],
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!cwd) return null;
  // Case differences matter on neither Windows nor the default macOS volume.
  const fold = (path: string) => (platform === 'win32' || platform === 'darwin' ? path.toLowerCase() : path);
  const target = resolve(cwd);
  let best: { slug: string; depth: number } | null = null;
  for (const project of projects) {
    if (!project.cwd) continue;
    const root = resolve(project.cwd);
    const rel = relative(fold(root), fold(target));
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    if (!best || root.length > best.depth) best = { slug: project.slug, depth: root.length };
  }
  return best?.slug ?? null;
}

/**
 * Project slug of a task, in order of precedence:
 *   1. `task.project` — set explicitly at creation (`rooks task create --project`)
 *   2. `cfg.project` of the assigned agent
 *   3. slug derived from the agent's cwd
 *
 * Case 1 exists because an agent not attached to a project gave a null
 * slug: no review/merge role was resolved and the auto-chaining stayed silent.
 */
export function taskProjectSlug(
  task: { project?: string | null },
  cfg: { project?: string | null; cwd?: string | null } | null | undefined,
): string | null {
  if (task.project) return task.project;
  return cfg?.project ?? projectFromCwd(cfg?.cwd);
}
