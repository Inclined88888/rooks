import { requireEnv } from './config';
import type { WhatsAppCloudChannelConfig } from './types';

export type DeliveryProgress = {
  startPart?: number;
  onPart?: (nextPart: number) => void;
};

const GRAPH = (version: string) => `https://graph.facebook.com/${version}`;

/** WhatsApp Cloud text messages are capped near 4096 characters. */
const CHUNK = 4000;

export async function sendWhatsAppCloudMessage(
  cfg: WhatsAppCloudChannelConfig,
  to: string,
  text: string,
  progress?: DeliveryProgress,
): Promise<void> {
  const token = requireEnv(cfg.access_token_env);
  const version = cfg.graph_version ?? 'v21.0';
  const url = `${GRAPH(version)}/${encodeURIComponent(cfg.phone_number_id)}/messages`;
  const parts = chunkText(text, CHUNK);
  const start = progress?.startPart ?? 0;
  for (let i = start; i < parts.length; i += 1) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { preview_url: false, body: parts[i] },
      }),
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    if (!res.ok) throw new Error(`whatsapp cloud sendMessage ${res.status}`);
    progress?.onPart?.(i + 1);
  }
}

export function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts;
}

export type WhatsAppCloudInbound = {
  from: string;
  messageId: string;
  text: string;
  raw: unknown;
};

/** Pull the first text message out of a Meta webhook body. */
export function extractWhatsAppCloudMessage(payload: unknown): WhatsAppCloudInbound | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const entry = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entry)) return null;
  for (const item of entry) {
    if (!item || typeof item !== 'object') continue;
    const changes = (item as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      if (!change || typeof change !== 'object') continue;
      const value = (change as { value?: unknown }).value;
      if (!value || typeof value !== 'object') continue;
      const messages = (value as { messages?: unknown }).messages;
      if (!Array.isArray(messages)) continue;
      for (const msg of messages) {
        if (!msg || typeof msg !== 'object') continue;
        const m = msg as Record<string, unknown>;
        const from = typeof m.from === 'string' ? m.from : '';
        const messageId = typeof m.id === 'string' ? m.id : '';
        const textObj = m.text;
        const text = textObj && typeof textObj === 'object' && typeof (textObj as { body?: unknown }).body === 'string'
          ? (textObj as { body: string }).body
          : typeof m.caption === 'string' ? m.caption : '';
        if (!from || !messageId || !text.trim()) continue;
        return { from, messageId, text, raw: msg };
      }
    }
  }
  return null;
}
