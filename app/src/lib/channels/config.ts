import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CHANNELS_DIR } from '../paths';
import type { ChannelConfig } from './types';

export function loadChannelConfig(name: string): ChannelConfig | null {
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,63}$/.test(name)) return null;
  const path = join(CHANNELS_DIR, `${name}.json`);
  if (!existsSync(path)) return null;
  return validateChannelConfig(JSON.parse(readFileSync(path, 'utf8')));
}

export function listChannels(): { name: string; config: ChannelConfig }[] {
  if (!existsSync(CHANNELS_DIR)) return [];
  return readdirSync(CHANNELS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const name = f.replace(/\.json$/, '');
      return { name, config: validateChannelConfig(JSON.parse(readFileSync(join(CHANNELS_DIR, f), 'utf8'))) };
    });
}

export function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

export function validateChannelConfig(value: unknown): ChannelConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid channel configuration');
  const cfg = value as Record<string, unknown>;
  if (!['telegram', 'webhook', 'discord'].includes(String(cfg.type)) || typeof cfg.default_agent !== 'string' || !cfg.default_agent.trim()) throw new Error('invalid channel type or agent');
  const secret = cfg.type === 'webhook' ? cfg.hmac_secret_env : cfg.bot_token_env;
  if (typeof secret !== 'string' || !/^[A-Z_a-z][A-Z_a-z0-9]*$/.test(secret)) throw new Error('invalid channel secret environment key');
  if (cfg.agent_routing !== undefined && (!cfg.agent_routing || typeof cfg.agent_routing !== 'object' || Array.isArray(cfg.agent_routing) || Object.values(cfg.agent_routing).some(v => typeof v !== 'string' || !v.trim()))) throw new Error('invalid channel routing');
  if (cfg.allowed_chat_ids !== undefined && (!Array.isArray(cfg.allowed_chat_ids) || cfg.allowed_chat_ids.some(v => !Number.isSafeInteger(v)))) throw new Error('invalid allowed chat ids');
  for (const key of ['api_token_env', 'reply_url', 'reply_token_env', 'hmac_header', 'hmac_prefix']) if (cfg[key] !== undefined && typeof cfg[key] !== 'string') throw new Error(`invalid ${key}`);
  if (typeof cfg.reply_url === 'string') {
    const url = new URL(cfg.reply_url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('invalid callback URL');
  }
  return cfg as ChannelConfig;
}
