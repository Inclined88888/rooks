'use client';

/**
 * Client half of `@timon/browser-annotations` (TODO #468, reworked by TODO #481), three slot
 * occupants built on `useBrowserAnnotations()`:
 *
 * - the address bar (`browser.toolbar`): ✎, the mode pill, and "N annotations · Send", which posts
 *   the queue as one message of the chat's conversation — no composer in between;
 * - the history (`browser.drawer`): the annotations by page with their state, shown again on the
 *   page or deleted. Off the main path: a comment is typed in the bubble, never here;
 * - the PWA layer (`browser.surface`): over the page's video it points, draws the highlight, the
 *   bubble and the numbered pins. Under the native view the desktop draws its own.
 *
 * What the page said (element, text, title) is shown as text to its owner only; nothing of it is
 * ever assembled here into what an agent reads.
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { AlertTriangle, ArrowLeft, Check, Crosshair, Image as ImageIcon, Loader2, MessageSquareText, Pencil, Send, Trash2, X } from 'lucide-react';
import { BROWSER_DRAWER_SLOT, BROWSER_SURFACE_SLOT, BROWSER_TOOLBAR_SLOT, useBrowserChrome, useBrowserSurface } from '@/components/browser-chrome';
import { BROWSER_ANNOTATIONS_DRAWER, useBrowserAnnotations, type BrowserAnnotationsHandle } from '@/hooks/use-browser-annotations';
import {
  annotationElementLabel, newestBrowserAnnotation, updateBrowserAnnotationState,
  type BrowserAnnotationDetail, type BrowserAnnotationMeta, type BrowserAnnotationPin, type BrowserAnnotationRect, type BrowserAnnotationThumbnail,
} from '@/lib/browser-annotations';
import { annotationPageLabel } from '@/lib/annotation-card';
import { announceBrowserAnnotationsPosted } from '@/lib/browser-panel-bus';
import { BROWSER_CONTROL_PERMISSION } from '@/lib/plugin-host/plugin-permissions';
import { readAnnotationAttachment } from '@/lib/annotation-attachment';
import { sseOn } from '@/lib/sse-stream';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { AnnotationBubble, AnnotationPin, type SurfaceRect } from './browser-annotation-bubble';
import type { BundledClientPlugin } from './types';

export const BROWSER_ANNOTATIONS_MODULE = '@timon/browser-annotations';

const iconButton = 'rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40';
const pillButton = 'rounded-full px-1.5 py-0.5 font-medium hover:bg-background/60 disabled:opacity-40';
const action = 'inline-flex items-center gap-1 rounded-md bg-background px-2 py-1 text-xs hover:bg-muted disabled:opacity-40';
/** Annotations read in the history at once: it is not a backlog. */
const DETAILS_READ = 50;
/** How long "Sent" stays in the address bar. */
const NOTICE_MS = 4_000;
/** How often the PWA reads where its pins' elements are now, one read in flight: the page scrolls under them. */
const FOLLOW_MS = 150;

/** Some of the element is in the page's viewport: a pin on an element scrolled away is not drawn. */
export function inViewport(rect: BrowserAnnotationRect, viewport: { width: number; height: number }): boolean {
  return rect.width >= 0 && rect.height >= 0 && rect.x < viewport.width && rect.y < viewport.height && rect.x + rect.width > 0 && rect.y + rect.height > 0;
}

/**
 * Where the elements of the PWA's pins are now (TODO #491): the annotated tab's preload follows them
 * and the desktop reports their rectangles, the same source as its own pins. `null`: gone from the
 * page; absent: not read yet. An empty list tells the desktop to stop following.
 */
