'use client';

/**
 * `useBrowserAnnotations()` — the annotations of the built-in browser an occupant of
 * `browser.toolbar` / `browser.drawer` / `browser.surface` is painted in (TODO #468). The ✎
 * button, the drawer and the PWA layer of `@rooks/browser-annotations` are built on it, and a
 * third-party plugin can be too (exported by `@rooks/ui`).
 *
 * Reading `live` is free: it comes from the browser status, which every viewer receives.
 * Everything that acts goes through the plugin's daemon routes, which admit the profile's owner
 * only, and is gated here like the `command()` of `useBrowserChrome()`: the occupant's plugin must
 * declare `browser:control`, read from the slot entry, not from the plugin. Reading the list and
 * the details (the comment, what the page showed) needs `browser:control` or the daemon's own
 * `browser:annotations:read` (TODO #475): the state is shared per profile, so an occupant holding
 * neither gets an empty list even once the bundled drawer has loaded it.
 *
 * "Send" (`post`) posts the queue as one user turn of the conversation the browser is open for
 * (TODO #481): no composer in between. The daemon writes what the agent reads; the thread draws a
 * card. The older `send` (the composer's box, `pending-attachments.ts`) stays for plugins built on
 * it; the product no longer uses it.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { browserControlDenied, useBrowserChrome, useBrowserOccupantPlugin } from '@/components/browser-chrome';
import {
  BROWSER_ANNOTATIONS_READ_PERMISSION, BROWSER_CONTROL_PERMISSION, clientPermissionsVersion, clientPluginHolds, subscribeClientPermissions,
} from '@/lib/plugin-host/plugin-permissions';
import {
  browserAnnotationApi, browserAnnotationState, collectBrowserAnnotations, currentBrowserAnnotationQueue, loadBrowserAnnotations, mergeBrowserAnnotations,
  queueBrowserAnnotations, shouldAutoCollect, subscribeBrowserAnnotations, unqueueBrowserAnnotations, updateBrowserAnnotationState, BrowserAnnotationRequestError,
  type BrowserAnnotationConversation, type PostedBrowserAnnotations, type BrowserAnnotationDetail, type BrowserAnnotationLive, type BrowserAnnotationMeta,
  type BrowserAnnotationPin, type BrowserAnnotationRect, type BrowserAnnotationThumbnail, type SavedBrowserAnnotations,
} from '@/lib/browser-annotations';
import { draftKey } from '@/lib/composer-draft';
import { announceBrowserAnnotationsPosted } from '@/lib/browser-panel-bus';
import { depositAttachment, listPendingAttachments, MAX_BOX_ITEMS } from '@/lib/pending-attachments';
import { t } from '@/lib/i18n';

/** Key of the drawer of `@rooks/browser-annotations` in `browser.drawer`. */
export const BROWSER_ANNOTATIONS_DRAWER = 'annotations';
/** Plugin named on what it deposits in the composer, for display only. */
const SOURCE = '@rooks/browser-annotations';
/** What an occupant that may not read sees: stable, so its memo holds. */
const UNREAD: BrowserAnnotationMeta[] = [];
const UNREAD_DETAILS: Readonly<Record<string, BrowserAnnotationDetail>> = Object.freeze({});
const UNQUEUED: string[] = [];

function readDenied(pluginId: string | null): Error {
  const who = pluginId === null ? 'outside a browser slot entry,' : `plugin \`${pluginId}\`:`;
  const error = new Error(`${who} reading the annotations of useBrowserAnnotations() needs the \`${BROWSER_ANNOTATIONS_READ_PERMISSION}\` or \`${BROWSER_CONTROL_PERMISSION}\` permission in the plugin's manifest (rooks.permissions)`);
  error.name = 'BrowserAnnotationsReadDenied';
  return error;
}

export type SentToComposer = {
  batchId: string;
  /** The composer box the batch landed in (`draftKey(agent, mission)`). */
  box: string;
  /** The block reached the composer; `false`: sent, but the box refused it (the agent reads it with `browser_annotations_get`). */
  deposited: boolean;
  images: number;
};

