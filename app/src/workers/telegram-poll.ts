/**
 * Long-polls Telegram for every configured channel of type "telegram" and
 * forwards each message as a normalized envelope to /api/channels/<name>/inbound.
 *
 * Run with:  npm run worker:telegram
 */
import { channelStore } from '../lib/channels/store';
import { telegramHeaders } from '../lib/channels/inbound';
import { listChannels, requireEnv } from '../lib/channels/config';
import { downloadFile, getUpdates, type TelegramMessage } from '../lib/channels/telegram-api';
import type { TelegramChannelConfig } from '../lib/channels/types';

const APP_BASE = process.env.APP_URL ?? process.env.CHANNELS_URL ?? 'http://localhost:3100';

async function forward(channelName: string, message: TelegramMessage): Promise<void> {
  // Persist attachments with the receipt data so they survive worker restarts.
  const token = requireEnv(loadCfg(channelName).bot_token_env);
  const attachments: { name: string; path: string }[] = [];
  if (message.document?.file_id) {
    const path = await downloadFile(token, message.document.file_id, message.document.file_name ?? 'document');
    attachments.push({ name: message.document.file_name ?? 'document', path });
  }
  if (message.photo && message.photo.length > 0) {
    const biggest = message.photo[message.photo.length - 1]!;
    const path = await downloadFile(token, biggest.file_id, 'photo.jpg');
    attachments.push({ name: 'photo.jpg', path });
  }
  if (message.voice?.file_id) {
    const path = await downloadFile(token, message.voice.file_id, 'voice.ogg');
    attachments.push({ name: 'voice.ogg', path });
  }

  const augmented: TelegramMessage = { ...message };
  if (attachments.length > 0) {
    const note = `\n\n[attached files: ${attachments.map((a) => a.path).join(', ')}]`;
    augmented.text = (augmented.text ?? augmented.caption ?? '') + note;
  }

  if (!(augmented.text ?? augmented.caption ?? '').trim()) {
    console.warn('[telegram-poll] unsupported message without text or attachment ignored');
    return;
  }
  const body = JSON.stringify({ message: augmented });
  const res = await fetch(`${APP_BASE}/api/channels/${channelName}/inbound`, {
    method: 'POST',
    headers: telegramHeaders(body, token), body, signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`inbound rejected ${res.status}`);
}

function loadCfg(name: string): TelegramChannelConfig {
  const found = listChannels().find((c) => c.name === name);
  if (!found || found.config.type !== 'telegram') throw new Error(`channel ${name} is not telegram`);
  return found.config;
}

async function runOne(name: string, cfg: TelegramChannelConfig): Promise<void> {
  const token = requireEnv(cfg.bot_token_env);
  let offset = channelStore().cursor(name);
  console.log(`[telegram-poll] starting for channel "${name}"`);
  while (true) {
    try {
      const updates = await getUpdates(token, offset, 30);
      for (const u of updates) {
        if (!u.message) { offset = u.update_id + 1; channelStore().setCursor(name, offset); continue; }
        if (cfg.allowed_chat_ids?.length && !cfg.allowed_chat_ids.includes(u.message.chat.id)) {
          console.warn(`[telegram-poll] ignored chat ${u.message.chat.id} (not in allowlist)`);
          offset = u.update_id + 1; channelStore().setCursor(name, offset);
          continue;
        }
        await forward(name, u.message);
        offset = u.update_id + 1;
        channelStore().setCursor(name, offset);
      }
    } catch (err) {
      // Fetch errors can contain the bot token in their URL.
      console.error('[telegram-poll] transfer failed; cursor retained for retry');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main(): Promise<void> {
  const telegrams = listChannels().filter(
    (c): c is { name: string; config: TelegramChannelConfig } => c.config.type === 'telegram',
  );
  if (telegrams.length === 0) {
    console.log('[telegram-poll] no telegram channels configured — idling');
    // Keep the process alive (active handle) so the container doesn't churn
    // through restarts. Operators can `docker compose restart` this service
    // after adding a channel config.
    setInterval(() => {}, 1 << 30);
    return;
  }
  await Promise.all(telegrams.map((c) => runOne(c.name, c.config)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
