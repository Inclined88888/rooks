import { loadChannelConfig } from './config';
import { replyTelegram, type TelegramReplyContext } from './transports/telegram';
import { replyWebhook, type WebhookReplyContext } from './transports/webhook';
import { replyWhatsAppCloud, type WhatsAppCloudReplyContext } from './transports/whatsapp-cloud';
import { replyWhatsAppWeb, type WhatsAppWebReplyContext } from './transports/whatsapp-web';

export async function dispatchReply(args: {
  channelName: string;
  replyContext: unknown;
  text: string;
  missionId: string;
  startPart?: number;
  onPart?: (nextPart: number) => void;
}): Promise<void> {
  const cfg = loadChannelConfig(args.channelName);
  if (!cfg) {
    throw new Error('reply channel unavailable');
  }
  switch (cfg.type) {
    case 'telegram':
      await replyTelegram(cfg, args.replyContext as TelegramReplyContext, args.text, { startPart: args.startPart, onPart: args.onPart });
      return;
    case 'webhook':
      await replyWebhook(cfg, args.replyContext as WebhookReplyContext, args.text, args.missionId);
      return;
    case 'whatsapp-cloud':
      await replyWhatsAppCloud(cfg, args.replyContext as WhatsAppCloudReplyContext, args.text, { startPart: args.startPart, onPart: args.onPart });
      return;
    case 'whatsapp-web':
      await replyWhatsAppWeb(cfg, args.replyContext as WhatsAppWebReplyContext, args.text);
      args.onPart?.(1);
      return;
    case 'discord':
      throw new Error('discord not implemented');
  }
}
