import { requireEnv } from '../config';
import { sendMessage, type DeliveryProgress } from '../telegram-api';
import type { TelegramChannelConfig } from '../types';

export type TelegramReplyContext = { chat_id: number; user_id?: number };

export async function replyTelegram(
  cfg: TelegramChannelConfig,
  ctx: TelegramReplyContext,
  text: string,
  progress?: DeliveryProgress,
): Promise<void> {
  const token = requireEnv(cfg.bot_token_env);
  await sendMessage(token, ctx.chat_id, text, progress);
}

export function isAllowedChat(cfg: TelegramChannelConfig, chatId: number): boolean {
  if (!cfg.allowed_chat_ids || cfg.allowed_chat_ids.length === 0) return true;
  return cfg.allowed_chat_ids.includes(chatId);
}
