import type { DeliveryProgress } from '../whatsapp-cloud-api';
import { sendWhatsAppCloudMessage } from '../whatsapp-cloud-api';
import type { WhatsAppCloudChannelConfig } from '../types';

export type WhatsAppCloudReplyContext = { from: string };

export async function replyWhatsAppCloud(
  cfg: WhatsAppCloudChannelConfig,
  ctx: WhatsAppCloudReplyContext,
  text: string,
  progress?: DeliveryProgress,
): Promise<void> {
  if (!ctx?.from || typeof ctx.from !== 'string') throw new Error('whatsapp cloud reply missing from');
  await sendWhatsAppCloudMessage(cfg, ctx.from, text, progress);
}

export function isAllowedWhatsAppFrom(cfg: { allowed_from?: string[] }, from: string): boolean {
  if (!cfg.allowed_from || cfg.allowed_from.length === 0) return true;
  const digits = from.replace(/\D/g, '');
  return cfg.allowed_from.some((allowed) => allowed === digits || allowed === from);
}
