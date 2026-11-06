import { writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TIMON_HOME } from '../paths';

const TG = (token: string) => `https://api.telegram.org/bot${token}`;
const TG_FILE = (token: string) => `https://api.telegram.org/file/bot${token}`;

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

export type TelegramMessage = {
  message_id: number;
  chat: { id: number };
  from?: { id: number; username?: string };
  date: number;
  text?: string;
  caption?: string;
  document?: { file_id: string; file_name?: string };
  photo?: { file_id: string; file_size?: number }[];
  voice?: { file_id: string };
};

export async function getUpdates(
  token: string,
  offset: number,
  timeoutSec = 30,
): Promise<TelegramUpdate[]> {
  const url = `${TG(token)}/getUpdates?timeout=${timeoutSec}&offset=${offset}`;
  const res = await fetch(url, { signal: AbortSignal.timeout((timeoutSec + 10) * 1000) });
  if (!res.ok) throw new Error(`telegram getUpdates ${res.status}`);
  const json = (await res.json()) as { ok: boolean; result: TelegramUpdate[] };
  if (!json.ok) throw new Error('telegram getUpdates: ok=false');
  return json.result;
}

export type DeliveryProgress = { startPart?: number; onPart?: (nextPart: number) => void };

export async function sendMessage(token: string, chatId: number, text: string, progress: DeliveryProgress = {}): Promise<void> {
  // Telegram caps messages at 4096 chars — chunk if needed.
  const chunks = chunkBy(text, 3800);
  for (let index = progress.startPart ?? 0; index < chunks.length; index++) {
    const part = chunks[index]!;
    const res = await fetch(`${TG(token)}/sendMessage`, {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: part }),
    });
    if (!res.ok) throw new Error(`telegram sendMessage ${res.status}`);
    const result = await res.json() as { ok?: boolean };
    if (!result.ok) throw new Error('telegram sendMessage failed');
    progress.onPart?.(index + 1);
  }
}

export async function downloadFile(token: string, fileId: string, name: string): Promise<string> {
  const meta = await fetch(`${TG(token)}/getFile?file_id=${encodeURIComponent(fileId)}`, { signal: AbortSignal.timeout(15_000) });
  if (!meta.ok) throw new Error(`telegram getFile ${meta.status}`);
  const metaJson = (await meta.json()) as { ok: boolean; result: { file_path: string } };
  if (!metaJson.ok || !metaJson.result?.file_path) throw new Error('telegram file unavailable');
  const path = metaJson.result.file_path;
  const bin = await fetch(`${TG_FILE(token)}/${path}`, { signal: AbortSignal.timeout(30_000) });
  if (!bin.ok) throw new Error(`telegram download ${bin.status}`);
  const reader = bin.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 20 * 1024 * 1024) { await reader.cancel(); throw new Error('telegram attachment exceeds 20 MB'); }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks);
  const dir = join(TIMON_HOME, 'channel-attachments');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${randomUUID()}-${basename(name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120)}`);
  writeFileSync(out, buf, { mode: 0o600 });
  return process.env.TIMON_CHANNEL_ATTACHMENT_HOST_DIR ? join(process.env.TIMON_CHANNEL_ATTACHMENT_HOST_DIR, basename(out)) : out;
}

function chunkBy(s: string, n: number): string[] {
  if (s.length <= n) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}
