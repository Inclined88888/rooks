'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';

import { t as i18n } from '@/lib/i18n';
import { galleryPosition, neighbourImage } from '@/lib/file-preview/gallery';
import { rawFileUrl, type PreviewKind } from '@/lib/file-preview/kind';
import { OfficePreview } from './office-preview';

/* ─────────────────────────────────────────────────────────────────
   File preview — the Files widget's viewer for what is not text:
   images, videos, PDFs and Office documents. Read-only; the bytes come
   from GET /api/ui/agents/<name>/files/raw (same origin, session cookie).
   Shown as an island of the workspace (`file-island.tsx`): beside the chat,
   the file stays in view while the conversation goes on.
   ──────────────────────────────────────────────────────────────────── */

type Probe = { status: 'checking' } | { status: 'ok' } | { status: 'error'; message: string };

/** Asks the daemon for one byte first, so a refusal (too large, no preview,
 *  outside the folder) reads as a sentence and not as JSON in a player. */
function useProbe(url: string, enabled: boolean): Probe {
  const [probe, setProbe] = useState<Probe>(enabled ? { status: 'checking' } : { status: 'ok' });
  useEffect(() => {
    if (!enabled) { setProbe({ status: 'ok' }); return; }
    let cancelled = false;
    setProbe({ status: 'checking' });
    fetch(url, { headers: { range: 'bytes=0-0' }, cache: 'no-store' }).then(
      (r) => {
        if (cancelled) return;
        void r.arrayBuffer().catch(() => undefined);
        if (r.ok) setProbe({ status: 'ok' });
        else setProbe({ status: 'error', message: r.status === 413 ? i18n('filePreview.tooLarge') : r.status === 415 ? i18n('filePreview.noPreview') : i18n('filePreview.openFailed') });
      },
      () => { if (!cancelled) setProbe({ status: 'error', message: i18n('filePreview.openFailed') }); },
    );
    return () => { cancelled = true; };
  }, [url, enabled]);
  return probe;
}

type PreviewProps = {
  agentId: string;
  path: string;
  kind: PreviewKind;
  onClose: () => void;
  /** The pictures of the folder `path` was opened from, in listing order: they make a gallery. */
  images?: readonly string[];
  onNavigate?: (path: string) => void;
  /** A file outside the agent's folder the user confirmed; `path` is absolute. */
  external?: boolean;
};

/** Position in the gallery and download: the window puts them in its header. */
export function FilePreviewActions({
  agentId,
  path,
  kind,
  images,
  onNavigate,
  external = false,
}: Omit<PreviewProps, 'onClose'>) {
  const gallery = kind === 'image' && images && onNavigate ? images : undefined;
  const position = gallery ? galleryPosition(gallery, path) : null;
  const name = path.split('/').pop() || path;
  return (
    <>
      {position && (
        <span
          className="shrink-0 px-1 text-[11.5px] tabular-nums text-muted-foreground"
          aria-label={i18n('filePreview.imagePosition', { index: position.index, total: position.total })}
        >
          {position.index} / {position.total}
        </span>
      )}
      <a
        href={rawFileUrl(agentId, path, true, external)}
        download={name}
        aria-label={i18n('filePreview.download')}
        title={i18n('filePreview.download')}
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Download className="size-3.5" />
      </a>
    </>
  );
}

