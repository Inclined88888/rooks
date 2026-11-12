/**
 * Module `@rooks/mcp-apps` — the Apps catalogue: remote MCP servers hosted by
 * their own publisher, connected in one click (docs/MCP-APPS.md).
 *
 * What it owns: the reviewed entries (`catalog/`), the routes that list them
 * and turn one into an MCP server, and the `/apps` page (client half). What it
 * does not: the MCP storage, the OAuth flow and the launch, which stay in the
 * core (`mcp.ts`, `oauth.ts`, the routes of `@rooks/agents`) — hence
 * `dependsOn: ['@rooks/agents']` in the catalogue. Switching the module off
 * takes the page and its routes away; servers already connected stay, as
 * ordinary MCP servers of the MCP tab.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { registerMcpAppsRoutes } from './routes.js';

export const manifest: ModuleManifest = {
  name: '@rooks/mcp-apps',
  tier: 'std',
  inject: ['http'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  // Mounted at the root: the routes carry their public prefix, the one the front proxy relays.
  registerMcpAppsRoutes(ctx.http.router());
}