export type BrowserAnnotationsHandle = {
  profileId: string | null;
  /** The engine's annotate state, `null` while the browser reports none. */
  live: BrowserAnnotationLive | null;
  /** The signed-in user owns the profile; `null` until known. Only the owner annotates, reads and sends. */
  owner: boolean | null;
  /** This occupant's plugin may read the list and the details (`browser:annotations:read` or `browser:control`); empty otherwise. */
  readable: boolean;
  /** This client holds the control lease: annotate mode starts here only (the PWA included). */
  controlled: boolean;
  canStart: boolean;
  /** Where "Send" goes: the conversation this browser is open for (`fresh`: the chat's "New conversation"). */
  target: BrowserAnnotationConversation | null;
  annotations: BrowserAnnotationMeta[];
  /**
   * How many annotations "Send" posts: `queueIds.length`. Without `browser:annotations:read`, the
   * count of the desktop bubble's queue only, which a desktop that names no ids still reports.
   */
  queue: number;
  /**
   * The current queue, in order: what the desktop's bubble queued and what was picked here, until
   * sent or deleted (TODO #491). A draft left from an earlier session is not in it: it waits in the
   * history, sent only by naming it (`post({ ids })`). Without `browser:annotations:read`, the
   * bubble's ids only (`live.queuedIds`).
   */
  queueIds: string[];
  details: Readonly<Record<string, BrowserAnnotationDetail>>;
  selectedId: string | null;
  hover: BrowserAnnotationRect | null;
  highlight: BrowserAnnotationRect | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Picks at a point of the page (CSS pixels): the PWA's way, the native view picks by itself. */
  pick(x: number, y: number): Promise<SavedBrowserAnnotations>;
  /** What lies at a point, for the PWA's own highlight; nothing is stored. */
  preview(x: number, y: number): Promise<BrowserAnnotationRect | null>;
  /** Opens the drawer, on an annotation or on the list. */
  open(id?: string | null): void;
  refresh(): Promise<void>;
  read(id: string): Promise<BrowserAnnotationDetail>;
  thumbnail(id: string): Promise<BrowserAnnotationThumbnail | null>;
  comment(id: string, comment: string): Promise<BrowserAnnotationMeta>;
  /** Deletes an annotation; its pin leaves the page. */
  remove(id: string): Promise<void>;
  /** Shows the element again, found by its stored selector; starts annotate mode when needed. */
  highlightAgain(id: string): Promise<boolean>;
  /**
   * The PWA's pins: the annotated tab follows these elements, the answer says where they are now
   * (page CSS pixels, `null` when gone). An empty list stops following (TODO #491).
   */
  follow(ids: string[]): Promise<BrowserAnnotationPin[]>;
  /** Legacy: sends drafts as one batch to `target` and hands the block to its composer. The product posts instead. */
  send(ids: string[], options?: { withImages?: boolean }): Promise<SentToComposer>;
  /**
   * Posts the current queue (or `ids`, a draft of the history included) to `target` as one user
   * turn: the agent reads it at once, the thread shows a card. The pins of what was posted leave the page.
   */
  post(options?: { ids?: string[]; message?: string }): Promise<PostedBrowserAnnotations>;
};

const ANNOTATION_ID = /^ba-[0-9a-f-]{36}$/;
/** The desktop's bubble holds 20; a batch takes 50. */
const QUEUED_IDS_MAX = 50;

function liveOf(status: unknown): BrowserAnnotationLive | null {
  const annotation = status && typeof status === 'object' ? (status as { annotation?: unknown }).annotation : undefined;
  if (!annotation || typeof annotation !== 'object') return null;
  const { active, pending, queued, queuedIds, capturing, stoppedReason } = annotation as Record<string, unknown>;
  if (typeof active !== 'boolean') return null;
  return {
    active, pending: typeof pending === 'number' ? pending : 0, queued: typeof queued === 'number' ? queued : 0,
    // Read under guard: an id that is not an annotation's is no part of a batch.
    queuedIds: Array.isArray(queuedIds) ? queuedIds.filter((id): id is string => typeof id === 'string' && ANNOTATION_ID.test(id)).slice(0, QUEUED_IDS_MAX) : [],
    capturing: typeof capturing === 'number' ? capturing : 0,
    ...(typeof stoppedReason === 'string' ? { stoppedReason } : {}),
  };
}

