/**
 * HTML documents of a conversation (MCPUI, docs/ADR-MCPUI.md), as the client
 * receives them.
 *
 * The mission's events carry `ui_document` and `ui_document_resolved`: an id,
 * a status, a title, never the HTML nor the reply (D7). The card reads the
 * view through the session route and loads the HTML from the Rooks origin,
 * into an iframe sandboxed without `allow-same-origin` — never an address a
 * payload carries.
 *
 * Every payload is validated here, field by field: data from the stream is
 * not trusted to be what the daemon wrote. `app/` has no zod (D5, D12).
 */

export const UI_DOCUMENT_EVENT = 'ui_document';
export const UI_DOCUMENT_RESOLVED_EVENT = 'ui_document_resolved';
export const UI_DOCUMENTS_MODULE = '@rooks/ui-documents';

export const MIN_DOCUMENT_HEIGHT = 80;
export const MAX_DOCUMENT_HEIGHT = 2000;
/** The daemon's bound on a reply (D7); checked here first so the card can say why. */
export const MAX_REPLY_BYTES = 16 * 1024;
/** `ui/message`: text only, at most this many characters (D5). */
export const MAX_MESSAGE_CHARS = 4000;

export type UiDocumentStatus = 'shown' | 'pending' | 'answered' | 'dismissed' | 'expired';
export type UiDocumentBridge = 'rooks' | 'raw';
export type UiDocumentOriginKind = 'agent' | 'user' | 'plugin';

/** What the conversation keeps of a document: enough to draw the card. */
export type UiDocumentBlock = {
  id: string;
  title: string;
  status: UiDocumentStatus;
  origin: { kind: UiDocumentOriginKind; id: string | null };
  bridge: UiDocumentBridge;
  /** The creator's hint for the first paint, 80–2000; null = the default. */
  height: number | null;
  expectsReply: boolean;
  createdAt: number | null;
  resolvedAt?: number | null;
};

export type UiDocumentResolution = {
  id: string;
  status: 'answered' | 'dismissed';
  resolvedAt: number | null;
};

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUSES: ReadonlySet<string> = new Set(['shown', 'pending', 'answered', 'dismissed']);
const ORIGINS: ReadonlySet<string> = new Set(['agent', 'user', 'plugin']);
const MAX_TITLE = 120;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseOrigin(value: unknown): UiDocumentBlock['origin'] | null {
  const o = record(value);
  if (!o || typeof o.kind !== 'string' || !ORIGINS.has(o.kind)) return null;
  if (o.id !== null && o.id !== undefined && (typeof o.id !== 'string' || o.id.length > 200)) return null;
  return { kind: o.kind as UiDocumentOriginKind, id: typeof o.id === 'string' ? o.id : null };
}

function parseTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const title = value.trim();
  return title && title.length <= MAX_TITLE && !CONTROL.test(title) ? title : null;
}

/** A `ui_document` event payload (or the view the route returns), or null for anything else. */
export function parseUiDocument(payload: unknown): UiDocumentBlock | null {
  const p = record(payload);
  if (!p) return null;
  const { id, status, bridge, height, expectsReply } = p;
  if (typeof id !== 'string' || !ID.test(id)) return null;
  if (typeof status !== 'string' || !STATUSES.has(status)) return null;
  const title = parseTitle(p.title);
  const origin = parseOrigin(p.origin);
  if (!title || !origin) return null;
  if (bridge !== 'rooks' && bridge !== 'raw') return null;
  let shownHeight: number | null = null;
  if (height !== null && height !== undefined) {
    if (typeof height !== 'number' || !Number.isInteger(height)) return null;
    shownHeight = clampDocumentHeight(height);
  }
  return {
    id,
    title,
    status: status as UiDocumentStatus,
    origin,
    bridge,
    height: shownHeight,
    expectsReply: expectsReply === true,
    createdAt: finiteOrNull(p.createdAt),
    ...(p.resolvedAt !== undefined ? { resolvedAt: finiteOrNull(p.resolvedAt) } : {}),
  };
}

/** A `ui_document_resolved` event payload, or null. */
export function parseUiDocumentResolved(payload: unknown): UiDocumentResolution | null {
  const p = record(payload);
  if (!p || typeof p.id !== 'string' || !ID.test(p.id)) return null;
  if (p.status !== 'answered' && p.status !== 'dismissed') return null;
  return { id: p.id, status: p.status, resolvedAt: finiteOrNull(p.resolvedAt) };
}

