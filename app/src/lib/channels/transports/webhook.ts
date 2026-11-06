import { requireEnv } from '../config';
import type { WebhookChannelConfig } from '../types';

export type WebhookReplyContext = { reply_url?: string };

export async function replyWebhook(
  cfg: WebhookChannelConfig,
  _ctx: WebhookReplyContext,
  text: string,
  missionId: string,
): Promise<void> {
  const url = cfg.reply_url;
  if (!url) return; // no callback configured — silent
  const headers: Record<string, string> = { 'content-type': 'application/json', 'idempotency-key': missionId };
  if (cfg.reply_token_env) {
    headers['authorization'] = `Bearer ${requireEnv(cfg.reply_token_env)}`;
  }
  const res = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers,
    body: JSON.stringify({ mission_id: missionId, text }),
  });
  if (!res.ok) throw new Error(`webhook reply failed: ${res.status}`);
}
