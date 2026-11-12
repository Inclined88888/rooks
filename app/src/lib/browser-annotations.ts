/**
 * Client contract of the browser annotations (TODO #468), served by the daemon plugin
 * `@rooks/browser-annotations` (`orchestrator/src/plugins-bundled/browser-annotations/routes.ts`).
 *
 * What the page said (title, element, text, source) is read here for the owner's own drawer,
 * rendered as text and never sent anywhere from the app. What an agent receives is the daemon's
 * `handoff.markdown`, fenced by its one writer (`browser-annotation-format.ts`): the app deposits
 * it as it comes and never builds annotation text of its own.
 */

export type BrowserAnnotationStatus = 'draft' | 'pending' | 'resolved' | 'dismissed';

/** What the engine reports in the browser status, to every viewer of the profile. */
export type BrowserAnnotationLive = {
  active: boolean;
  /** Picks made in the native view, waiting on the desktop to be collected. */
  pending: number;
  /** The annotations in the queue of the desktop's bubble (TODO #481): sealed as drafts as they are added. */
  queued: number;
  /** Their ids, in the order they were added (TODO #491); empty from a desktop that does not report them. */
  queuedIds: string[];
  capturing: number;
  /** Set once annotate mode ended (`user`, `escape`, `idle`, `tab-change`…). */
  stoppedReason?: string;
};

export type BrowserAnnotationRect = { x: number; y: number; width: number; height: number };

export type BrowserAnnotationMeta = {
  id: string;
  profileId: string;
  status: BrowserAnnotationStatus;
  createdAt: number;
  updatedAt: number;
  capturedAt: number;
  hasThumbnail: boolean;
  sourceDetected: boolean;
  delivery: { batchId: string; missionId: string | null; agentName: string | null; sentAt: number } | null;
  resolvedAt: number | null;
};

export type BrowserAnnotationTarget = {
  selector: string;
  tag: string;
  role: string;
  name: string;
  text: string;
  id: string;
  classes: string[];
};

/** The owner's read of one annotation. `page` and `source` are what the page said: untrusted. */
export type BrowserAnnotationDetail = {
  annotation: BrowserAnnotationMeta;
  comment: string;
  page: {
    url: string;
    title: string;
    target: BrowserAnnotationTarget;
    rect: BrowserAnnotationRect;
    viewport: { width: number; height: number };
  };
  source: { detected: false } | { detected: true; framework: string; component?: string; file: string | null; line?: number };
  resolution: { status: 'resolved'; summary: string | null } | { status: 'dismissed'; reason: string | null } | null;
};

export type BrowserAnnotationThumbnail = { mimeType: 'image/jpeg'; data: string; width: number; height: number };

export type SavedBrowserAnnotations = { annotations: BrowserAnnotationMeta[]; refused: number; thumbnailsDropped: number };
/** Where the element of a pin is now, in page CSS pixels; `null`: gone from the page, or not followed. */
export type BrowserAnnotationPin = { id: string; rect: BrowserAnnotationRect | null };

/** What the composer deposits for a batch just sent: the daemon's block, verbatim, and the thumbnails. */
export type BrowserAnnotationHandoff = { markdown: string; images: { annotationId: string; mimeType: string; base64: string }[] };
export type SentBrowserAnnotations = { batchId: string; annotations: BrowserAnnotationMeta[]; handoff: BrowserAnnotationHandoff };
export type BrowserAnnotationDestination = { missionId: string } | { agent: string };

/** The conversation a batch is posted to: the chat's own, `fresh` when it is on "New conversation". */
export type BrowserAnnotationConversation = { agent: string; mission: string | null; fresh?: boolean };
/** `POST …/:profileId/annotations/post`: the batch went to the agent as one user turn (TODO #481). */
export type PostedBrowserAnnotations = {
  ok: true; missionId: string; spawned: boolean; batchId: string; annotations: BrowserAnnotationMeta[]; images: number;
};

/** An error that keeps the HTTP status: a 404 on the list means "not the owner". */
export class BrowserAnnotationRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null = null) { super(message); }
}

