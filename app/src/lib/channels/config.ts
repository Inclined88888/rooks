import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { CHANNELS_DIR, ROOKS_HOME } from '../paths';
import type { ChannelConfig } from './types';

const CHANNEL_TYPES = new Set(['telegram', 'webhook', 'discord', 'whatsapp-cloud', 'whatsapp-web']);
const ENV_KEY = /^[A-Z_a-z][A-Z_a-z0-9]*$/;
const PHONE_ID = /^\d{5,32}$/;
const E164_DIGITS = /^\d{6,20}$/;

export function loadChannelConfig(name: string): ChannelConfig | null {
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,63}$/.test(name)) return null;
  const path = join(CHANNELS_DIR, `${name}.json`);
  if (!existsSync(path)) return null;
  return validateChannelConfig(JSON.parse(readFileSync(path, 'utf8')));
}

export function listChannels(): { name: string; config: ChannelConfig }[] {
  if (!existsSync(CHANNELS_DIR)) return [];
  return readdirSync(CHANNELS_DIR)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.status.json'))
    .flatMap((f) => {
      const name = f.replace(/\.json$/, '');
      try {
        return [{ name, config: validateChannelConfig(JSON.parse(readFileSync(join(CHANNELS_DIR, f), 'utf8'))) }];
      } catch {
        return [];
      }
    });
}

export function requireEnv(key: string): string {
  const v = process.env[key] ?? readSecretsEnv()[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

/** Best-effort read of `~/.rooks/secrets.env` when process.env was not seeded. */
function readSecretsEnv(): Record<string, string> {
  const file = join(ROOKS_HOME, 'secrets.env');
  if (!existsSync(file)) return {};
  try {
    return parseEnvFile(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.replace(/^\uFEFF/, '').split('\n')) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('export ')) trimmed = trimmed.slice(7).trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!ENV_KEY.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Upsert keys into `~/.rooks/secrets.env` (0600) and mirror into process.env. */
export function upsertSecretsEnv(entries: Record<string, string>, file = join(ROOKS_HOME, 'secrets.env')): void {
  const existing = existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {};
  const merged = { ...existing, ...entries };
  const body = Object.entries(merged)
    .filter(([k, v]) => ENV_KEY.test(k) && typeof v === 'string' && v.length > 0)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join('\n') + '\n';
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, body, { mode: 0o600 });
  for (const [k, v] of Object.entries(entries)) {
    if (ENV_KEY.test(k) && v) process.env[k] = v;
  }
}

export function saveChannelConfig(name: string, config: ChannelConfig): void {
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,63}$/.test(name)) throw new Error('invalid channel name');
  const validated = validateChannelConfig(config);
  mkdirSync(CHANNELS_DIR, { recursive: true });
  writeFileSync(join(CHANNELS_DIR, `${name}.json`), `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
}

export function deleteChannelConfig(name: string): boolean {
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,63}$/.test(name)) return false;
  const path = join(CHANNELS_DIR, `${name}.json`);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

function envKey(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ENV_KEY.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`invalid ${label}`);
  return value;
}

function optionalAllowedFrom(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !E164_DIGITS.test(v))) {
    throw new Error('invalid allowed_from');
  }
  return value as string[];
}

export function validateChannelConfig(value: unknown): ChannelConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid channel configuration');
  const cfg = value as Record<string, unknown>;
  const type = String(cfg.type);
  if (!CHANNEL_TYPES.has(type) || typeof cfg.default_agent !== 'string' || !cfg.default_agent.trim()) {
    throw new Error('invalid channel type or agent');
  }
  if (cfg.agent_routing !== undefined && (!cfg.agent_routing || typeof cfg.agent_routing !== 'object' || Array.isArray(cfg.agent_routing) || Object.values(cfg.agent_routing).some(v => typeof v !== 'string' || !v.trim()))) {
    throw new Error('invalid channel routing');
  }
  if (cfg.api_token_env !== undefined) envKey(cfg.api_token_env, 'api_token_env');

  if (type === 'whatsapp-cloud') {
    envKey(cfg.access_token_env, 'access_token_env');
    envKey(cfg.verify_token_env, 'verify_token_env');
    if (typeof cfg.phone_number_id !== 'string' || !PHONE_ID.test(cfg.phone_number_id)) throw new Error('invalid phone_number_id');
    if (cfg.app_secret_env !== undefined) envKey(cfg.app_secret_env, 'app_secret_env');
    optionalAllowedFrom(cfg.allowed_from);
    if (cfg.graph_version !== undefined) {
      if (typeof cfg.graph_version !== 'string' || !/^v\d+(\.\d+)?$/.test(cfg.graph_version)) throw new Error('invalid graph_version');
    }
    return cfg as ChannelConfig;
  }

  if (type === 'whatsapp-web') {
    envKey(cfg.worker_secret_env, 'worker_secret_env');
    optionalAllowedFrom(cfg.allowed_from);
    optionalString(cfg.session_dir, 'session_dir');
    return cfg as ChannelConfig;
  }

  const secret = type === 'webhook' ? cfg.hmac_secret_env : cfg.bot_token_env;
  if (typeof secret !== 'string' || !ENV_KEY.test(secret)) throw new Error('invalid channel secret environment key');
  if (cfg.allowed_chat_ids !== undefined && (!Array.isArray(cfg.allowed_chat_ids) || cfg.allowed_chat_ids.some(v => !Number.isSafeInteger(v)))) throw new Error('invalid allowed chat ids');
  for (const key of ['reply_url', 'reply_token_env', 'hmac_header', 'hmac_prefix']) if (cfg[key] !== undefined && typeof cfg[key] !== 'string') throw new Error(`invalid ${key}`);
  if (typeof cfg.reply_url === 'string') {
    const url = new URL(cfg.reply_url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('invalid callback URL');
  }
  return cfg as ChannelConfig;
}
