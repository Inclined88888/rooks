/**
 * `ctx.browser`: the project browsers, listed, started and stopped.
 *
 * Bounded by the caller like the routes under `/api/browser`: a request sees
 * the sessions its account may see, a job the ones `plugin:<id>` started. A
 * session the caller may not see answers exactly like one that does not
 * exist (`not_found`), for `start` and `stop` too.
 *
 * What a session shows is what the UI needs, not what drives the browser: no
 * debugging endpoint (CDP URL or port), no container name, no stored tabs. A
 * plugin that could drive the browser would drive whatever the user is
 * signed in to in it.
 */
import { dbApi, type DbViewer } from '../db.js';
import {
  GENERAL_BROWSER_SLUG, getBrowserSession, listBrowserSessions, startBrowserSession, stopBrowserSession,
  type BrowserSession,
} from '../browser-sessions.js';
import { auditPluginAction, PluginAdminError, type AdminCallerScope } from './admin-support.js';

import type { PluginBrowserSession } from './contract/browser.js';
export type { PluginBrowserSession } from './contract/browser.js';

export type ScopedBrowser = {
  list(): PluginBrowserSession[];
  /** `undefined` when there is no such session or it is not the caller's to see. */
  status(project: string): PluginBrowserSession | undefined;
  /** Starts the project's browser, or returns the running one. */
  start(project: string): Promise<PluginBrowserSession>;
  stop(project: string): Promise<PluginBrowserSession | undefined>;
};

export function browserFor(scope: AdminCallerScope): ScopedBrowser {
  const viewer: DbViewer | null = scope.viewer;
  const view = (s: BrowserSession): PluginBrowserSession => ({
    project: s.project,
    status: s.status,
    url: s.url,
    startedAt: s.started_at,
    stoppedAt: s.stopped_at,
    lastUsedAt: s.last_used_at,
    mine: viewer !== null && s.owner_user_id === viewer.id,
  });
  const slug = (project: unknown): string => {
    if (typeof project !== 'string' || project === '' || project.length > 200) {
      throw new PluginAdminError('invalid', 'a project slug is required');
    }
    return project;
  };
  const hidden = (project: string): boolean => dbApi.browserSessionAccess(project, viewer) === 'forbidden';
  const notFound = (project: string) => new PluginAdminError('not_found', `no browser for project: ${project}`);

  return {
    list: () => listBrowserSessions(viewer).map(view),
    status(project) {
      const s = getBrowserSession(slug(project), viewer);
      return s ? view(s) : undefined;
    },
    async start(project) {
      const p = slug(project);
      if (hidden(p)) throw notFound(p);
      // A browser is started for a project that exists (or the general one), not for any slug:
      // starting mounts the project's directory.
      if (p !== GENERAL_BROWSER_SLUG && !dbApi.getProjectRow(p)) throw notFound(p);
      try {
        const session = await startBrowserSession(p, viewer);
        auditPluginAction(scope, 'browser.start', `project:${p}`);
        return view(session);
      } catch (err) {
        if (err instanceof PluginAdminError) throw err;
        throw new PluginAdminError('unavailable', (err as Error).message);
      }
    },
    async stop(project) {
      const p = slug(project);
      if (hidden(p)) throw notFound(p);
      try {
        await stopBrowserSession(p);
      } catch (err) {
        throw new PluginAdminError('unavailable', (err as Error).message);
      }
      auditPluginAction(scope, 'browser.stop', `project:${p}`);
      const s = getBrowserSession(p, viewer);
      return s ? view(s) : undefined;
    },
  };
}