function useFollowedRects(follow: ((ids: string[]) => Promise<BrowserAnnotationPin[]>) | undefined, ids: string[]) {
  const [rects, setRects] = useState<Readonly<Record<string, BrowserAnnotationRect | null>>>({});
  const key = ids.join(',');
  const following = useRef(false);
  useEffect(() => {
    if (!follow) return;
    if (!key) {
      setRects((current) => (Object.keys(current).length ? {} : current));
      if (following.current) { following.current = false; void follow([]).catch(ignore); }
      return;
    }
    following.current = true;
    const wanted = key.split(',');
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const pins = await follow(wanted);
        if (!live) return;
        const next = Object.fromEntries(pins.filter((pin) => wanted.includes(pin.id)).map((pin) => [pin.id, pin.rect]));
        setRects((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
      } catch { /* The last rectangles stay: a missed read is caught up by the next. */ }
      if (live) timer = setTimeout(() => { void read(); }, FOLLOW_MS);
    };
    void read();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [follow, key]);
  return rects;
}

const ignore = () => {};

/**
 * "N annotations · Send": the current queue of this browser (what this session pointed at, and
 * the desktop bubble's), posted in one go to the chat's conversation. Older drafts wait in the history.
 */
function QueueChip({ annotations }: { annotations: BrowserAnnotationsHandle }) {
  const count = annotations.queue;
  if (annotations.owner !== true || count < 1) return null;
  const agent = annotations.target?.agent;
  return (
    <div data-annotation-queue={count} className="flex shrink-0 items-center rounded-full bg-primary/10 py-0.5 pl-0.5 pr-0.5 text-[11px] text-primary">
      <button type="button" className={cn(pillButton, 'tabular-nums')} title={t('browserPanel.annotations.history')} onClick={() => annotations.open(null)}>
        {count === 1 ? t('browserPanel.annotations.queueOne') : t('browserPanel.annotations.queue', { count })}
      </button>
      <span aria-hidden className="text-primary/60">·</span>
      <button type="button" className={cn(pillButton, 'flex items-center gap-1')} disabled={annotations.busy || !annotations.target}
        title={agent ? t('browserPanel.annotations.sendQueueTitle', { agent }) : t('browserPanel.annotations.noConversation')}
        onClick={() => { void annotations.post().catch(ignore); }}>
        {annotations.busy ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />}
        {t('browserPanel.annotations.sendQueue')}
      </button>
    </div>
  );
}

type StreamEvent = { type?: unknown; missionId?: unknown; payload?: { origin?: unknown } };

function parseStreamEvent(data: unknown): StreamEvent | null {
  try {
    const value: unknown = JSON.parse(String(data));
    return value && typeof value === 'object' ? value as StreamEvent : null;
  } catch { return null; }
}

/** The history, when nothing waits (the queue's chip opens it otherwise). */
function HistoryButton({ annotations }: { annotations: BrowserAnnotationsHandle }) {
  if (!annotations.annotations.length || annotations.queue > 0) return null;
  return (
    <button type="button" className={iconButton} aria-label={t('browserPanel.annotations.history')} title={t('browserPanel.annotations.history')} onClick={() => annotations.open(null)}>
      <MessageSquareText className="size-3.5" />
    </button>
  );
}

/**
 * The desktop's bubble posts by itself: when its message starts a conversation, the chat of this
 * agent is told, as for the address bar's own Send (the chat on "New conversation" opens it).
 */
function useFollowBubblePosts(annotations: BrowserAnnotationsHandle | null) {
  const profileId = annotations?.profileId ?? null;
  const owner = annotations?.owner === true;
  const agent = annotations?.target?.agent ?? null;
  const mission = annotations?.target?.mission ?? null;
  const refresh = annotations?.refresh;
  useEffect(() => {
    if (!profileId || !owner || !agent) return;
    return sseOn('event', (event) => {
      const ev = parseStreamEvent(event.data);
      if (ev?.type !== 'user' || typeof ev.missionId !== 'string') return;
      if (readAnnotationAttachment(ev.payload?.origin)?.profile_id !== profileId) return;
      void refresh?.();
      if (ev.missionId !== mission) announceBrowserAnnotationsPosted({ agent, missionId: ev.missionId });
    });
  }, [profileId, owner, agent, mission, refresh]);
}

/** ✎ when idle; a pill while annotate mode is on, for every viewer, with Done for the owner; the queue's chip. */
export function BrowserAnnotateControl() {
  const annotations = useBrowserAnnotations();
  useFollowBubblePosts(annotations);
  const notice = annotations?.notice ?? null;
  const profileId = annotations?.profileId ?? null;
  useEffect(() => {
    if (!notice || !profileId) return;
    const timer = setTimeout(() => updateBrowserAnnotationState(profileId, (current) => (current.notice === notice ? { notice: null } : {})), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice, profileId]);
  if (!annotations?.profileId) return null;
  const { live, owner } = annotations;
  const failure = annotations.error && <span role="alert" title={annotations.error} className="text-destructive"><AlertTriangle className="size-3.5" /><span className="sr-only">{annotations.error}</span></span>;
  const flash = notice && (
    <span role="status" title={notice} className="flex max-w-[12rem] shrink-0 items-center gap-1 truncate text-[11px] text-emerald-700 dark:text-emerald-400">
      <Check aria-hidden className="size-3 shrink-0" /><span className="truncate">{notice}</span>
    </span>
  );

  if (live?.active) {
    return (
      <div className="flex shrink-0 items-center gap-1">
        <div role="status" data-browser-annotating="" title={t('browserPanel.annotations.annotatingTitle')} className="flex shrink-0 items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-2 pr-0.5 text-[11px] text-primary">
          <Crosshair aria-hidden className="size-3" />
          <span>{t('browserPanel.annotations.annotating')}</span>
          {owner === true && (
            <button type="button" className={cn(pillButton, 'flex items-center gap-1')} disabled={annotations.busy} onClick={() => { void annotations.stop().catch(ignore); }} title={t('browserPanel.annotations.doneTitle')}>
              {t('browserPanel.annotations.done')}
            </button>
          )}
        </div>
        <QueueChip annotations={annotations} />
        {owner === true && <HistoryButton annotations={annotations} />}
        {flash}
        {failure}
      </div>
    );
  }
  if (owner !== true) return null;
  const why = !annotations.controlled ? t('browserPanel.annotations.needsControl') : t('browserPanel.annotations.annotateTitle');
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <button type="button" className={iconButton} disabled={!annotations.canStart} aria-label={t('browserPanel.annotations.annotate')} title={why} onClick={() => { void annotations.start().catch(ignore); }}>
        {annotations.busy && !annotations.queue ? <Loader2 className="size-3.5 animate-spin" /> : <Pencil className="size-3.5" />}
      </button>
      <QueueChip annotations={annotations} />
      <HistoryButton annotations={annotations} />
      {flash}
      {failure}
    </div>
  );
}

function StatusBadge({ meta }: { meta: BrowserAnnotationMeta }) {
  const tone = meta.status === 'draft' ? 'bg-muted text-muted-foreground' : meta.status === 'pending' ? 'bg-primary/10 text-primary'
    : meta.status === 'resolved' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-amber-500/10 text-amber-700 dark:text-amber-400';
  return <span data-annotation-status={meta.status} className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium', tone)}>{t(`browserPanel.annotations.status.${meta.status}`)}</span>;
}

function sourceText(source: BrowserAnnotationDetail['source']): string {
  if (!source.detected) return t('browserPanel.annotations.sourceNotDetected');
  const file = source.file ? `${source.file}${source.line ? `:${source.line}` : ''}` : '';
  return [source.component, file].filter(Boolean).join(' · ') || source.framework;
}

/** One annotation reopened from the history: what was said, where, and what became of it. */
function AnnotationRecord({ annotations, meta, detail }: { annotations: BrowserAnnotationsHandle; meta: BrowserAnnotationMeta; detail: BrowserAnnotationDetail | undefined }) {
  const [thumbnail, setThumbnail] = useState<BrowserAnnotationThumbnail | null>(null);
  const { read, thumbnail: readThumbnail } = annotations;
  useEffect(() => { if (!detail) void read(meta.id).catch(ignore); }, [detail, read, meta.id]);
  useEffect(() => {
    let live = true;
    setThumbnail(null);
    if (meta.hasThumbnail) void readThumbnail(meta.id).then((image) => { if (live) setThumbnail(image); }).catch(ignore);
    return () => { live = false; };
  }, [meta.id, meta.hasThumbnail, readThumbnail]);
  const target = detail?.page.target;
  const resolution = detail?.resolution;

  return (
    <div data-annotation-record={meta.id} className="space-y-2 rounded-lg bg-muted/40 p-2.5">
      <div className="flex items-center gap-2">
        <StatusBadge meta={meta} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{target ? annotationElementLabel(target) : '…'}</span>
      </div>
      {thumbnail && <img alt={t('browserPanel.annotations.thumbnailAlt')} src={`data:${thumbnail.mimeType};base64,${thumbnail.data}`} className="max-h-40 max-w-full rounded-md object-contain" />}
      <p className={cn('whitespace-pre-wrap text-sm', !detail?.comment && 'italic text-muted-foreground')}>{detail?.comment || t('browserPanel.annotations.noComment')}</p>
      {resolution && (
        <p data-annotation-resolution="" className="text-xs text-muted-foreground">
          {resolution.status === 'resolved'
            ? t('browserPanel.annotations.resolvedSummary', { summary: resolution.summary ?? '' })
            : t('browserPanel.annotations.dismissedReason', { reason: resolution.reason ?? '' })}
        </p>
      )}
      {detail && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          <dt>{t('browserPanel.annotations.page')}</dt><dd className="min-w-0 truncate" title={detail.page.url}>{annotationPageLabel(detail.page)}</dd>
          {target?.selector && (
            <>
              <dt>{t('browserPanel.annotations.selector')}</dt>
              {/* code-font: a CSS selector is code */}
              <dd className="min-w-0 break-all font-mono">{target.selector}</dd>
            </>
          )}
          <dt>{t('browserPanel.annotations.source')}</dt><dd className="min-w-0 break-all">{sourceText(detail.source)}</dd>
        </dl>
      )}
      <RecordActions annotations={annotations} meta={meta} canShow={!!target?.selector} />
    </div>
  );
}

