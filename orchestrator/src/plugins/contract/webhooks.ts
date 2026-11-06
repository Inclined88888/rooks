/** Public plugin types, extracted from the host implementations (TODO #512). */
/** What the handler of a plugin webhook receives. */
export type PluginWebhookRequest = {
  /** The manifest name the call was addressed to. */
  readonly name: string;
  /**
   * The delivery's id: the signed `webhook-id` (`standard`), else the
   * service's delivery header (`x-github-delivery`…), else `sha256:<hex>` of
   * the body. The same across the sender's retries.
   */
  readonly id: string;
  /** The signed timestamp in milliseconds; the time of receipt when the format signs none. */
  readonly timestamp: number;
  /** Request headers, lowercase, proofs removed (the format's signature header, `authorization`…). */
  readonly headers: Readonly<Record<string, string>>;
  /** The body exactly as signed, decoded as UTF-8. */
  readonly text: string;
  /** `JSON.parse(text)`; throws on a body that is not JSON. */
  json<T = unknown>(): T;
};

/**
 * Resolving answers 200 — with `{status:'received'}`, or with the returned
 * value serialized as JSON (API 8; a Discord interaction or a Slack command
 * expects its reply in the response). Throwing (or exceeding the time limit)
 * answers 5xx and lets the sender retry the same delivery.
 */
export type PluginWebhookHandler = (request: PluginWebhookRequest) => unknown;

/**
 * Why `ctx.webhooks.asOwner` ran nothing: the plugin does not listen on the
 * name yet (`on` first), no usable secret was ever set for it, or the account
 * that set it is gone or lost the plugin.
 */
export type PluginWebhookOwnerSkip = 'not_listening' | 'no_secret' | 'owner_unavailable';
/** Outcome of `ctx.webhooks.asOwner` (API 15). */
export type PluginWebhookOwnerRun<T> = { ran: true; value: T } | { ran: false; reason: PluginWebhookOwnerSkip };
