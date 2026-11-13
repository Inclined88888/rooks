/**
 * Module `@rooks/projects` — projects: list, meta, activity, roles per task
 * type, and the uploaded images that illustrate them. Tier `std`: switching it
 * off takes the project registry away, not the daemon.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { registerRoutes } from './routes.js';
import { bus } from '../../bus.js';
import { dbApi } from '../../db.js';
import { loadConfig } from '../../agent-config.js';
import { projectFromCwd } from '../../task-project.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Ordering token: project activity is tracked. */
    '@rooks/projects': Record<string, never>;
  }
}

export const manifest: ModuleManifest = {
  name: '@rooks/projects',
  tier: 'core',
  inject: ['http', 'db'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  // Mounted at the root: the routes already carry their public prefix,
  // moving them would break the front proxy, the CLI and the agents.
  registerRoutes(ctx.http.router());

  ctx.provide('@rooks/projects', {});

  // A project's `last_activity`: touched on every finished mission, never by
  // hand. The slug is resolved from the mission's agent (config or cwd).
  ctx.effect(() => {
    const onEvent = (ev: { kind?: string; missionId?: string }) => {
      if (ev.kind !== 'mission_complete' || !ev.missionId) return;
      try {
        const m = dbApi.getMission(ev.missionId);
        if (!m) return;
        const cfg = loadConfig(m.agent_name);
        const slug = cfg.project ?? projectFromCwd(cfg.cwd);
        if (slug) dbApi.touchProjectActivity(slug);
      } catch { /* best-effort */ }
    };
    bus.on('event', onEvent);
    return () => void bus.off('event', onEvent);
  });
}
