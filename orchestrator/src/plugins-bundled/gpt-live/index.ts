/**
 * Module `@rooks/gpt-live` — the OpenAI GPT-Live voice layer of the chat.
 *
 * GPT-Live only carries the spoken conversation. It runs in CLIENT delegation
 * mode: every time it needs an answer it hands the turn back to the browser,
 * which posts the user's words to the mission as an ordinary message. The
 * mission's own agent (its backend, tools, cwd, history) stays the brain; the
 * voice model never replaces it.
 *
 * The daemon's share is small on purpose: it holds the API key (read from the
 * secrets vault, never sent to the browser) and trades the browser's WebRTC
 * offer for OpenAI's answer. Audio then flows browser ↔ OpenAI directly.
 *
 * Off by default (`ROOKS_GPT_LIVE_ENABLED`): it is the only feature billed per
 * minute on an API key rather than on a CLI subscription.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { registerRoutes } from './routes.js';

export const manifest: ModuleManifest = {
  name: '@rooks/gpt-live',
  tier: 'opt',
  inject: ['http'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  registerRoutes(ctx.http.router());
}
