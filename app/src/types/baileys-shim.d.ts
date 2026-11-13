declare module '@whiskeysockets/baileys' {
  const Baileys: unknown;
  export default Baileys;
  export function makeWASocket(opts: Record<string, unknown>): unknown;
  export function useMultiFileAuthState(dir: string): Promise<{ state: unknown; saveCreds: () => Promise<void> }>;
  export const DisconnectReason: Record<string, number>;
  export function fetchLatestBaileysVersion(): Promise<{ version: number[] }>;
}
