import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { requireEnv } from './config';
import { verifyHmac } from './hmac';
import { isAllowedChat } from './transports/telegram';
import { extractWhatsAppCloudMessage } from './whatsapp-cloud-api';
import { isAllowedWhatsAppFrom } from './transports/whatsapp-cloud';
import type { ChannelConfig, InboundMessage } from './types';

export class InboundError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function readInboundBody(req: Request, limit = 256 * 1024): Promise<string> {
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new InboundError(413, 'payload too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function telegramHeaders(body: string, secret: string, now = Date.now()): Record<string, string> {
  const timestamp = String(now);
  return { 'content-type': 'application/json', 'x-rooks-timestamp': timestamp,
    'x-rooks-signature': createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex') };
}

/** Same worker-signing scheme Telegram uses — Baileys worker → app inbound. */
export function whatsappWebHeaders(body: string, secret: string, now = Date.now()): Record<string, string> {
  return telegramHeaders(body, secret, now);
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeEqualHex(expectedHex: string, provided: string): boolean {
  try {
    const a = Buffer.from(expectedHex, 'hex');
    const b = Buffer.from(provided, 'hex');
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Meta Cloud API webhook GET verification. */
export function verifyWhatsAppCloudChallenge(
  cfg: Extract<ChannelConfig, { type: 'whatsapp-cloud' }>,
  url: URL,
): string {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (mode !== 'subscribe' || !challenge || !token) throw new InboundError(400, 'invalid verify request');
  if (token !== requireEnv(cfg.verify_token_env)) throw new InboundError(403, 'verify token mismatch');
  return challenge;
}

function verifyMetaSignature(raw: string, headers: Headers, appSecretEnv: string | undefined): void {
  if (!appSecretEnv) return; // optional when the user has not set an app secret yet
  const header = headers.get('x-hub-signature-256') ?? '';
  const match = /^sha256=([a-f0-9]{64})$/i.exec(header);
  if (!match) throw new InboundError(401, 'invalid signature');
  const expected = createHmac('sha256', requireEnv(appSecretEnv)).update(raw).digest('hex');
  if (!safeEqualHex(expected, match[1]!.toLowerCase())) throw new InboundError(401, 'invalid signature');
}

export function normalizeInbound(name: string, cfg: ChannelConfig, raw: string, headers: Headers, now = Date.now()): InboundMessage {
  if (cfg.type === 'discord') throw new InboundError(501, 'discord not implemented');

  if (cfg.type === 'whatsapp-cloud') {
    verifyMetaSignature(raw, headers, cfg.app_secret_env);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new InboundError(400, 'invalid JSON'); }
    const msg = extractWhatsAppCloudMessage(parsed);
    if (!msg) throw new InboundError(400, 'no WhatsApp text message');
    if (!isAllowedWhatsAppFrom(cfg, msg.from)) throw new InboundError(403, 'sender not allowed');
    return {
      channel: name,
      text: msg.text,
      externalId: `whatsapp-cloud:${msg.messageId}`,
      replyContext: { from: msg.from },
      raw: msg.raw,
    };
  }

  if (cfg.type === 'whatsapp-web') {
    const timestamp = headers.get('x-rooks-timestamp') ?? '';
    if (!/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 5 * 60_000
      || !verifyHmac(requireEnv(cfg.worker_secret_env), `${timestamp}.${raw}`, headers.get('x-rooks-signature'))) {
      throw new InboundError(401, 'invalid worker signature');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new InboundError(400, 'invalid JSON'); }
    if (!record(parsed) || typeof parsed.jid !== 'string' || typeof parsed.message_id !== 'string') {
      throw new InboundError(400, 'invalid WhatsApp Web message');
    }
    const text = typeof parsed.text === 'string' ? parsed.text : '';
    if (!text.trim()) throw new InboundError(400, 'message text required');
    const fromDigits = parsed.jid.replace(/@.*/, '').replace(/\D/g, '');
    if (!isAllowedWhatsAppFrom(cfg, fromDigits)) throw new InboundError(403, 'sender not allowed');
    return {
      channel: name,
      text,
      externalId: `whatsapp-web:${parsed.message_id}`,
      replyContext: { jid: parsed.jid },
      raw: parsed,
    };
  }

  if (cfg.type === 'telegram') {
    const timestamp = headers.get('x-rooks-timestamp') ?? '';
    if (!/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 5 * 60_000
      || !verifyHmac(requireEnv(cfg.bot_token_env), `${timestamp}.${raw}`, headers.get('x-rooks-signature'))) {
      throw new InboundError(401, 'invalid worker signature');
    }
  } else if (!verifyHmac(requireEnv(cfg.hmac_secret_env), raw, headers.get(cfg.hmac_header ?? 'x-rooks-signature'), cfg.hmac_prefix ?? '')) {
    throw new InboundError(401, 'invalid signature');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new InboundError(400, 'invalid JSON'); }
  if (!record(parsed)) throw new InboundError(400, 'object payload required');
  if (cfg.type === 'telegram') {
    const msg = parsed.message;
    if (!record(msg) || !record(msg.chat) || !Number.isSafeInteger(msg.chat.id) || !Number.isSafeInteger(msg.message_id)) {
      throw new InboundError(400, 'invalid Telegram message');
    }
    if (!isAllowedChat(cfg, msg.chat.id as number)) throw new InboundError(403, 'chat not allowed');
    const text = typeof msg.text === 'string' ? msg.text : typeof msg.caption === 'string' ? msg.caption : '';
    if (!text.trim()) throw new InboundError(400, 'message text required');
    return { channel: name, text, externalId: `telegram:${msg.chat.id}:${msg.message_id}`,
      replyContext: { chat_id: msg.chat.id }, raw: msg };
  }
  // A sender cannot select where the server sends its callback credential.
  if (parsed.reply_url !== undefined && parsed.reply_url !== cfg.reply_url) throw new InboundError(400, 'reply_url must match channel configuration');
  const text = typeof parsed.text === 'string' ? parsed.text : typeof parsed.message === 'string' ? parsed.message : JSON.stringify(parsed);
  // Only signed content identifies an event; unsigned headers must not bypass replay deduplication.
  const externalId = typeof parsed.event_id === 'string' ? parsed.event_id : createHash('sha256').update(raw).digest('hex');
  if (externalId && !/^[\w.:/-]{1,200}$/.test(externalId)) throw new InboundError(400, 'invalid event id');
  return { channel: name, text, externalId: externalId ?? undefined, replyContext: {}, raw: parsed };
}
