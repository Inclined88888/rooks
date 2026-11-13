/**
 * Browser-safe WhatsApp Web copy — no Node / Baileys imports.
 * Keep in sync with Settings locale keys under channelsSettings.web.risk*.
 */
export const WHATSAPP_WEB_RISKS = [
  'Unofficial WhatsApp Web protocol (Baileys) — not a Meta Business product.',
  'Linked-device sessions can be banned or rate-limited by WhatsApp without notice.',
  'Session files stay on this machine; anyone with disk access can read the chat link.',
  'Prefer WhatsApp Business Cloud API for production / shared numbers.',
] as const;