/** A settled card stays settled: a stale view or a replayed creation never reopens it. */
export function applyUiDocumentResolution(block: UiDocumentBlock, resolution: UiDocumentResolution): UiDocumentBlock {
  if (block.id !== resolution.id || block.status === 'answered' || block.status === 'dismissed') return block;
  return { ...block, status: resolution.status, resolvedAt: resolution.resolvedAt };
}

export function clampDocumentHeight(height: number): number {
  return Math.min(MAX_DOCUMENT_HEIGHT, Math.max(MIN_DOCUMENT_HEIGHT, Math.round(height)));
}

/** Same-origin, through the Next proxy, which relays the session cookie only.
 *  The id is validated by `parseUiDocument`; it is encoded all the same. */
export function uiDocumentUrl(id: string): string {
  return `/api/ui/ui-documents/${encodeURIComponent(id)}/document`;
}

export function uiDocumentViewUrl(id: string): string {
  return `/api/ui/ui-documents/${encodeURIComponent(id)}`;
}

export type UiDocumentLookup =
  /** `reply`: present (null until answered) when the reader may read it; `deliverable`: false when an
   *  answer given now would be kept, not transmitted (the agent's mission is over). */
  | { kind: 'found'; document: UiDocumentBlock; reply?: unknown; deliverable?: boolean }
  /** The row is gone (purged after the mission's retention): D2. */
  | { kind: 'expired' }
  /** The daemon could not be asked (network, 5xx): the card keeps what the event said. */
  | { kind: 'unknown' };

/**
 * The document as the daemon sees it now. Read BEFORE the iframe mounts: an
 * opaque origin hides the status of what it loads, so a purged document would
 * otherwise paint the daemon's raw 404 inside the card.
 */
export async function fetchUiDocument(id: string, signal?: AbortSignal): Promise<UiDocumentLookup> {
  let res: Response;
  try {
    res = await fetch(uiDocumentViewUrl(id), { cache: 'no-store', credentials: 'same-origin', signal });
  } catch {
    return { kind: 'unknown' };
  }
  if (res.status === 404) return { kind: 'expired' };
  if (!res.ok) return { kind: 'unknown' };
  const body = record(await res.json().catch(() => null));
  const view = record(body?.document);
  const document = parseUiDocument(view);
  if (!document) return { kind: 'unknown' };
  return {
    kind: 'found',
    document,
    ...(view && 'reply' in view ? { reply: view.reply } : {}),
    ...(typeof body?.deliverable === 'boolean' ? { deliverable: body.deliverable } : {}),
  };
}

/** Size of a reply as the daemon will measure it (UTF-8 of its JSON), or null when it is not JSON. */
export function replyBytes(reply: unknown): number | null {
  let text: string | undefined;
  try { text = JSON.stringify(reply); } catch { return null; }
  return typeof text === 'string' ? new TextEncoder().encode(text).length : null;
}

export type ReplyOutcome =
  | { kind: 'answered'; reply: unknown; delivered: boolean }
  | { kind: 'refused'; error: string };

/** The owner's answer, sent by the card (never by the document: its origin is opaque). */
export async function sendUiDocumentReply(id: string, reply: Record<string, unknown>): Promise<ReplyOutcome> {
  let res: Response;
  try {
    res = await fetch(`${uiDocumentViewUrl(id)}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ reply }),
    });
  } catch {
    return { kind: 'refused', error: 'network' };
  }
  const body = record(await res.json().catch(() => null));
  if (!res.ok) return { kind: 'refused', error: typeof body?.error === 'string' ? body.error : `http_${res.status}` };
  const view = record(body?.document);
  return { kind: 'answered', reply: view && 'reply' in view ? view.reply : reply, delivered: body?.delivered === true };
}

/** Closes a document without answering it. */
export async function dismissUiDocumentRequest(id: string): Promise<boolean> {
  try {
    const res = await fetch(`${uiDocumentViewUrl(id)}/dismiss`, { method: 'POST', credentials: 'same-origin' });
    return res.ok;
  } catch {
    return false;
  }
}

/** A message the document proposed, as it goes out under the owner's name: its provenance first. */
export function documentMessageText(title: string, text: string): string {
  return `[From the document "${title}"] ${text}`;
}