function RecordActions({ annotations, meta, canShow }: { annotations: BrowserAnnotationsHandle; meta: BrowserAnnotationMeta; canShow: boolean }) {
  const agent = annotations.target?.agent;
  return (
    <div className="flex flex-wrap gap-1.5">
      {/* A draft outside the current queue (an earlier session's) is sent here, by name, never with the queue. */}
      {meta.status === 'draft' && (
        <button type="button" className={action} disabled={annotations.busy || !annotations.target}
          title={agent ? t('browserPanel.annotations.sendOneTitle', { agent }) : t('browserPanel.annotations.noConversation')}
          onClick={() => { void annotations.post({ ids: [meta.id] }).catch(ignore); }}>
          <Send className="size-3" />{t('browserPanel.annotations.sendOne')}
        </button>
      )}
      <button type="button" className={action} disabled={!canShow || annotations.busy || !annotations.controlled} onClick={() => { void annotations.highlightAgain(meta.id).catch(ignore); }}>
        <Crosshair className="size-3" />{t('browserPanel.annotations.showOnPage')}
      </button>
      <button type="button" className={action} disabled={annotations.busy} onClick={() => { void annotations.remove(meta.id).catch(ignore); }}>
        <Trash2 className="size-3" />{t('browserPanel.annotations.delete')}
      </button>
    </div>
  );
}

