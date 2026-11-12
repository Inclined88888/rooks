export type ChannelType = 'telegram' | 'webhook' | 'discord';

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
  hmac_prefix?: string; // e.g. "sha256=" for GitHub
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

export type ChannelConfig =
  | TelegramChannelConfig
  | WebhookChannelConfig
  | DiscordChannelConfig;

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