async function request<T>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<T> {
  const response = await fetch(`/api/ui/native-browser/${path}`, {
    method, credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown };
  if (!response.ok) {
    throw new BrowserAnnotationRequestError(typeof value.error === 'string' ? value.error : `Browser annotation request failed (${response.status})`,
      response.status, typeof value.code === 'string' ? value.code : null);
  }
  return value as T;
}

const profilePath = (profileId: string) => encodeURIComponent(profileId);
const annotationPath = (id: string) => `annotations/${encodeURIComponent(id)}`;

export const browserAnnotationApi = {
  start: (profileId: string) => request<{ annotation: unknown }>(`${profilePath(profileId)}/annotation/start`, 'POST', {}),
  stop: (profileId: string) => request<SavedBrowserAnnotations>(`${profilePath(profileId)}/annotation/stop`, 'POST', {}),
  collect: (profileId: string) => request<SavedBrowserAnnotations>(`${profilePath(profileId)}/annotation/collect`, 'POST', {}),
  pick: (profileId: string, x: number, y: number) => request<SavedBrowserAnnotations>(`${profilePath(profileId)}/annotation/pick`, 'POST', { x, y }),
  /** The PWA's pins: the annotated tab follows these elements and says where they are now (TODO #491). */
  pins: (profileId: string, ids: string[]) => request<{ pins: BrowserAnnotationPin[] }>(`${profilePath(profileId)}/annotation/pins`, 'POST', { ids }),
  preview: (profileId: string, x: number, y: number) =>
    request<{ hover: { rect: BrowserAnnotationRect; tag: string } | null }>(`${profilePath(profileId)}/annotation/pick`, 'POST', { x, y, preview: true }),
  list: (profileId: string) => request<{ annotations: BrowserAnnotationMeta[] }>(`${profilePath(profileId)}/annotations`, 'GET'),
  get: (id: string) => request<BrowserAnnotationDetail>(annotationPath(id), 'GET'),
  thumbnail: (id: string) => request<{ thumbnail: BrowserAnnotationThumbnail }>(`${annotationPath(id)}/thumbnail`, 'GET'),
  comment: (id: string, comment: string) => request<{ annotation: BrowserAnnotationMeta }>(annotationPath(id), 'PATCH', { comment }),
  remove: (id: string) => request<{ deleted: boolean }>(annotationPath(id), 'DELETE'),
  send: (ids: string[], to: BrowserAnnotationDestination, withImages: boolean) =>
    request<SentBrowserAnnotations>('annotations/send', 'POST', { ids, ...to, withImages }),
  /** The queue (or `ids`) as one user turn of `to`: no composer, nothing to send again. */
  post: (profileId: string, to: BrowserAnnotationConversation, batch: { ids: string[] } | { all: true }, message?: string) =>
    request<PostedBrowserAnnotations>(`${profilePath(profileId)}/annotations/post`, 'POST', {
      ...batch, agent: to.agent,
      ...(to.mission ? { missionId: to.mission } : to.fresh ? { fresh: true } : {}),
      ...(message?.trim() ? { message: message.trim() } : {}),
    }),
};

/** The element as the drawer names it: tag, then its accessible name or its text. Display only. */
export function annotationElementLabel(target: Pick<BrowserAnnotationTarget, 'tag' | 'name' | 'text'>): string {
  const words = (target.name || target.text).replace(/\s+/g, ' ').trim();
  const short = words.length > 60 ? `${words.slice(0, 59)}…` : words;
  return short ? `<${target.tag}> ${short}` : `<${target.tag}>`;
}

// ---------------------------------------------------------------------------------------------
// One state per profile, shared by every occupant painted for it (the ✎ button, the drawer and
// the PWA layer are three slot entries, and a profile can be open in several islands). Being
// shared, it holds what the page showed for every occupant: `useBrowserAnnotations()` hands the
// list and the details only to one whose plugin may read them (TODO #475).

export type BrowserAnnotationState = {
  /** The signed-in user owns the profile; `null` until the list answered. */
  owner: boolean | null;
  /** Newest first. */
  annotations: BrowserAnnotationMeta[];
  details: Readonly<Record<string, BrowserAnnotationDetail>>;
  /** The annotation the drawer shows, `null` for the list. */
  selectedId: string | null;
  /** The element under the PWA pointer, in page CSS pixels. */
  hover: BrowserAnnotationRect | null;
  /** The element a re-highlight found, in page CSS pixels. */
  highlight: BrowserAnnotationRect | null;
  busy: boolean;
  error: string | null;
  /** A passing remark: a batch added to a message, an element no longer on the page. */
  notice: string | null;
  /**
   * The annotations this app added to the current queue (its picks, the native view's picks it
   * collected), in order, until they are sent or deleted (TODO #491). "Send" posts them and the
   * desktop bubble's queue, never a draft left from an earlier session: that one waits in the history.
   */
  queued: string[];
};

const EMPTY: BrowserAnnotationState = {
  owner: null, annotations: [], details: {}, selectedId: null, hover: null, highlight: null, busy: false, error: null, notice: null, queued: [],
};
const states = new Map<string, BrowserAnnotationState>();
const loads = new Map<string, Promise<void>>();
const collects = new Map<string, Promise<SavedBrowserAnnotations>>();
const listeners = new Set<() => void>();

export function subscribeBrowserAnnotations(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function browserAnnotationState(profileId: string | null): BrowserAnnotationState {
  return (profileId && states.get(profileId)) || EMPTY;
}

export function updateBrowserAnnotationState(profileId: string, change: Partial<BrowserAnnotationState> | ((state: BrowserAnnotationState) => Partial<BrowserAnnotationState>)): void {
  const current = browserAnnotationState(profileId);
  states.set(profileId, { ...current, ...(typeof change === 'function' ? change(current) : change) });
  for (const listener of listeners) listener();
}

const newestFirst = (rows: BrowserAnnotationMeta[]) => [...rows].sort((a, b) => b.createdAt - a.createdAt);

/** The latest of a batch by its creation, whatever order the daemon answered in. */
export function newestBrowserAnnotation(rows: readonly BrowserAnnotationMeta[]): BrowserAnnotationMeta | null {
  return rows.reduce<BrowserAnnotationMeta | null>((newest, row) => (!newest || row.createdAt > newest.createdAt ? row : newest), null);
}

/** Re-reads the list; one request at a time per profile. A detail whose annotation changed is read again. */
export function loadBrowserAnnotations(profileId: string): Promise<void> {
  const running = loads.get(profileId);
  if (running) return running;
  const load = browserAnnotationApi.list(profileId)
    .then(({ annotations }) => updateBrowserAnnotationState(profileId, (state) => ({
      owner: true,
      annotations: newestFirst(annotations),
      details: Object.fromEntries(annotations.flatMap((row) => {
        const detail = state.details[row.id];
        return detail && detail.annotation.updatedAt === row.updatedAt ? [[row.id, detail]] : [];
      })),
      selectedId: state.selectedId && annotations.some((row) => row.id === state.selectedId) ? state.selectedId : null,
    })))
    .catch((error: unknown) => {
      // The list answers its owner only: anyone else sees the profile, not its annotations.
      if (error instanceof BrowserAnnotationRequestError && (error.status === 403 || error.status === 404)) updateBrowserAnnotationState(profileId, { owner: false, annotations: [], details: {} });
      else updateBrowserAnnotationState(profileId, { error: (error as Error).message });
    })
    .finally(() => { loads.delete(profileId); });
  loads.set(profileId, load);
  return load;
}

/** Collects the picks waiting on the desktop; several occupants asking at once share one request. */
export function collectBrowserAnnotations(profileId: string, run: () => Promise<SavedBrowserAnnotations>): Promise<SavedBrowserAnnotations> {
  const running = collects.get(profileId);
  if (running) return running.then(() => ({ annotations: [], refused: 0, thumbnailsDropped: 0 }));
  const collect = run().finally(() => { collects.delete(profileId); });
  collects.set(profileId, collect);
  return collect;
}

const autoCollected = new Map<string, { pending: number; at: number }>();
/** Past this, a status still showing the same waiting picks is believed again (a collect that failed, a late poll). */
const AUTO_COLLECT_QUIET_MS = 3_000;

/**
 * Whether the picks a status shows waiting should be collected now. The status lags behind a
 * collect, and every occupant that mounts sees it: the same count is collected once per window.
 */
export function shouldAutoCollect(profileId: string, pending: number, now = Date.now()): boolean {
  if (pending <= 0) { autoCollected.delete(profileId); return false; }
  const last = autoCollected.get(profileId);
  if (last && last.pending === pending && now - last.at < AUTO_COLLECT_QUIET_MS) return false;
  autoCollected.set(profileId, { pending, at: now });
  return true;
}

/** Annotations just saved or changed: the list shows them at once. */
export function mergeBrowserAnnotations(profileId: string, rows: readonly BrowserAnnotationMeta[]): void {
  if (!rows.length) return;
  updateBrowserAnnotationState(profileId, (state) => {
    const byId = new Map(state.annotations.map((row) => [row.id, row]));
    for (const row of rows) byId.set(row.id, row);
    const details = { ...state.details };
    for (const row of rows) if (details[row.id] && details[row.id]!.annotation.updatedAt !== row.updatedAt) details[row.id] = { ...details[row.id]!, annotation: row };
    return { annotations: newestFirst([...byId.values()]), details };
  });
}

/** Annotations just made or collected here join the current queue, in the order they came. */
export function queueBrowserAnnotations(profileId: string, ids: readonly string[]): void {
  if (!ids.length) return;
  updateBrowserAnnotationState(profileId, (state) => ({ queued: [...new Set([...state.queued, ...ids])] }));
}

/** Annotations sent or deleted leave the current queue. */
export function unqueueBrowserAnnotations(profileId: string, ids: readonly string[]): void {
  const gone = new Set(ids);
  updateBrowserAnnotationState(profileId, (state) => (state.queued.some((id) => gone.has(id)) ? { queued: state.queued.filter((id) => !gone.has(id)) } : {}));
}

/**
 * The current queue, in order: the desktop bubble's, then this app's. A draft from an earlier
 * session is in neither. What is known to be sent, or gone from the list, is out; an id of the
 * bubble not listed yet stays (sealed as the next collect runs).
 */
export function currentBrowserAnnotationQueue(state: Pick<BrowserAnnotationState, 'annotations' | 'queued'>, bubble: readonly string[]): string[] {
  const rows = new Map(state.annotations.map((row) => [row.id, row]));
  const fromBubble = bubble.filter((id) => { const row = rows.get(id); return !row || row.status === 'draft'; });
  const fromApp = state.queued.filter((id) => rows.get(id)?.status === 'draft');
  return [...new Set([...fromBubble, ...fromApp])];
}

export function resetBrowserAnnotationsForTests(): void {
  states.clear();
  loads.clear();
  collects.clear();
  autoCollected.clear();
  for (const listener of listeners) listener();
}
