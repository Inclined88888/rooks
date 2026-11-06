/**
 * The signature formats Timon ships and tests: one DESCRIPTION per service,
 * verified by the generic engine (`webhook-schemes.ts`). A plugin names one
 * in its manifest (`"auth": "github"`); it never brings its own code.
 *
 * Each description was checked against the service's own documentation or
 * source (12/10/2026), and `webhook-formats.test.ts` runs the official
 * vectors where the service publishes some (GitHub, Slack, Standard Webhooks):
 *
 *   standard  standardwebhooks.com — `webhook-id`, `webhook-timestamp`,
 *             `webhook-signature: v1,<b64>` list, key `whsec_<b64>` decoded.
 *             Also GitLab ≥ 19.1 "signing token".
 *   github    docs.github.com "Validating webhook deliveries" —
 *             `X-Hub-Signature-256: sha256=<hex>`, `X-GitHub-Delivery`.
 *   gitea     go-gitea/gitea services/webhook/deliver.go — `X-Gitea-Signature:
 *             <hex>` (no prefix), `X-Gitea-Delivery`.
 *   forgejo   forgejo services/webhook/shared/payloader.go — `X-Forgejo-Signature`,
 *             `X-Forgejo-Delivery`.
 *   gitlab    docs.gitlab.com webhooks — `X-Gitlab-Token`, the secret itself;
 *             `Idempotency-Key` (17.4+) is the same across retries.
 *   stripe    docs.stripe.com "verify manually" + stripe-node Webhooks.ts —
 *             `Stripe-Signature: t=…,v1=…[,v1=…][,v0=…]`, HMAC of `t.body` with
 *             the `whsec_` string as is (not decoded), tolerance 300 s.
 *   slack     docs.slack.dev "Verifying requests" — `X-Slack-Signature:
 *             v0=<hex>` of `v0:ts:body`, `X-Slack-Request-Timestamp`, 5 min.
 *   shopify   shopify.dev HTTPS webhooks — `X-Shopify-Hmac-SHA256: <b64>` with
 *             the app's client secret, `X-Shopify-Webhook-Id`.
 *   linear    linear.app/developers/webhooks — `Linear-Signature: <hex>` of the
 *             body, `Linear-Delivery`, `webhookTimestamp` (ms) in the signed
 *             body within a minute. `Linear-Timestamp` is NOT signed: unused.
 *   discord   docs.discord.com interactions — Ed25519 `X-Signature-Ed25519`
 *             (hex) over `timestamp + body`, `X-Signature-Timestamp`, the
 *             app's hex public key; `PING` (`type: 1`) answered `{type: 1}`.
 *   meta      developers.facebook.com Graph webhooks — `X-Hub-Signature-256:
 *             sha256=<hex>` with the app secret; GET subscription with
 *             `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`.
 *
 * Left out on purpose: Twilio (signs the URL), SNS and PayPal (fetch a remote
 * certificate), Atlassian Connect (JWT).
 */
import { WEBHOOK_FORMAT_IDS, type WebhookFormatId } from './webhook-format-ids.js';
import { WebhookSchemeSchema, schemeLevel, type WebhookScheme, type WebhookSchemeLevel } from './webhook-schemes.js';

export { WEBHOOK_FORMAT_IDS, WEBHOOK_FORMATS_API_VERSION, type WebhookFormatId } from './webhook-format-ids.js';

export type WebhookFormat = {
  readonly id: WebhookFormatId;
  /** Name shown next to the webhook. */
  readonly label: string;
  readonly scheme: WebhookScheme;
  readonly level: WebhookSchemeLevel;
};