/** The annotations of this browser, by page, newest first: reread, shown again, deleted. */
export function BrowserAnnotationsDrawer() {
  const chrome = useBrowserChrome();
  const annotations = useBrowserAnnotations();
  const rows = annotations?.annotations ?? [];
  const read = annotations?.read;
  const missing = rows.slice(0, DETAILS_READ).filter((row) => !annotations?.details[row.id]).map((row) => row.id).join(',');
  // Each row shows its comment and page: read the ones not read yet, a bounded number at a time.
  useEffect(() => {
    if (!read || annotations?.owner !== true || !missing) return;
    for (const id of missing.split(',')) void read(id).catch(ignore);
  }, [read, missing, annotations?.owner]);
  if (!chrome || !annotations) return null;
  const selected = rows.find((row) => row.id === annotations.selectedId) ?? null;
  const pages = new Map<string, BrowserAnnotationMeta[]>();
  for (const row of rows) {
    const detail = annotations.details[row.id];
    const page = detail ? annotationPageLabel(detail.page) : '…';
    pages.set(page, [...(pages.get(page) ?? []), row]);
  }

  return (
    <div className="flex min-h-full flex-col gap-3 p-3">
      <div className="flex items-center gap-2">
        {selected && (
          <button type="button" className={iconButton} aria-label={t('browserPanel.annotations.back')} title={t('browserPanel.annotations.back')} onClick={() => annotations.open(null)}>
            <ArrowLeft className="size-4" />
          </button>
        )}
        <h2 className="flex-1 text-sm font-medium">{t('browserPanel.annotations.history')}</h2>
        <button type="button" className={iconButton} aria-label={t('browserPanel.annotations.close')} onClick={() => chrome.closeDrawer()}><X className="size-4" /></button>
      </div>
      {annotations.error && <p role="alert" className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{annotations.error}</p>}
      {annotations.owner === false && <p className="text-xs text-muted-foreground">{t('browserPanel.annotations.notOwner')}</p>}
      {annotations.owner === true && (selected ? (
        <AnnotationRecord annotations={annotations} meta={selected} detail={annotations.details[selected.id]} />
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('browserPanel.annotations.empty')}</p>
      ) : (
        <div className="space-y-4" aria-label={t('browserPanel.annotations.history')}>
          {[...pages].map(([page, pageRows]) => (
            <section key={page} data-annotation-page={page} className="space-y-1">
              <h3 className="truncate px-2 text-[11px] font-medium text-muted-foreground">{page}</h3>
              <ul className="space-y-1">
                {pageRows.map((row) => {
                  const detail = annotations.details[row.id];
                  return (
                    <li key={row.id} className="group flex items-start gap-1 rounded-md hover:bg-muted">
                      <button type="button" data-annotation-row={row.id} className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left" onClick={() => annotations.open(row.id)}>
                        <StatusBadge meta={row} />
                        <span className="min-w-0 flex-1">
                          <span className={cn('block truncate text-xs', detail?.comment ? 'text-foreground' : 'italic text-muted-foreground')}>{detail?.comment || t('browserPanel.annotations.noComment')}</span>
                          <span className="block truncate text-[11px] text-muted-foreground">{detail ? annotationElementLabel(detail.page.target) : '…'}</span>
                        </span>
                        {row.hasThumbnail && <ImageIcon aria-hidden className="mt-0.5 size-3 shrink-0 text-muted-foreground" />}
                      </button>
                      <button type="button" className={cn(iconButton, 'mt-0.5')} disabled={!detail?.page.target.selector || annotations.busy || !annotations.controlled}
                        aria-label={t('browserPanel.annotations.showOnPage')} title={t('browserPanel.annotations.showOnPage')}
                        onClick={() => { void annotations.highlightAgain(row.id).catch(ignore); }}>
                        <Crosshair className="size-3.5" />
                      </button>
                      <button type="button" className={cn(iconButton, 'mt-0.5')} disabled={annotations.busy}
                        aria-label={t('browserPanel.annotations.delete')} title={t('browserPanel.annotations.delete')}
                        onClick={() => { void annotations.remove(row.id).catch(ignore); }}>
                        <Trash2 className="size-3.5" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      ))}
    </div>
  );
}

type QueuedPick = { id: string; rect: BrowserAnnotationRect | null; comment: string; label: string };
type OpenBubble = { mode: 'new' | 'edit'; id: string; rect: BrowserAnnotationRect | null; label: string; text: string };

/** The PWA's way: points over the page's video, draws the highlight, the bubble and its pins; the native view does it all itself. */
export function BrowserAnnotationLayer() {
  const surface = useBrowserSurface();
  const annotations = useBrowserAnnotations();
  const asking = useRef(false);
  const next = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [queue, setQueue] = useState<QueuedPick[]>([]);
  const [open, setOpen] = useState<OpenBubble | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const preview = annotations?.preview;
  const active = !!surface && !!annotations && !surface.native && !surface.blocked && annotations.owner === true && annotations.live?.active === true;
  const comment = annotations?.comment;
  const remove = annotations?.remove;
  // The pins and the open bubble follow their elements as the page scrolls or resizes.
  const followIds = active ? [...new Set([...queue.map((item) => item.id), ...(open ? [open.id] : [])])] : [];
  const followed = useFollowedRects(annotations?.follow, followIds);
  /** The element's rectangle now: as last reported, else as pointed; `null` once gone from the page. */
  const now = (id: string, pointed: BrowserAnnotationRect | null) => (id in followed ? followed[id] ?? null : pointed);

  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    const measure = () => setBox((current) => (current.width === node.offsetWidth && current.height === node.offsetHeight ? current : { width: node.offsetWidth, height: node.offsetHeight }));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [active]);
  // Annotate mode ended with a bubble open: what was typed joins the queue, an empty pick goes.
  useEffect(() => {
    if (active) return;
    const left = openRef.current;
    if (left?.mode === 'new') {
      if (left.text.trim()) void comment?.(left.id, left.text).catch(ignore);
      else void remove?.(left.id).catch(ignore);
    }
    setOpen(null);
    setQueue([]);
    setError(null);
  }, [active, comment, remove]);

  // One preview in flight; the latest point waits for it, the ones in between are dropped.
  const ask = (point: { x: number; y: number }) => {
    if (!preview) return;
    if (asking.current) { next.current = point; return; }
    asking.current = true;
    void preview(point.x, point.y).catch(ignore).finally(() => {
      asking.current = false;
      const queued = next.current;
      next.current = null;
      if (queued) ask(queued);
    });
  };
  if (!active || !surface || !annotations) return <div ref={frame} className="pointer-events-none absolute inset-0" />;

  const focusPage = () => { frame.current?.closest<HTMLElement>('[tabindex="0"]')?.focus(); };
  const close = () => { setOpen(null); setError(null); focusPage(); };
  /** Adds the open new annotation to the queue with its comment, or saves the reopened one. */
  const commit = async (bubble: OpenBubble, text: string): Promise<boolean> => {
    try {
      await annotations.comment(bubble.id, text);
    } catch (failure) { setError((failure as Error).message); return false; }
    setQueue((current) => (current.some((item) => item.id === bubble.id)
      ? current.map((item) => (item.id === bubble.id ? { ...item, comment: text.trim() } : item))
      : [...current, { id: bubble.id, rect: bubble.rect, comment: text.trim(), label: bubble.label }]));
    return true;
  };
  /** A bubble left for another pick: a typed annotation joins the queue, an empty one is dropped. */
  const settle = async () => {
    const left = openRef.current;
    if (!left) return;
    setOpen(null);
    if (left.mode === 'new') {
      if (left.text.trim()) await commit(left, left.text);
      else await annotations.remove(left.id).catch(ignore);
    }
  };
  const pickAt = async (point: { x: number; y: number }) => {
    const anchor = annotations.hover;
    await settle();
    setError(null);
    const saved = await annotations.pick(point.x, point.y);
    // The daemon's order is not a promise: the bubble opens on the latest pick by its creation.
    const newest = newestBrowserAnnotation(saved.annotations);
    if (!newest) return;
    const detail = await annotations.read(newest.id).catch(() => null);
    setOpen({
      mode: 'new', id: newest.id, rect: detail?.page.rect ?? anchor, text: '',
      label: detail ? annotationElementLabel(detail.page.target) : '',
    });
  };

  const take = (event: ReactPointerEvent) => { event.preventDefault(); };
  // The surface keeps the keyboard: Escape reaches the page, whose preload ends annotate mode.
  const press = (event: ReactPointerEvent) => { take(event); focusPage(); };
  const toSurface = (rect: BrowserAnnotationRect | null): SurfaceRect | null => (rect ? surface.toSurface(rect) : null);
  const visible = (rect: BrowserAnnotationRect | null) => (rect && inViewport(rect, surface.viewport) ? rect : null);
  // A bubble whose element is gone stays where it was: what is being typed is not lost.
  const openRect = open ? now(open.id, open.rect) ?? open.rect : null;
  const shown = open ? [visible(openRect)] : [annotations.highlight, annotations.hover];
  const rects = shown.filter((rect): rect is BrowserAnnotationRect => !!rect).map(toSurface).filter((rect): rect is SurfaceRect => !!rect);
  const numberOf = (id: string) => { const index = queue.findIndex((item) => item.id === id); return index < 0 ? queue.length + 1 : index + 1; };

  const send = async (bubble: OpenBubble, text: string) => {
    if (text.trim() && (bubble.mode === 'new' || queue.find((item) => item.id === bubble.id)?.comment !== text.trim())) {
      if (!await commit(bubble, text)) return;
    }
    const ids = [...new Set([...queue.map((item) => item.id), ...(bubble.mode === 'new' && text.trim() ? [bubble.id] : [])])];
    if (!ids.length) return;
    try {
      await annotations.post({ ids });
    } catch (failure) {
      setOpen({ ...bubble, mode: queue.some((item) => item.id === bubble.id) || text.trim() ? 'edit' : bubble.mode, text });
      setError((failure as Error).message);
      return;
    }
    setQueue([]);
    setOpen(null);
    setError(null);
    // As on the desktop: once the queue is sent, annotate mode ends.
    void annotations.stop().catch(ignore);
  };

  return (
    <div ref={frame} className="pointer-events-none absolute inset-0">
      <div
        data-annotation-layer=""
        className="pointer-events-auto absolute inset-0 cursor-crosshair"
        onPointerDown={press}
        onPointerMove={(event) => { take(event); if (open) return; const point = surface.toPage(event.clientX, event.clientY); if (point) ask(point); }}
        onPointerUp={(event) => {
          take(event);
          if (event.button !== 0) return;
          const point = surface.toPage(event.clientX, event.clientY);
          if (point && !annotations.busy) void pickAt(point).catch((failure: unknown) => setError((failure as Error).message));
        }}
        onPointerCancel={take}
      >
        {rects.map((rect, index) => (
          <div key={index} data-annotation-highlight="" aria-hidden className="pointer-events-none absolute rounded-sm bg-primary/10 ring-2 ring-primary"
            style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />
        ))}
      </div>
      {queue.map((item, index) => {
        // Scrolled away or gone: no pin, rather than one stuck at the edge over another element.
        const rect = toSurface(visible(now(item.id, item.rect)));
        if (!rect) return null;
        return (
          <AnnotationPin key={item.id} number={index + 1} rect={rect} comment={item.comment}
            onOpen={() => { void settle().then(() => setOpen({ mode: 'edit', id: item.id, rect: item.rect, label: item.label, text: item.comment })); }} />
        );
      })}
      {open && (
        <AnnotationBubble
          mode={open.mode}
          number={numberOf(open.id)}
          label={open.label}
          initial={open.text}
          anchor={toSurface(openRect)}
          box={box}
          queued={queue.length}
          canSend={!!annotations.target}
          busy={annotations.busy}
          error={error}
          onDraft={(text) => setOpen((current) => (current && current.id === open.id ? { ...current, text } : current))}
          onAdd={(text) => { void commit(open, text).then((ok) => { if (ok) close(); }); }}
          onSend={(text) => { void send(open, text); }}
          onCancel={() => {
            // Escape cancels a new annotation (its pick is dropped) and closes a reopened one unchanged.
            if (open.mode === 'new') void annotations.remove(open.id).catch(ignore);
            close();
          }}
          onDelete={() => {
            void annotations.remove(open.id).then(() => { setQueue((current) => current.filter((item) => item.id !== open.id)); close(); }).catch(ignore);
          }}
        />
      )}
    </div>
  );
}

export const browserAnnotationsClient: BundledClientPlugin = {
  module: BROWSER_ANNOTATIONS_MODULE,
  // `useBrowserAnnotations()` reads and acts only for a plugin that holds it, like `command()`.
  permissions: [BROWSER_CONTROL_PERMISSION],
  apply(ctx) {
    ctx.register({ slot: BROWSER_TOOLBAR_SLOT }, BrowserAnnotateControl);
    ctx.register({ slot: BROWSER_DRAWER_SLOT, key: BROWSER_ANNOTATIONS_DRAWER }, BrowserAnnotationsDrawer);
    ctx.register({ slot: BROWSER_SURFACE_SLOT }, BrowserAnnotationLayer);
  },
};
