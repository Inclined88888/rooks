/**
 * Module `@rooks/ui-documents` — HTML documents an agent, a user or a plugin
 * shows in a mission's conversation (MCPUI, docs/ADR-MCPUI.md). Tier `std`.
 *
 * Stored in `ui_documents`, served by the daemon under a host-imposed CSP to a
 * sandboxed iframe of the chat. The bridge between the card and the document
 * speaks MCP Apps. Volet 2: display only, no reply yet.
 */
import type { Context } from '@deepseek-ai/cordis';
import { dbApi } from '../../db.js';
import type { ModuleManifest } from '../../kernel/registry.js';
import { settingNum } from '../../settings.js';
import { registerRoutes } from './routes.js';

export const manifest: ModuleManifest = {
  name: '@rooks/ui-documents',
  tier: 'std',
  inject: ['http', 'db'],
};

export const name = manifest.name;
export const inject = manifest.inject;

const PURGE_EVERY_MS = 3_600_000;

/**
 * Removes the documents of missions finished longer than the chat
 * attachments' retention, and of missions that no longer exist. A running
 * mission — one a resume brought back included — is never touched.
 */
export function purgeUiDocumentsOnce(now: number = Date.now()): number {
  const ttl = settingNum('ROOKS_CHAT_ATTACHMENT_TTL_MS');
  if (ttl <= 0) return 0;
  const removed = dbApi.purgeUiDocuments((missionId) => {
    const mission = dbApi.getMission(missionId);
    if (!mission) return true;
    if (mission.status === 'running' || mission.ended_at == null) return false;
    return now - mission.ended_at > ttl;
  });
  if (removed.length) console.log(`[ui-documents] ${removed.length} document(s) of finished missions removed`);
  return removed.length;
}

export function apply(ctx: Context): void {
  registerRoutes(ctx.http.router());
  ctx.effect(() => {
    purgeUiDocumentsOnce();
    const timer = setInterval(() => purgeUiDocumentsOnce(), PURGE_EVERY_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  });
}
