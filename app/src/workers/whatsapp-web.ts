/**
 * Local WhatsApp Web linked-device worker (Baileys).
 *
 * Pairs via QR, keeps the multi-file auth state under ROOKS_HOME, forwards
 * inbound text to `/api/channels/<name>/inbound`, and drains the outbox for
 * replies. Unofficial — see WHATSAPP_WEB_RISKS.
 *
 * Run with:  npm run worker:whatsapp-web
 */
import { readdirSync, readFileSync, unlinkSync, existsSync, mkdirSync, watch } from 'node:fs';
import { join } from 'node:path';
import { channelStore } from '../lib/channels/store';
import { whatsappWebHeaders } from '../lib/channels/inbound';
import { listChannels, requireEnv } from '../lib/channels/config';
import { writeWhatsAppWebStatus } from '../lib/channels/transports/whatsapp-web';
import { loadBaileys, resolveSessionDir } from '../lib/channels/whatsapp-web-session';
import { CHANNELS_DIR } from '../lib/paths';
import type { WhatsAppWebChannelConfig } from '../lib/channels/types';

const APP_BASE = process.env.APP_URL ?? process.env.CHANNELS_URL ?? 'http://localhost:3100';
const OUTBOX = join(CHANNELS_DIR, 'whatsapp-web-outbox');

type SocketLike = {
  ev: {
    on: (event: string, cb: (...args: unknown[]) => void) => void;
  };
  sendMessage: (jid: string, content: { text: string }) => Promise<unknown>;
  end?: (err?: Error) => void;
};

async function qrDataUrl(qr: string): Promise<string> {
  // Tiny QR as a data URL without a heavy dependency: text fallback for UI.
  // The Settings UI also shows the raw pairing state; desktop builds can replace
  // this with a proper QR renderer later.
  return `data:text/plain;charset=utf-8,${encodeURIComponent(qr)}`;
}

async function forward(channelName: string, secret: string, bodyObj: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify(bodyObj);
  const res = await fetch(`${APP_BASE}/api/channels/${channelName}/inbound`, {
    method: 'POST',
    headers: whatsappWebHeaders(body, secret),
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`inbound ${res.status}`);
}

async function drainOutbox(sock: SocketLike): Promise<void> {
  if (!existsSync(OUTBOX)) return;
  for (const name of readdirSync(OUTBOX).filter((f) => f.endsWith('.json'))) {
    const path = join(OUTBOX, name);
    try {
      const row = JSON.parse(readFileSync(path, 'utf8')) as { jid?: string; text?: string };
      if (row.jid && row.text) await sock.sendMessage(row.jid, { text: row.text });
      unlinkSync(path);
    } catch (error) {
      console.error('[whatsapp-web] outbox send failed', (error as Error).message);
    }
  }
}

async function runOne(name: string, cfg: WhatsAppWebChannelConfig): Promise<void> {
  const secret = requireEnv(cfg.worker_secret_env);
  const sessionDir = resolveSessionDir(cfg.session_dir);
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(OUTBOX, { recursive: true });
  console.log(`[whatsapp-web] starting channel "${name}" session=${sessionDir}`);

  const baileys = await loadBaileys();
  const { state, saveCreds } = await baileys.useMultiFileAuthState(sessionDir);
  const { version } = await baileys.fetchLatestBaileysVersion();

  const sock = baileys.makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
  }) as SocketLike;

  sock.ev.on('creds.update', () => { void saveCreds(); });

  sock.ev.on('connection.update', (update) => {
    const u = update as { connection?: string; qr?: string; lastDisconnect?: { error?: { message?: string } } };
    void (async () => {
      if (u.qr) {
        writeWhatsAppWebStatus(name, {
          state: 'qr',
          qrDataUrl: await qrDataUrl(u.qr),
          message: 'Scan this QR in WhatsApp → Linked devices',
          updatedAt: Date.now(),
        });
      }
      if (u.connection === 'open') {
        writeWhatsAppWebStatus(name, { state: 'open', message: 'Linked', updatedAt: Date.now() });
      }
      if (u.connection === 'connecting') {
        writeWhatsAppWebStatus(name, { state: 'connecting', updatedAt: Date.now() });
      }
      if (u.connection === 'close') {
        writeWhatsAppWebStatus(name, {
          state: 'close',
          message: u.lastDisconnect?.error?.message ?? 'disconnected',
          updatedAt: Date.now(),
        });
      }
    })();
  });

  sock.ev.on('messages.upsert', (upsert) => {
    const data = upsert as { messages?: Array<Record<string, unknown>>; type?: string };
    if (data.type !== 'notify' || !Array.isArray(data.messages)) return;
    for (const msg of data.messages) {
      void (async () => {
        try {
          if (msg.key && (msg.key as { fromMe?: boolean }).fromMe) return;
          const jid = String((msg.key as { remoteJid?: string })?.remoteJid ?? '');
          const messageId = String((msg.key as { id?: string })?.id ?? '');
          const content = msg.message as Record<string, unknown> | undefined;
          const text = typeof content?.conversation === 'string'
            ? content.conversation
            : typeof (content?.extendedTextMessage as { text?: string } | undefined)?.text === 'string'
              ? (content!.extendedTextMessage as { text: string }).text
              : '';
          if (!jid || !messageId || !text.trim()) return;
          await forward(name, secret, { jid, message_id: messageId, text });
        } catch (error) {
          console.error('[whatsapp-web] forward failed', (error as Error).message);
        }
      })();
    }
  });

  // Drain outbox periodically and on file changes.
  const tick = () => { void drainOutbox(sock); };
  setInterval(tick, 2000);
  try { watch(OUTBOX, tick); } catch { /* watch optional */ }
  // Keep process alive.
  await new Promise(() => {});
}

async function main(): Promise<void> {
  // Touch the store so ROOKS_HOME exists consistently with other workers.
  channelStore();
  const webs = listChannels().filter(
    (c): c is { name: string; config: WhatsAppWebChannelConfig } => c.config.type === 'whatsapp-web',
  );
  if (webs.length === 0) {
    console.log('[whatsapp-web] no whatsapp-web channels configured — idling');
    await new Promise(() => {});
    return;
  }
  await Promise.all(webs.map((c) => runOne(c.name, c.config)));
}

main().catch((error) => {
  console.error('[whatsapp-web] worker failed', error);
  process.exitCode = 1;
});
