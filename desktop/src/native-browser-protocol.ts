import { randomBytes, timingSafeEqual } from 'node:crypto';

export const BROWSER_ATTACH_CHANNEL = 'timon:browser-attach';
export const BROWSER_DETACH_CHANNEL = 'timon:browser-detach';
export const BROWSER_PROMPT_CHANNEL = 'timon:native-browser-prompt';
// Recorder (TODO #461): the tab preload asks the state once per document, the main process flips it,
// and steps come back one event at a time. The preload repeats these names (it can import nothing).
export const BROWSER_RECORD_STATE_CHANNEL = 'timon:record-state';
export const BROWSER_RECORD_TOGGLE_CHANNEL = 'timon:record-toggle';
export const BROWSER_RECORD_EVENT_CHANNEL = 'timon:record-event';
// Annotator (TODO #468): same shape, plus a point request the main process relays from the PWA
// (`annotatePick {x, y}`) to the preload of the annotated tab, which answers on the event channel.
export const BROWSER_ANNOTATE_STATE_CHANNEL = 'timon:annotate-state';
export const BROWSER_ANNOTATE_TOGGLE_CHANNEL = 'timon:annotate-toggle';
export const BROWSER_ANNOTATE_EVENT_CHANNEL = 'timon:annotate-event';
export const BROWSER_ANNOTATE_PICK_AT_CHANNEL = 'timon:annotate-pick-at';
export const DEFAULT_VIEWPORT = { width: 1366, height: 768, mobile: false };
export const BROWSER_FILE_CHUNK_BYTES = 128 * 1024;
export const BROWSER_MAX_FILE_BYTES = 100 * 1024 * 1024;

/** Display names are never usable as paths on the browser host. */
export function browserFileName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 180
    || /[\x00-\x1f\x7f/\\<>:"|?*]/.test(value) || /[. ]$/.test(value)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw new BrowserCommandError('Invalid browser file name.');
  }
  return value;
}

export function browserFileChunk(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(BROWSER_FILE_CHUNK_BYTES / 3) * 4
    || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new BrowserCommandError('Invalid browser file chunk.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > BROWSER_FILE_CHUNK_BYTES || bytes.toString('base64') !== value) {
    throw new BrowserCommandError('Invalid browser file chunk.');
  }
  return bytes;
}

export class BrowserCommandError extends Error {
  constructor(message: string, public readonly statusCode = 400) { super(message); }
}

export function profileIdOf(value: unknown): string {
  // macOS/Windows profile directories may be case insensitive: two IDs must never alias.
  if (typeof value !== 'string' || !/^[a-z0-9_-]{1,128}$/.test(value)) {
    throw new BrowserCommandError('Invalid browser profile ID.');
  }
  return value;
}

export function objectOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BrowserCommandError('Expected a JSON object.');
  }
  return value as Record<string, unknown>;
}

export function viewportOf(value: Record<string, unknown>): typeof DEFAULT_VIEWPORT {
  const { width, height, mobile } = value;
  if (!Number.isInteger(width) || (width as number) < 240 || (width as number) > 3840
    || !Number.isInteger(height) || (height as number) < 240 || (height as number) > 2160
    || typeof mobile !== 'boolean') {
    throw new BrowserCommandError('Viewport must be 240–3840 × 240–2160 with a mobile flag.');
  }
  return { width: width as number, height: height as number, mobile };
}

/** Navigation never opens OS handlers or exposes files on the browser host. */
export function browserUrlOf(value: unknown): string {
  if (value === 'about:blank') return value;
  if (typeof value !== 'string' || value.length > 16_384) throw new BrowserCommandError('Invalid browser URL.');
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch { /* Report one public validation error. */ }
  throw new BrowserCommandError('Only HTTP and HTTPS sites can be opened.');
}

export function authorizedBearer(header: string | undefined, token: string): boolean {
  const supplied = Buffer.from(header ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function trustedBrowserSender(
  sender: { isWindow: boolean; isMainFrame: boolean; url: string }, uiOrigin: string,
): boolean {
  try {
    return sender.isWindow && sender.isMainFrame
      && new URL(sender.url).origin === new URL(uiOrigin).origin;
  } catch { return false; }
}

/** Tickets grant presentation only; the provider token never enters the renderer. */
export class BrowserPresentationTickets {
  private readonly tickets = new Map<string, { profileId: string; expiresAt: number }>();
  constructor(private readonly now = Date.now) {}

  issue(profileId: string): string {
    for (const [token, ticket] of this.tickets) {
      if (ticket.expiresAt <= this.now()) this.tickets.delete(token);
    }
    if (this.tickets.size >= 256) this.tickets.delete(this.tickets.keys().next().value!);
    const token = randomBytes(24).toString('hex');
    this.tickets.set(token, { profileId: profileIdOf(profileId), expiresAt: this.now() + 60_000 });
    return token;
  }

  permits(profileId: string, token: unknown): boolean {
    const ticket = typeof token === 'string' ? this.tickets.get(token) : undefined;
    return !!ticket && ticket.profileId === profileId && ticket.expiresAt > this.now();
  }

  expiresAt(token: string): number { return this.tickets.get(token)?.expiresAt ?? 0; }

  revoke(profileId: string): void {
    for (const [token, ticket] of this.tickets) {
      if (ticket.profileId === profileId) this.tickets.delete(token);
    }
  }
}
