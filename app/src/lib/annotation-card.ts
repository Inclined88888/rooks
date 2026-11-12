/**
 * The card a posted batch of browser annotations becomes in the thread (TODO #481): one line per
 * annotation, numbered like its pin on the page, with its thumbnail, the user's comment and the
 * state the agent left it in. Built from the `annotation` attachment of the `user` event and its
 * image blocks, then moved by the `annotation_status` events of the same mission.
 *
 * Everything here is typed data drawn as text nodes: the block the agent read never reaches the
 * thread, so nothing of it can be shown.
 */

import type { AnnotationAttachment, AnnotationCardItem } from '@/lib/prompt-presentation';

export type AnnotationItemState = 'sent' | 'resolved' | 'dismissed';

export type AnnotationCardLine = AnnotationCardItem & {
  /** Its thumbnail as a `data:` URL, from the image blocks of the same event. */
  thumbnail: string | null;
  state: AnnotationItemState;
  /** The agent's summary (resolved) or reason (dismissed). */
  note: string | null;
};

export type AnnotationCardView = { batchId: string; profileId: string; items: AnnotationCardLine[] };

/** The `user` event's images, as the thread may show them: a known type, the base64 alphabet only. */
export function userEventImages(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const images: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } };
    if (b.type !== 'image' || b.source?.type !== 'base64' || typeof b.source.data !== 'string' || !b.source.data) continue;
    const declared = String(b.source.media_type || 'image/png');
    const type = /^image\/(png|jpeg|gif|webp)$/.test(declared) ? declared : 'image/png';
    images.push(`data:${type};base64,${b.source.data.replace(/[^A-Za-z0-9+/=]/g, '')}`);
  }
  return images;
}

export function annotationCardView(attachment: AnnotationAttachment, images: readonly string[]): AnnotationCardView {
  return {
    batchId: attachment.batch_id,
    profileId: attachment.profile_id,
    items: attachment.items.map((item) => ({
      ...item, thumbnail: item.image === null ? null : images[item.image] ?? null, state: 'sent', note: null,
    })),
  };
}

export type AnnotationStatusChange = { batchId: string; annotationId: string; state: 'resolved' | 'dismissed'; note: string | null };

/** An `annotation_status` mission event (`relayAnnotationStatus` on the daemon), or null. */
export function readAnnotationStatus(payload: unknown): AnnotationStatusChange | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (p.type !== 'annotation_status' || typeof p.batch_id !== 'string' || typeof p.annotation_id !== 'string') return null;
  if (p.status !== 'resolved' && p.status !== 'dismissed') return null;
  const note = typeof p.note === 'string' && p.note.trim() ? p.note.trim() : null;
  return { batchId: p.batch_id, annotationId: p.annotation_id, state: p.status, note };
}

/** The card with one annotation moved; the same object when the change is not about it. */
export function applyAnnotationStatus(card: AnnotationCardView, change: AnnotationStatusChange): AnnotationCardView {
  if (card.batchId !== change.batchId) return card;
  let moved = false;
  const items = card.items.map((item) => {
    if (item.id !== change.annotationId || (item.state === change.state && item.note === change.note)) return item;
    moved = true;
    return { ...item, state: change.state, note: change.note };
  });
  return moved ? { ...card, items } : card;
}

/** How the card names a page: its title when the daemon kept one, else its origin. */
export function annotationPageLabel(item: Pick<AnnotationCardItem, 'url' | 'title'>): string {
  if (item.title.trim()) return item.title.trim();
  try {
    const url = new URL(item.url);
    return url.host || url.href;
  } catch { return item.url; }
}

/** The pages of a batch, in the order first pointed at. */
export function annotationPages(items: readonly Pick<AnnotationCardItem, 'url' | 'title'>[]): string[] {
  return [...new Set(items.map(annotationPageLabel))];
}
