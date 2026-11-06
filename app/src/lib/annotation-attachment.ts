/** One annotation of a batch the user posted from the browser (TODO #481),
 *  as the thread shows it (`AnnotationCardItem` in
 *  orchestrator/src/prompt-presentation.ts — keep the two in step). */
export type AnnotationCardItem = {
  id: string;
  /** The user's own words about the element. */
  comment: string;
  url: string;
  /** Empty for a page that is not the user's own development. */
  title: string;
  selector: string | null;
  /** Index of its thumbnail among the images of the same `user` event. */
  image: number | null;
};

/** A posted batch of browser annotations: the thread draws it as a card,
 *  never as the block the agent read (which is not stored with it). */
export type AnnotationAttachment = {
  type: 'annotation';
  batch_id: string;
  profile_id: string;
  items: AnnotationCardItem[];
};

/** A batch holds this many annotations at most (`MAX_ANNOTATIONS_PER_BATCH`). */
const ANNOTATION_CARD_MAX = 50;
const ANNOTATION_ID = /^ba-[0-9a-f-]{36}$/;
const BATCH_ID = /^bab-[0-9a-f-]{36}$/;

function readAnnotationItem(raw: unknown): AnnotationCardItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const i = raw as Record<string, unknown>;
  if (!isStr(i.id) || !ANNOTATION_ID.test(i.id) || !isStr(i.comment) || !isStr(i.url) || !isStr(i.title)) return null;
  if (i.selector !== null && !isStr(i.selector)) return null;
  if (i.image !== null && !(Number.isInteger(i.image) && (i.image as number) >= 0)) return null;
  return { id: i.id, comment: i.comment, url: i.url, title: i.title, selector: i.selector as string | null, image: i.image as number | null };
}

/** The annotation card of a `user` event, or null. A malformed one is not
 *  drawn at all: it never falls back to anything the agent read. */
export function readAnnotationAttachment(origin: unknown): AnnotationAttachment | null {
  if (!origin || typeof origin !== 'object') return null;
  const presentation = (origin as { presentation?: unknown }).presentation;
  if (!presentation || typeof presentation !== 'object') return null;
  const attachments = (presentation as { attachments?: unknown }).attachments;
  if (!Array.isArray(attachments)) return null;
  for (const raw of attachments) {
    if (!raw || typeof raw !== 'object' || (raw as { type?: unknown }).type !== 'annotation') continue;
    const a = raw as Record<string, unknown>;
    if (!isStr(a.batch_id) || !BATCH_ID.test(a.batch_id) || !isStr(a.profile_id) || !Array.isArray(a.items)) return null;
    if (!a.items.length || a.items.length > ANNOTATION_CARD_MAX) return null;
    const items: AnnotationCardItem[] = [];
    for (const item of a.items) {
      const read = readAnnotationItem(item);
      if (!read) return null;
      items.push(read);
    }
    return { type: 'annotation', batch_id: a.batch_id, profile_id: a.profile_id, items };
  }
  return null;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
