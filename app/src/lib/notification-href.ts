/**
 * Deep link of a notification: `/chat` on the right mission, card highlighted.
 *
 * Extracted from the notification rail so the app has only ONE URL builder.
 * The server counterpart lives in `orchestrator/src/push.ts`
 * (`notificationHref`) — it produces exactly the same string, carried in the
 * Web Push payload, since the service worker (static JS in public/) cannot
 * import this module.
 */
export type NotificationLinkFields = {
  mission_id: string | null;
  task_id: string | null;
  anchor: string | null;
};

export function notificationHref(n: NotificationLinkFields): string | null {
  const egress = n.anchor ? EGRESS_ANCHOR.exec(n.anchor) : null;
  if (egress) return `/chat?mission=${encodeURIComponent(egress[1]!)}&egress=1`;
  if (n.mission_id) {
    const anchor = n.anchor ? `&highlight=${encodeURIComponent(n.anchor)}` : '';
    return `/chat?mission=${encodeURIComponent(n.mission_id)}${anchor}`;
  }
  if (n.task_id) return `/chat?task=${encodeURIComponent(n.task_id)}`;
  // Neither mission nor task, but a page anchor: go straight there. Without
  // this case, every notification the orchestrator emits itself (memory
  // curation, dreaming, audits — mission_id AND task_id null) was a dead
  // card: the click did nothing.
  if (n.anchor && n.anchor.startsWith('/')) return n.anchor;
  const consent = n.anchor ? PLUGIN_SECRET_ANCHOR.exec(n.anchor) : null;
  if (consent) return `/secrets?grant=${encodeURIComponent(consent[2]!)}&plugin=${encodeURIComponent(consent[1]!)}`;
  const launch = n.anchor ? PROVIDER_LAUNCH_ANCHOR.exec(n.anchor) : null;
  if (launch) return `/?settings=${encodeURIComponent('models/backends')}&provider=${encodeURIComponent(launch[1]!)}`;
  return null;
}

/**
 * A new outbound host for a mission (`egress:<mission>`, TODO #590): the
 * mission's chat, its Network view opened (`lib/egress.ts`). Not
 * `&highlight=`, which names a card of the thread: the chat would page through
 * the whole history looking for it.
 */
const EGRESS_ANCHOR = /^egress:(.+)$/;

/**
 * Refused launch of a third-party provider (`provider-launch:<id>`, TODO #598):
 * the card opens Settings › AI models › Backends on that provider, where the
 * re-authorisation is confirmed (`ProvidersPanel`, `provider` parameter).
 */
const PROVIDER_LAUNCH_ANCHOR = /^provider-launch:(.+)$/;

/**
 * Consent card of a plugin (`plugin-secret:<id>:<NAME>`, TODO #597): it opens
 * the Secrets page, grant prefilled, to confirm. The anchor stays the one that
 * closes the card. A secret name never has a `:`, so the last one separates
 * the plugin id from the name.
 */
const PLUGIN_SECRET_ANCHOR = /^plugin-secret:(.+):([A-Z][A-Z0-9_]*)$/;