const RAW: Record<WebhookFormatId, { label: string; scheme: unknown }> = {
  standard: {
    label: 'Standard Webhooks',
    scheme: {
      kind: 'hmac', algorithm: 'sha256', encoding: 'base64', key: 'whsec',
      signature: { format: 'list', header: 'webhook-signature', prefix: 'v1,' },
      signed: '{header:webhook-id}.{timestamp}.{body}',
      timestamp: { from: 'header', header: 'webhook-timestamp', unit: 's', windowS: 300 },
      secret: { sources: ['generated', 'provided'], minLength: 30, pattern: '^whsec_[A-Za-z0-9+/]+={0,2}$' },
    },
  },
  github: {
    label: 'GitHub',
    scheme: {
      kind: 'hmac', algorithm: 'sha256', encoding: 'hex',
      signature: { format: 'single', header: 'x-hub-signature-256', prefix: 'sha256=' },
      signed: '{body}', delivery: { header: 'x-github-delivery' },
      secret: { sources: ['generated'], minLength: 32 },
    },
  },
  gitea: {
    label: 'Gitea',
    scheme: {
      kind: 'hmac', algorithm: 'sha256', encoding: 'hex',
      signature: { format: 'single', header: 'x-gitea-signature' },
      signed: '{body}', delivery: { header: 'x-gitea-delivery' },
      secret: { sources: ['generated'], minLength: 32 },
    },
  },
  forgejo: {
    label: 'Forgejo',
    scheme: {
      kind: 'hmac', algorithm: 'sha256', encoding: 'hex',
      signature: { format: 'single', header: 'x-forgejo-signature' },
      signed: '{body}', delivery: { header: 'x-forgejo-delivery' },
      secret: { sources: ['generated'], minLength: 32 },
    },
  },
  gitlab: {
    label: 'GitLab (secret token)',
    scheme: {
      kind: 'token', header: 'x-gitlab-token', delivery: { header: 'idempotency-key' },
      secret: { sources: ['generated'], minLength: 32 },
    },
  },
  stripe: {
    label: 'Stripe',
    scheme: {
      kind: 'hmac', algorithm: 'sha256', encoding: 'hex',
      signature: { format: 'keyed', header: 'stripe-signature', key: 'v1', timestampKey: 't' },
      signed: '{timestamp}.{body}', timestamp: { from: 'signature', unit: 's', windowS: 300 },
      secret: { sources: ['provided'], minLength: 20, pattern: '^whsec_[A-Za-z0-9]+$' },
    },
  },
  slack: {
    label: 'Slack',
    scheme: {
      kind: 'hmac', algorithm: 'sha256', encoding: 'hex',
      signature: { format: 'single', header: 'x-slack-signature', prefix: 'v0=' },
      signed: 'v0:{timestamp}:{body}',
      timestamp: { from: 'header', header: 'x-slack-request-timestamp', unit: 's', windowS: 300 },
      secret: { sources: ['provided'], minLength: 16 },
      handshakes: [{ when: { field: 'type', equals: 'url_verification' }, reply: { echo: 'challenge' } }],
    },
  },
  shopify: {
    label: 'Shopify',
    scheme: {
      kind: 'hmac', algorithm: 'sha256', encoding: 'base64',
      signature: { format: 'single', header: 'x-shopify-hmac-sha256' },
      signed: '{body}', delivery: { header: 'x-shopify-webhook-id' },
      secret: { sources: ['provided'], minLength: 16 },
    },
  },
  linear: {
    label: 'Linear',
    scheme: {
      kind: 'hmac', algorithm: 'sha256', encoding: 'hex',
      signature: { format: 'single', header: 'linear-signature' },
      signed: '{body}', timestamp: { from: 'json', field: 'webhookTimestamp', unit: 'ms', windowS: 60 },
      delivery: { header: 'linear-delivery' },
      secret: { sources: ['provided'], minLength: 16 },
    },
  },
  discord: {
    label: 'Discord (interactions)',
    scheme: {
      kind: 'ed25519', signature: { header: 'x-signature-ed25519', encoding: 'hex' },
      signed: '{timestamp}{body}',
      timestamp: { from: 'header', header: 'x-signature-timestamp', unit: 's', windowS: 300 },
      publicKey: { encoding: 'hex' },
      handshakes: [{ when: { field: 'type', equals: 1 }, reply: { json: { type: 1 } } }],
    },
  },
  meta: {
    label: 'Meta (Facebook, Instagram, WhatsApp)',
    scheme: {
      kind: 'hmac', algorithm: 'sha256', encoding: 'hex',
      signature: { format: 'single', header: 'x-hub-signature-256', prefix: 'sha256=' },
      signed: '{body}',
      secret: { sources: ['provided'], minLength: 16 },
      subscribe: { modeParam: 'hub.mode', mode: 'subscribe', tokenParam: 'hub.verify_token', challengeParam: 'hub.challenge' },
    },
  },
};

function build(): Readonly<Record<WebhookFormatId, WebhookFormat>> {
  const out = {} as Record<WebhookFormatId, WebhookFormat>;
  for (const id of WEBHOOK_FORMAT_IDS) {
    // A description that fails its own schema is a bug of ours: the daemon
    // must not boot with a format weaker than the contract.
    const scheme = WebhookSchemeSchema.parse(RAW[id].scheme);
    out[id] = Object.freeze({ id, label: RAW[id].label, scheme: deepFreeze(scheme), level: schemeLevel(scheme) });
  }
  return Object.freeze(out);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** Frozen: no code path, plugin or not, can replace a shipped format. */
export const WEBHOOK_FORMATS = build();

export function webhookFormat(id: string): WebhookFormat | null {
  return Object.hasOwn(WEBHOOK_FORMATS, id) ? WEBHOOK_FORMATS[id as WebhookFormatId] : null;
}

/**
 * The id a format declared by a plugin pack would get, once that opening
 * exists: owned by its plugin, never a bare core id.
 */
export function scopedWebhookFormatId(pluginSlug: string, name: string): string {
  return `${pluginSlug}:${name}`;
}
