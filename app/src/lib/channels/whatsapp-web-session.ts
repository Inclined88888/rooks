/**
 * Baileys (WhatsApp Web linked-device) session helpers.
 *
 * The real socket lives in `workers/whatsapp-web.ts`. This module keeps pure
 * helpers + a narrow factory so unit tests never open a WhatsApp connection.
 */
import { join } from 'node:path';
import { ROOKS_HOME } from '../paths';

export type WhatsAppWebAuthState = {
  /** Relative or absolute session directory. */
  sessionDir: string;
};

export function resolveSessionDir(configured?: string | null): string {
  if (configured && configured.trim()) {
    return configured.startsWith('/') ? configured : join(ROOKS_HOME, configured);
  }
  return join(ROOKS_HOME, 'channels', 'whatsapp-web-session');
}

/** Risk copy shown next to QR pairing — keep in sync with Settings UI locales. */
export const WHATSAPP_WEB_RISKS = [
  'Unofficial WhatsApp Web protocol (Baileys) — not a Meta Business product.',
  'Linked-device sessions can be banned or rate-limited by WhatsApp without notice.',
  'Session files stay on this machine; anyone with disk access can read the chat link.',
  'Prefer WhatsApp Business Cloud API for production / shared numbers.',
] as const;

export type BaileysLike = {
  makeWASocket: (opts: Record<string, unknown>) => unknown;
  useMultiFileAuthState: (dir: string) => Promise<{ state: unknown; saveCreds: () => Promise<void> }>;
  DisconnectReason: Record<string, number>;
  fetchLatestBaileysVersion: () => Promise<{ version: number[] }>;
};

/** Dynamic import so the Next server bundle does not pull Baileys. */
export async function loadBaileys(): Promise<BaileysLike> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import('@whiskeysockets/baileys');
    return {
      makeWASocket: mod.default ?? mod.makeWASocket,
      useMultiFileAuthState: mod.useMultiFileAuthState,
      DisconnectReason: mod.DisconnectReason ?? {},
      fetchLatestBaileysVersion: mod.fetchLatestBaileysVersion ?? (async () => ({ version: [2, 3000, 0] })),
    };
  } catch (error) {
    throw new Error(`Baileys is not installed: ${(error as Error).message}`);
  }
}
