import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHANNELS_DIR } from '../../paths';
import { requireEnv } from '../config';
import type { WhatsAppWebChannelConfig } from '../types';
import { isAllowedWhatsAppFrom } from './whatsapp-cloud';

export type WhatsAppWebReplyContext = { jid: string };

export type WhatsAppWebStatus = {
  state: 'idle' | 'qr' | 'connecting' | 'open' | 'close' | 'error';
  qrDataUrl?: string;
  message?: string;
  updatedAt: number;
};

export function whatsappWebStatusPath(channelName: string): string {
  return join(CHANNELS_DIR, `${channelName}.status.json`);
}

export function readWhatsAppWebStatus(channelName: string): WhatsAppWebStatus | null {
  const path = whatsappWebStatusPath(channelName);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as WhatsAppWebStatus;
  } catch {
    return null;
  }
}

export function writeWhatsAppWebStatus(channelName: string, status: WhatsAppWebStatus): void {
  mkdirSync(CHANNELS_DIR, { recursive: true });
  writeFileSync(whatsappWebStatusPath(channelName), `${JSON.stringify(status)}\n`, { mode: 0o600 });
}

/**
 * Outbound for the linked-device path. The Baileys worker listens on a local
 * IPC file / HTTP loopback is intentionally avoided: replies are posted by
 * writing a pending-reply JSON the worker drains. For tests and the first cut,
 * we also support an optional in-process sender hook.
 */
export type WhatsAppWebSender = (
  cfg: WhatsAppWebChannelConfig,
  jid: string,
  text: string,
) => Promise<void>;

let senderHook: WhatsAppWebSender | null = null;

export function setWhatsAppWebSenderForTests(hook: WhatsAppWebSender | null): void {
  senderHook = hook;
}

export async function replyWhatsAppWeb(
  cfg: WhatsAppWebChannelConfig,
  ctx: WhatsAppWebReplyContext,
  text: string,
): Promise<void> {
  if (!ctx?.jid || typeof ctx.jid !== 'string') throw new Error('whatsapp web reply missing jid');
  if (senderHook) {
    await senderHook(cfg, ctx.jid, text);
    return;
  }
  // Queue a reply for the Baileys worker (local file under CHANNELS_DIR).
  requireEnv(cfg.worker_secret_env); // ensure configured
  const dir = join(CHANNELS_DIR, 'whatsapp-web-outbox');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, `${JSON.stringify({ jid: ctx.jid, text, session_dir: cfg.session_dir ?? null })}\n`, { mode: 0o600 });
}

export { isAllowedWhatsAppFrom };
