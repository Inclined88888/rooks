/**
 * The media blocks of a chat (SUG-0008), as the client receives them.
 *
 * An agent shows an image or a video through a typed request to the daemon
 * (MCP tool `chat_show_media`, zod schema in `orchestrator/src/chat-media-block.ts`).
 * The daemon checks, fetches or copies, and keeps the bytes; the mission's
 * events then carry a `media` block naming a file of ours. The browser only
 * ever loads that file, from the Timon origin — never an address a message
 * carries, and never through markdown (`markdown.ts` renders no media at all).
 *
 * The block is validated again here, field by field: an event payload is
 * data, and data from the stream is not trusted to be what the daemon wrote.
 */

export type ChatMediaKind = 'image' | 'video';
export type ChatMediaSource = 'file' | 'url' | 'data' | 'generated';

export type ChatMediaBlock = {
  file: string;
  kind: ChatMediaKind;
  mime: string;
  source: ChatMediaSource;
  caption?: string;
  host?: string;
};

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const FILE_BY_KIND: Readonly<Record<ChatMediaKind, RegExp>> = {
  image: new RegExp(`^${UUID}\\.(?:png|jpg|gif|webp|avif)$`),
  video: new RegExp(`^${UUID}\\.(?:mp4|mov|webm|ogv)$`),
};
const MIMES: Readonly<Record<ChatMediaKind, ReadonlySet<string>>> = {
  image: new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']),
  video: new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/ogg']),
};
const SOURCES: ReadonlySet<string> = new Set(['file', 'url', 'data']);
const HOST = /^[a-z0-9.-]{1,253}$/;
const MAX_CAPTION = 300;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** A `media` event payload, or null for anything that is not exactly one. */
export function parseMediaBlock(payload: unknown): ChatMediaBlock | null {
  const p = record(payload);
  if (!p || p.type !== 'media') return null;
  const { file, kind, mime, source, caption, host } = p;
  if (kind !== 'image' && kind !== 'video') return null;
  if (typeof file !== 'string' || !FILE_BY_KIND[kind].test(file)) return null;
  if (typeof mime !== 'string' || !MIMES[kind].has(mime)) return null;
  if (typeof source !== 'string' || !SOURCES.has(source)) return null;
  if (caption !== undefined && (typeof caption !== 'string' || caption.length > MAX_CAPTION)) return null;
  if (host !== undefined && (typeof host !== 'string' || !HOST.test(host))) return null;
  return {
    file,
    kind,
    mime,
    source: source as ChatMediaSource,
    ...(caption ? { caption } : {}),
    ...(host ? { host } : {}),
  };
}

/** The images codex generated during a turn (`result.generated_media`). */
export function parseGeneratedMedia(items: unknown): ChatMediaBlock[] {
  if (!Array.isArray(items)) return [];
  const out: ChatMediaBlock[] = [];
  for (const raw of items.slice(0, 12)) {
    const item = record(raw);
    if (!item || typeof item.file !== 'string' || !FILE_BY_KIND.image.test(item.file)) continue;
    if (typeof item.mime !== 'string' || !MIMES.image.has(item.mime)) continue;
    out.push({ file: item.file, kind: 'image', mime: item.mime, source: 'generated' });
  }
  return out;
}

/** Same-origin, through the Next proxy. `file` is validated, the mission id
 *  is encoded: nothing else enters the path. */
export function chatMediaUrl(missionId: string, file: string): string {
  return `/api/ui/missions/${encodeURIComponent(missionId)}/media/${encodeURIComponent(file)}`;
}

export function chatMediaDownloadUrl(missionId: string, file: string): string {
  return `${chatMediaUrl(missionId, file)}?download=1`;
}
