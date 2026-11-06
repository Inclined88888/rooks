import { createHmac, createHash } from 'node:crypto';
import { requireEnv } from './config';
import { verifyHmac } from './hmac';
import { isAllowedChat } from './transports/telegram';
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
  return { 'content-type': 'application/json', 'x-timon-timestamp': timestamp,
    'x-timon-signature': createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex') };
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeInbound(name: string, cfg: ChannelConfig, raw: string, headers: Headers, now = Date.now()): InboundMessage {
  if (cfg.type === 'discord') throw new InboundError(501, 'discord not implemented');
  if (cfg.type === 'telegram') {
    const timestamp = headers.get('x-timon-timestamp') ?? '';
    if (!/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 5 * 60_000
      || !verifyHmac(requireEnv(cfg.bot_token_env), `${timestamp}.${raw}`, headers.get('x-timon-signature'))) {
      throw new InboundError(401, 'invalid worker signature');
    }
  } else if (!verifyHmac(requireEnv(cfg.hmac_secret_env), raw, headers.get(cfg.hmac_header ?? 'x-timon-signature'), cfg.hmac_prefix ?? '')) {
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
