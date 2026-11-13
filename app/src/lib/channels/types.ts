export type ChannelType = 'telegram' | 'webhook' | 'discord' | 'whatsapp-cloud' | 'whatsapp-web';

export type TelegramChannelConfig = {
  type: 'telegram';
  bot_token_env: string;
  default_agent: string;
  /** Optional scoped daemon API token for this channel (service identity). */
  api_token_env?: string;
  agent_routing?: Record<string, string>;
  allowed_chat_ids?: number[];
};

export type WebhookChannelConfig = {
  type: 'webhook';
  hmac_secret_env: string;
  hmac_header?: string; // default: x-rooks-signature
  hmac_prefix?: string; // default: "" ; e.g. "sha256=" for GitHub
  default_agent: string;
  /** Optional scoped daemon API token for this channel (service identity). */
  api_token_env?: string;
  agent_routing?: Record<string, string>;
  reply_url?: string; // optional callback for replies
  reply_token_env?: string; // optional bearer for reply callback
};

export type DiscordChannelConfig = {
  type: 'discord';
  bot_token_env: string;
  default_agent: string;
  /** Optional scoped daemon API token for this channel (service identity). */
  api_token_env?: string;
  agent_routing?: Record<string, string>;
};

/**
 * WhatsApp Business Cloud API (official Meta Graph).
 * User brings their own token + phone-number ID. Meta webhooks reach this
 * machine only through a **local tunnel** the user runs (cloudflared / ngrok);
 * Rooks does not host a public webhook endpoint.
 */
export type WhatsAppCloudChannelConfig = {
  type: 'whatsapp-cloud';
  access_token_env: string;
  phone_number_id: string;
  /** Meta hub.verify_token for the GET challenge. */
  verify_token_env: string;
  /** Optional app secret for X-Hub-Signature-256 on POST. */
  app_secret_env?: string;
  default_agent: string;
  api_token_env?: string;
  agent_routing?: Record<string, string>;
  /** Optional E.164 allowlist (digits only, no +). Empty = allow all. */
  allowed_from?: string[];
  /** Graph API version, default v21.0. */
  graph_version?: string;
};

/**
 * Local WhatsApp Web linked-device session (Baileys or equivalent).
 * Session files stay on this machine. Unofficial — ban / ToS risk.
 */
export type WhatsAppWebChannelConfig = {
  type: 'whatsapp-web';
  /** Shared secret used by the local worker to sign inbound posts. */
  worker_secret_env: string;
  default_agent: string;
  api_token_env?: string;
  agent_routing?: Record<string, string>;
  /** Session directory under ROOKS_HOME (default: channels/whatsapp-web-session). */
  session_dir?: string;
  allowed_from?: string[];
};

export type ChannelConfig =
  | TelegramChannelConfig
  | WebhookChannelConfig
  | DiscordChannelConfig
  | WhatsAppCloudChannelConfig
  | WhatsAppWebChannelConfig;

/** Normalized inbound message handed to the router. */
export type InboundMessage = {
  channel: string;
  externalId?: string;
  text: string;
  attachments?: { name: string; path: string }[];
  /** Channel-specific reply context (chat_id, callback url, etc.). */
  replyContext: unknown;
  /** Raw payload for audit. */
  raw?: unknown;
};
