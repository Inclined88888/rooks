/**
 * `ctx.docs`: the user documentation of the version installed on this
 * machine, offline — what the `docs_search` / `docs_read` tools give an agent.
 *
 * The search and the page reader live in `bin/docs-local.mjs` (plain node, no
 * dependency: the MCP server runs it standalone). This module loads that file,
 * it does not copy it. The pages are public documentation; no caller needs a
 * right beyond the manifest's `docs:read`.
 */
import { z } from 'zod';
import { parseAdminInput, PluginAdminError, type AdminCallerScope } from './admin-support.js';

import type { PluginDocHit } from './contract/docs.js';
export type { PluginDocHit } from './contract/docs.js';

export type ScopedDocs = {
  /** Pages matching the words of `query`, best first. `limit` 1 to 30, default 8. */
  search(query: string, options?: { limit?: number }): Promise<PluginDocHit[]>;
  /** A page as Markdown, or only the section under `heading`. */
  read(route: string, heading?: string): Promise<string>;
};

type DocsModule = {
  loadDocs(): Promise<{ origin: string; pages: unknown[] } | null>;
  searchDocs(pages: unknown[], query: string, limit?: number): PluginDocHit[];
  readDoc(pages: unknown[], route: string, heading?: string): string;
};

/** `bin/` ships beside `dist/` (the same relation `browser-mcp.ts` relies on). */
const loadModule = async (): Promise<DocsModule> =>
  (await import(new URL('../../bin/docs-local.mjs', import.meta.url).href)) as DocsModule;

const QuerySchema = z.string().min(1).max(500);
const RouteSchema = z.string().min(1).max(500);
const HeadingSchema = z.string().min(1).max(200);
const OptionsSchema = z.object({ limit: z.number().int().min(1).max(30).optional() }).strict();

async function pages(): Promise<{ mod: DocsModule; pages: unknown[] }> {
  const mod = await loadModule();
  const docs = await mod.loadDocs();
  if (!docs) throw new PluginAdminError('unavailable', 'the documentation is not installed on this machine');
  return { mod, pages: docs.pages };
}

export function docsFor(_scope: AdminCallerScope): ScopedDocs {
  return {
    async search(query, options = {}) {
      const q = parseAdminInput(QuerySchema, query);
      const { limit } = parseAdminInput(OptionsSchema, options);
      const { mod, pages: all } = await pages();
      try {
        return mod.searchDocs(all, q, limit);
      } catch (err) {
        throw new PluginAdminError('invalid', (err as Error).message);
      }
    },
    async read(route, heading) {
      const r = parseAdminInput(RouteSchema, route);
      const h = heading === undefined ? undefined : parseAdminInput(HeadingSchema, heading);
      const { mod, pages: all } = await pages();
      try {
        return mod.readDoc(all, r, h);
      } catch (err) {
        throw new PluginAdminError('not_found', (err as Error).message);
      }
    },
  };
}