/** What the viewer shows, without its window. */
export function FilePreviewBody({
  agentId,
  path,
  kind,
  onClose,
  images,
  onNavigate,
  external = false,
  autoFocus = true,
}: Omit<PreviewProps, 'onClose'> & {
  /** Absent: Escape closes nothing (an island tab is closed from its header). */
  onClose?: () => void;
  /** Takes the focus on mount and on each new file. An island tab, mounted again on every switch, does not. */
  autoFocus?: boolean;
}) {
  const url = rawFileUrl(agentId, path, false, external);
  const office = kind === 'docx' || kind === 'xlsx' || kind === 'pptx';
  const probe = useProbe(url, !office);
  // Keyed by address: moving to another picture must not inherit the last one's failure.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const mediaFailed = failedUrl === url;

  const gallery = kind === 'image' && images && onNavigate ? images : undefined;
  const position = gallery ? galleryPosition(gallery, path) : null;
  const prev = gallery ? neighbourImage(gallery, path, -1) : null;
  const next = gallery ? neighbourImage(gallery, path, 1) : null;

  const box = useRef<HTMLDivElement | null>(null);
  // Opened from the Files tree, the focus is still on the tree: bring it here
  // so the arrows turn the pages. The window paints its content a tick late,
  // hence the callback ref for the first file.
  const attachBox = useCallback((el: HTMLDivElement | null) => {
    box.current = el;
    if (autoFocus) el?.focus({ preventScroll: true });
  }, [autoFocus]);
  useEffect(() => { if (autoFocus) box.current?.focus({ preventScroll: true }); }, [path, autoFocus]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || !focusedWithin(box.current)) return;
      if (e.key === 'Escape') { onClose?.(); return; }
      // Alt+Arrow is the browser's own back/forward.
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const target = e.key === 'ArrowLeft' ? prev : e.key === 'ArrowRight' ? next : null;
      if (target && onNavigate) { e.preventDefault(); onNavigate(target); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onNavigate, prev, next]);

  const name = path.split('/').pop() || path;
  const failure = probe.status === 'error' ? probe.message : mediaFailed ? i18n('filePreview.openFailed') : null;

  let body: React.ReactNode;
  if (office) {
    body = <OfficePreview url={url} kind={kind} />;
  } else if (failure) {
    body = <div className="grid flex-1 place-items-center p-8 text-center text-[12.5px] text-muted-foreground">{failure}</div>;
  } else if (probe.status === 'checking') {
    body = <div className="grid flex-1 place-items-center p-8 text-[12.5px] text-muted-foreground">{i18n('filePreview.checking')}</div>;
  } else if (kind === 'image') {
    body = (
      <div className="grid min-h-0 flex-1 place-items-center overflow-auto bg-muted/20 p-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={name} referrerPolicy="no-referrer" onError={() => setFailedUrl(url)} className="max-h-full max-w-full object-contain" />
      </div>
    );
  } else if (kind === 'video') {
    body = (
      <div className="grid min-h-0 flex-1 place-items-center bg-black">
        <video src={url} controls preload="metadata" onError={() => setFailedUrl(url)} className="max-h-full max-w-full" />
      </div>
    );
  } else {
    // A PDF is shown by the browser's own viewer. The daemon only ever serves
    // `application/pdf` here, a type that cannot run script in our origin.
    body = <iframe src={url} title={name} referrerPolicy="no-referrer" className="min-h-0 w-full flex-1 border-0 bg-background" />;
  }

  return (
    <div ref={attachBox} tabIndex={-1} aria-label={name} className="absolute inset-0 flex flex-col bg-popover outline-none">
      {body}
      {position && onNavigate && (
        <>
          <GalleryButton side="left" target={prev} onNavigate={onNavigate} label={i18n('filePreview.previousImage')} />
          <GalleryButton side="right" target={next} onNavigate={onNavigate} label={i18n('filePreview.nextImage')} />
        </>
      )}
    </div>
  );
}

/**
 * The window is not modal: docked beside the chat, Escape or an arrow typed
 * in the composer must not close it or turn the page. It reacts when the
 * focus is inside it, or nowhere in particular. Outside a window (an island
 * of the workspace, beside others), only when the focus is inside it.
 */
export function focusedWithin(box: HTMLElement | null): boolean {
  const active = document.activeElement;
  const frame = box?.closest('[role="dialog"]');
  if (!active || active === document.body) return !box || !!frame;
  const scope = frame ?? box;
  return !!scope && scope.contains(active);
}

/** Previous / next picture, drawn over the side of the viewer; disabled at the end of the folder. */
function GalleryButton({ side, target, onNavigate, label }: {
  side: 'left' | 'right';
  target: string | null;
  onNavigate: (path: string) => void;
  label: string;
}) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      disabled={!target}
      onClick={() => { if (target) onNavigate(target); }}
      aria-label={label}
      title={label}
      className={`absolute top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-full border border-border bg-popover/90 text-foreground shadow-elev-2 hover:bg-muted disabled:pointer-events-none disabled:opacity-30 ${side === 'left' ? 'left-3' : 'right-3'}`}
    >
      <Icon className="size-5" />
    </button>
  );
}
