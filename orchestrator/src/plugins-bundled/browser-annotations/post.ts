/**
 * Posting a batch of browser annotations as ONE user turn of the conversation the browser is open
 * for (TODO #481): no composer in between, nothing for the user to send again.
 *
 * Two readers, two shapes. The agent reads the block of `formatBrowserAnnotations`, unchanged, with
 * the thumbnails as images of the same turn. The thread keeps what the human wrote and a typed
 * `annotation` attachment (`PromptPresentation.attachments`), drawn as a card: the block never
 * reaches the `user` event, so a reload cannot show it either.
 */
import type { BusEvent } from '../../bus.js';
import { bus } from '../../bus.js';
import { dbApi } from '../../db.js';
import type { ImageAttachment } from '../../backends/types.js';
import type { AnnotationAttachment, PromptPresentation } from '../../prompt-presentation.js';
import { formatBrowserAnnotations, type AgentAnnotationView } from '../../browser-annotation-format.js';
import { readBrowserAnnotation, readBrowserAnnotationThumbnail, type BrowserAnnotationMetadata } from '../../browser-annotations.js';

/** Thumbnails a posted turn carries as images: past it, the agent reads that a capture exists. */
export const MAX_POSTED_IMAGES = 10;
/** The user's own message posted with the batch. */
export const POST_MESSAGE_MAX = 8_000;
/** The mission event that moves a card of the thread to ✓ or ✕. */
export const ANNOTATION_STATUS_EVENT = 'annotation_status';

export type AnnotationImage = { annotationId: string; mimeType: string; base64: string };

export type AnnotationTurn = {
  /** What the agent reads: the user's message, then the block. */
  input: string;
  images: ImageAttachment[];
  /** What the thread keeps: the user's message and the card. */
  shown: { text: string; presentation: PromptPresentation };
  /** What a mission row started by this turn is named by: the message, else the user's comments. */
  label: string;
};

/** Past this, the row's label is cut: it names the conversation, it does not hold the batch. */
export const ANNOTATION_LABEL_MAX = 200;

/** The user's message, or their comments, or a count: the words of the user only, never the page's. */
export function annotationTurnLabel(message: string, comments: readonly string[]): string {
  const words = (message.trim() || comments.map((comment) => comment.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · '));
  if (words) return words.length > ANNOTATION_LABEL_MAX ? `${words.slice(0, ANNOTATION_LABEL_MAX - 1)}…` : words;
  return comments.length === 1 ? '1 browser annotation' : `${comments.length} browser annotations`;
}

/** The thumbnails of a batch, in its order, bounded; an unreadable one is left out. */
export function annotationImages(metas: readonly BrowserAnnotationMetadata[]): AnnotationImage[] {
  const images: AnnotationImage[] = [];
  for (const meta of metas) {
    if (images.length >= MAX_POSTED_IMAGES) break;
    let thumbnail: ReturnType<typeof readBrowserAnnotationThumbnail> = null;
    try { thumbnail = readBrowserAnnotationThumbnail(meta); } catch { thumbnail = null; }
    if (thumbnail) images.push({ annotationId: meta.id, mimeType: thumbnail.mimeType, base64: thumbnail.data });
  }
  return images;
}

/**
 * The turn of a sent batch. `views` are the mission's reads (`missionAnnotationView`): the card
 * takes its page title from them, so an outside site's title stays out of the thread as it stays
 * out of the agent's block.
 */
export function composeAnnotationTurn(input: {
  batchId: string;
  profileId: string;
  views: readonly AgentAnnotationView[];
  images: readonly AnnotationImage[];
  message: string;
}): AnnotationTurn {
  const message = input.message.trim();
  const imageIndex = new Map(input.images.map((image, index) => [image.annotationId, index]));
  const markdown = formatBrowserAnnotations(input.views, { batchId: input.batchId, attachedImages: new Set(imageIndex.keys()) });
  const card: AnnotationAttachment = {
    type: 'annotation',
    batch_id: input.batchId,
    profile_id: input.profileId,
    items: input.views.map((view) => ({
      id: view.id,
      comment: view.comment,
      url: view.page.url,
      title: view.page.title,
      selector: view.page.target.selector || null,
      image: imageIndex.get(view.id) ?? null,
    })),
  };
  return {
    input: message ? `${message}\n\n${markdown}` : markdown,
    images: input.images.map((image) => ({ media_type: image.mimeType, data: image.base64 })),
    label: annotationTurnLabel(message, input.views.map((view) => view.comment)),
    shown: {
      text: message,
      presentation: { version: 1, parts: message ? [{ kind: 'text', text: message }] : [], attachments: [card] },
    },
  };
}

/**
 * A resolved or dismissed annotation of a batch sent to a mission moves its card: a mission event,
 * persisted (a reload shows the state) and published on the mission's live stream. The note is
 * the resolver's own summary or reason.
 */
export function relayAnnotationStatus(ev: BusEvent): void {
  if (ev.kind !== 'browser_annotation' || (ev.event !== 'resolved' && ev.event !== 'dismissed')) return;
  const delivery = ev.annotation.delivery;
  if (!delivery?.missionId || !dbApi.getMission(delivery.missionId)) return;
  let note: string | null = null;
  try { note = readBrowserAnnotation(ev.annotation).note; } catch { note = null; }
  const payload = {
    type: ANNOTATION_STATUS_EVENT, batch_id: delivery.batchId, annotation_id: ev.annotationId,
    status: ev.event, note, by: ev.origin.kind,
  };
  const row = dbApi.insertEvent(delivery.missionId, ANNOTATION_STATUS_EVENT, payload);
  bus.publish({ kind: 'event', missionId: delivery.missionId, type: ANNOTATION_STATUS_EVENT, timestamp: row.timestamp, payload });
}