function recordingActive(status: unknown): boolean {
  const recording = status && typeof status === 'object' ? (status as { recording?: unknown }).recording : undefined;
  return !!recording && typeof recording === 'object' && (recording as { active?: unknown }).active === true;
}

export function useBrowserAnnotations(): BrowserAnnotationsHandle | null {
  const chrome = useBrowserChrome();
  const pluginId = useBrowserOccupantPlugin();
  useSyncExternalStore(subscribeClientPermissions, clientPermissionsVersion, clientPermissionsVersion);
  const allowed = clientPluginHolds(pluginId, BROWSER_CONTROL_PERMISSION);
  const readable = allowed || clientPluginHolds(pluginId, BROWSER_ANNOTATIONS_READ_PERMISSION);
  const profileId = chrome?.profileId ?? null;
  const state = useSyncExternalStore(subscribeBrowserAnnotations, () => browserAnnotationState(profileId), () => browserAnnotationState(profileId));
  const seen = liveOf(chrome?.status);
  // Rebuilt from every status poll: keep one object while its fields hold.
  const queuedKey = seen?.queuedIds.join(',') ?? '';
  const live = useMemo<BrowserAnnotationLive | null>(
    () => (seen ? {
      active: seen.active, pending: seen.pending, queued: seen.queued, queuedIds: queuedKey ? queuedKey.split(',') : [], capturing: seen.capturing,
      ...(seen.stoppedReason ? { stoppedReason: seen.stoppedReason } : {}),
    } : null),
    [seen?.active, seen?.pending, seen?.queued, queuedKey, seen?.capturing, seen?.stoppedReason], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const liveRef = useRef(live);
  liveRef.current = live;
  const running = chrome?.status?.running === true;
  const recording = recordingActive(chrome?.status);
  const agent = chrome?.conversation.agent ?? null;
  const mission = chrome?.conversation.mission ?? null;
  const fresh = !mission && chrome?.conversation.fresh === true;
  const command = chrome?.command;
  const openDrawer = chrome?.openDrawer;
  const closeDrawer = chrome?.closeDrawer;

  useEffect(() => { if (profileId && readable) void loadBrowserAnnotations(profileId); }, [profileId, readable]);

  const guard = useCallback(<T,>(run: (profile: string) => Promise<T>): Promise<T> => {
    if (!profileId) return Promise.reject(new Error('No browser profile.'));
    if (!allowed) {
      const denied = browserControlDenied(pluginId);
      updateBrowserAnnotationState(profileId, { error: denied.message });
      return Promise.reject(denied);
    }
    return run(profileId);
  }, [allowed, pluginId, profileId]);
  const readGuard = useCallback(<T,>(run: (profile: string) => Promise<T>): Promise<T> => {
    if (!profileId) return Promise.reject(new Error('No browser profile.'));
    // Not written to the shared state: the denial is this occupant's, not the drawer's.
    if (!readable) return Promise.reject(readDenied(pluginId));
    return run(profileId);
  }, [readable, pluginId, profileId]);
  const busyWhile = useCallback(async <T,>(profile: string, run: () => Promise<T>): Promise<T> => {
    updateBrowserAnnotationState(profile, { busy: true, error: null, notice: null });
    try { return await run(); }
    catch (error) { updateBrowserAnnotationState(profile, { error: (error as Error).message }); throw error; }
    finally { updateBrowserAnnotationState(profile, { busy: false }); }
  }, []);

  const open = useCallback((id: string | null = null) => {
    if (!profileId) return;
    updateBrowserAnnotationState(profileId, { selectedId: id });
    openDrawer?.(BROWSER_ANNOTATIONS_DRAWER);
  }, [profileId, openDrawer]);

  /** New picks land in the list. Their comment is typed in a bubble over the page, never in the drawer (TODO #481). */
  const land = useCallback((profile: string, saved: SavedBrowserAnnotations) => {
    mergeBrowserAnnotations(profile, saved.annotations);
    queueBrowserAnnotations(profile, saved.annotations.map((row) => row.id));
    if (saved.annotations.length) updateBrowserAnnotationState(profile, { hover: null });
    if (saved.refused > 0) updateBrowserAnnotationState(profile, { notice: t('browserPanel.annotations.refused', { count: saved.refused }) });
    return saved;
  }, []);

  // The native view picks by itself and the desktop keeps the picks until asked: collect them as the status shows them.
  const owner = state.owner;
  const waiting = live?.pending ?? 0;
  const landRef = useRef(land);
  landRef.current = land;
  useEffect(() => {
    if (!profileId || !allowed || owner !== true || !shouldAutoCollect(profileId, waiting)) return;
    void collectBrowserAnnotations(profileId, () => browserAnnotationApi.collect(profileId))
      .then((saved) => { landRef.current(profileId, saved); })
      .catch((error: unknown) => updateBrowserAnnotationState(profileId, { error: (error as Error).message }));
  }, [profileId, allowed, owner, waiting]);
  // The desktop's bubble seals what it queues as drafts: the list (and the count of the chip) catches up.
  const bubbleQueue = live?.queued ?? 0;
  useEffect(() => {
    if (!profileId || !readable || owner !== true || !bubbleQueue) return;
    const timer = setTimeout(() => { void loadBrowserAnnotations(profileId); }, 600);
    return () => clearTimeout(timer);
  }, [profileId, readable, owner, bubbleQueue]);
  // Annotate mode just ended (here, on Escape, idle, a tab change): the list catches up, the PWA highlight goes.
  const activeNow = live?.active === true;
  useEffect(() => {
    if (profileId && !activeNow) updateBrowserAnnotationState(profileId, (current) => (current.hover || current.highlight ? { hover: null, highlight: null } : {}));
  }, [profileId, activeNow]);

  const start = useCallback(() => guard((profile) => busyWhile(profile, async () => { await browserAnnotationApi.start(profile); })), [guard, busyWhile]);
  const stop = useCallback(() => guard((profile) => busyWhile(profile, async () => {
    const saved = await collectBrowserAnnotations(profile, () => browserAnnotationApi.stop(profile));
    mergeBrowserAnnotations(profile, saved.annotations);
    queueBrowserAnnotations(profile, saved.annotations.map((row) => row.id));
    updateBrowserAnnotationState(profile, { hover: null, highlight: null });
  })), [guard, busyWhile]);
  const pick = useCallback((x: number, y: number) => guard((profile) => busyWhile(profile, async () => land(profile, await browserAnnotationApi.pick(profile, x, y)))), [guard, busyWhile, land]);
  const preview = useCallback((x: number, y: number) => guard(async (profile) => {
    const { hover } = await browserAnnotationApi.preview(profile, x, y).catch(() => ({ hover: null }));
    updateBrowserAnnotationState(profile, { hover: hover?.rect ?? null });
    return hover?.rect ?? null;
  }), [guard]);
  const refresh = useCallback(() => (profileId ? readGuard(loadBrowserAnnotations) : Promise.resolve()), [profileId, readGuard]);
  const read = useCallback((id: string) => readGuard(async (profile) => {
    const detail = await browserAnnotationApi.get(id);
    updateBrowserAnnotationState(profile, (current) => ({ details: { ...current.details, [id]: detail } }));
    mergeBrowserAnnotations(profile, [detail.annotation]);
    return detail;
  }), [readGuard]);
  const thumbnail = useCallback((id: string) => guard(async () => {
    try { return (await browserAnnotationApi.thumbnail(id)).thumbnail; } catch { return null; }
  }), [guard]);
  const comment = useCallback((id: string, text: string) => guard((profile) => busyWhile(profile, async () => {
    const { annotation } = await browserAnnotationApi.comment(id, text);
    updateBrowserAnnotationState(profile, (current) => {
      const detail = current.details[id];
      return detail ? { details: { ...current.details, [id]: { ...detail, annotation, comment: text.trim() } } } : {};
    });
    mergeBrowserAnnotations(profile, [annotation]);
    // The daemon bounds and cleans the comment: what the drawer shows is what was stored.
    void browserAnnotationApi.get(id).then((detail) => updateBrowserAnnotationState(profile, (current) => ({ details: { ...current.details, [id]: detail } }))).catch(() => {});
    return annotation;
  })), [guard, busyWhile]);
  const remove = useCallback((id: string) => guard((profile) => busyWhile(profile, async () => {
    await browserAnnotationApi.remove(id);
    updateBrowserAnnotationState(profile, (current) => {
      const { [id]: _gone, ...details } = current.details;
      return {
        annotations: current.annotations.filter((row) => row.id !== id), details, selectedId: current.selectedId === id ? null : current.selectedId,
        queued: current.queued.filter((queued) => queued !== id),
      };
    });
    // Its pin on the page, if the desktop's bubble drew one, goes too.
    void command?.('annotateUnpin', { ids: [id] }).catch(() => {});
  })), [guard, busyWhile, command]);
  const highlightAgain = useCallback((id: string) => guard((profile) => busyWhile(profile, async () => {
    if (!command) return false;
    const detail = browserAnnotationState(profile).details[id] ?? await browserAnnotationApi.get(id);
    const selector = detail.page.target.selector;
    if (!selector) { updateBrowserAnnotationState(profile, { notice: t('browserPanel.annotations.notFound') }); return false; }
    if (!activeNow) await browserAnnotationApi.start(profile);
    closeDrawer?.();
    const answer = await command<{ highlight?: { found?: boolean; rect?: BrowserAnnotationRect } }>('annotateHighlight', { selector });
    const rect = answer?.highlight?.found ? answer.highlight.rect ?? null : null;
    updateBrowserAnnotationState(profile, { highlight: rect, hover: null, ...(rect ? {} : { notice: t('browserPanel.annotations.notFound') }) });
    return !!rect;
  })), [guard, busyWhile, command, activeNow, closeDrawer]);
  const follow = useCallback((ids: string[]) => guard(async (profile) => (await browserAnnotationApi.pins(profile, ids)).pins), [guard]);
  const send = useCallback((ids: string[], options: { withImages?: boolean } = {}) => guard((profile) => busyWhile(profile, async () => {
    if (!agent) throw new Error('This browser is not open for a conversation.');
    const box = draftKey(agent, mission);
    // Sending cannot be undone: check the composer has room before the daemon marks the batch sent.
    const room = MAX_BOX_ITEMS - listPendingAttachments(box).length;
    if (room < 1) throw new Error(t('browserPanel.annotations.boxFull'));
    const withImages = options.withImages !== false && room > 1;
    const sent = await browserAnnotationApi.send(ids, mission ? { missionId: mission } : { agent }, withImages);
    mergeBrowserAnnotations(profile, sent.annotations);
    const label = t('browserPanel.annotations.handoffLabel', { count: sent.annotations.length });
    // Verbatim: the daemon's block is the only text an agent reads of an annotation.
    const text = depositAttachment(box, { kind: 'text', label, source: SOURCE, text: sent.handoff.markdown });
    let images = 0;
    if (text.ok) {
      for (const image of sent.handoff.images) {
        const kept = depositAttachment(box, { kind: 'image', label: t('browserPanel.annotations.thumbnailLabel'), source: SOURCE, mediaType: image.mimeType, base64: image.base64 });
        if (kept.ok) images++;
      }
    }
    updateBrowserAnnotationState(profile, {
      notice: text.ok ? t('browserPanel.annotations.handedOff', { agent }) : t('browserPanel.annotations.sentNotDeposited', { agent }),
    });
    return { batchId: sent.batchId, box, deposited: text.ok, images };
  })), [guard, busyWhile, agent, mission]);

  const post = useCallback((options: { ids?: string[]; message?: string } = {}) => guard((profile) => busyWhile(profile, async () => {
    if (!agent) throw new Error(t('browserPanel.annotations.noConversation'));
    let ids = options.ids;
    if (!ids) {
      // A capture the desktop's bubble queued a moment ago is sealed before the queue goes.
      await collectBrowserAnnotations(profile, () => browserAnnotationApi.collect(profile))
        .then((saved) => { mergeBrowserAnnotations(profile, saved.annotations); queueBrowserAnnotations(profile, saved.annotations.map((row) => row.id)); })
        .catch(() => {});
      // The current queue only: a draft of an earlier session is sent from the history, by name.
      ids = currentBrowserAnnotationQueue(browserAnnotationState(profile), liveRef.current?.queuedIds ?? []);
      if (!ids.length) throw new Error(t('browserPanel.annotations.queueEmpty'));
    }
    let posted: PostedBrowserAnnotations;
    try {
      posted = await browserAnnotationApi.post(profile, { agent, mission, ...(fresh ? { fresh: true } : {}) }, { ids }, options.message);
    } catch (error) {
      // The queue is intact: the agent is answering, it goes once the turn ends.
      if (error instanceof BrowserAnnotationRequestError && error.code === 'turn_in_progress') throw new Error(t('browserPanel.annotations.turnInProgress'));
      if (error instanceof BrowserAnnotationRequestError && error.code === 'no_linked_conversation') throw new Error(t('browserPanel.annotations.notThisConversation'));
      throw error;
    }
    mergeBrowserAnnotations(profile, posted.annotations);
    unqueueBrowserAnnotations(profile, posted.annotations.map((row) => row.id));
    void command?.('annotateUnpin', { ids: posted.annotations.map((row) => row.id) }).catch(() => {});
    announceBrowserAnnotationsPosted({ agent, missionId: posted.missionId });
    updateBrowserAnnotationState(profile, { notice: t('browserPanel.annotations.posted', { agent }) });
    return posted;
  })), [guard, busyWhile, agent, mission, fresh, command]);

  const controlled = chrome?.controlled === true;
  const rows = readable ? state.annotations : UNREAD;
  const bubbleIds = live?.queuedIds;
  // An occupant that cannot read the list gets the bubble's queue only, as free as the status it comes
  // from: never this app's queue, nor which of the bubble's ids the list knows as sent (TODO #475).
  const queueIds = useMemo(() => (readable ? currentBrowserAnnotationQueue(state, bubbleIds ?? []) : bubbleIds ?? UNQUEUED), [readable, state, bubbleIds]);
  const queue = readable ? queueIds.length : Math.max(queueIds.length, live?.queued ?? 0);
  return useMemo(() => {
    if (!chrome) return null;
    return {
      profileId, live, owner: state.owner, readable, controlled,
      canStart: allowed && state.owner === true && controlled && running && !recording && !state.busy && !live?.active,
      target: agent ? { agent, mission, ...(fresh ? { fresh: true } : {}) } : null,
      queue, queueIds,
      annotations: rows, details: readable ? state.details : UNREAD_DETAILS, selectedId: readable ? state.selectedId : null,
      hover: state.hover, highlight: state.highlight,
      busy: state.busy, error: state.error, notice: state.notice,
      start, stop, pick, preview, open, refresh, read, thumbnail, comment, remove, highlightAgain, follow, send, post,
    };
  }, [chrome, profileId, live, state, rows, readable, controlled, allowed, running, recording, agent, mission, fresh, queue, queueIds,
    start, stop, pick, preview, open, refresh, read, thumbnail, comment, remove, highlightAgain, follow, send, post]);
}
