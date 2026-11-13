/**
 * The ids a manifest may name in `webhooks[].auth`, kept dependency-free like
 * `webhook-path.ts`: `manifest.ts` reads them without loading the engine.
 * Each id has its description in `webhook-formats.ts`; a test keeps the two
 * lists equal.
 *
 * Core ids never contain `:`. A format declared one day by a plugin pack will
 * be named `<plugin-slug>:<name>` (`scopedWebhookFormatId`), so it can never
 * take, shadow or collide with a format shipped and tested here.
 */
export const WEBHOOK_FORMAT_IDS = [
  'standard', 'github', 'gitea', 'forgejo', 'gitlab', 'stripe', 'slack', 'shopify', 'linear', 'discord', 'meta',
] as const;
export type WebhookFormatId = (typeof WEBHOOK_FORMAT_IDS)[number];

/** The first contract whose manifests may name a format other than `standard`. */
export const WEBHOOK_FORMATS_API_VERSION = 8;
