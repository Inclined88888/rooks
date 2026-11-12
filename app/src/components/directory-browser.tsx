'use client';

/**
 * Folder browser of the active daemon (TIM-0136), and `useDirectoryPicker()`,
 * the one way a form asks for a folder — or for a file the daemon reads
 * (`pickFile`, TODO #791: a plugin archive, a CLI binary). On this computer's own daemon, in the
 * desktop, it opens the OS dialog as before; on another machine or in a
 * browser, a dialog fed by the daemon that will read the path
 * (`lib/directory-pick.ts`).
 *
 * That dialog is the host of the `directory.picker` slot: it keeps the frame
 * (name, focus, Escape) and the daemon's calls, and paints the slot's
 * occupant inside — the product's browser below (`fallback`, client half of
 * `@rooks/settings`) unless a plugin took it. An occupant never builds a path:
 * it shows the levels the daemon serves and hands back one it showed. A path
 * typed in its field goes to the daemon too, which says whether it exists there.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { ArrowUp, File as FileIcon, Folder, HardDrive, Home, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { DirectoryBrowserProvider, useDirectoryBrowser, type DirectoryBrowserValue } from '@/components/directory-browser-context';
import { desktopBridge } from '@/lib/desktop';
import {
  DIRECTORY_MODE, directoryPickSource, openingListing, pickDirectory, readDirectories,
  type DirectoryListError, type DirectoryListing, type DirectoryPick, type DirectoryPickMode, type DirectoryRead,
} from '@/lib/directory-pick';
import { activeMachineId } from '@/lib/machines/machine-storage';
import { SlotSingle, useSlotEntries } from '@/lib/plugin-host/render';
import { DIRECTORY_PICKER_SLOT } from '@/lib/plugin-host/slots';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** The product's folder browser: the default occupant of `directory.picker`. `null` outside a host. */
export function ProductDirectoryBrowser(): ReactElement | null {
  const host = useDirectoryBrowser();
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState<DirectoryListError | null>(null);
  const [loading, setLoading] = useState(false);
  const [typed, setTyped] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  // File mode: the file the Choose button hands back.
  const [selected, setSelected] = useState<string | null>(null);
  // A late answer for a level the user already left must not repaint it.
  const generation = useRef(0);

  const land = useCallback(async (read: () => Promise<DirectoryRead>) => {
    const mine = ++generation.current;
    setLoading(true);
    const out = await read();
    if (mine !== generation.current) return;
    setLoading(false);
    if (out.ok) {
      setListing(out.listing);
      setSelected(out.listing.selected ?? null);
      setTyped(out.listing.selected ?? out.listing.path);
      setError(null);
    } else {
      setError(out.error);
    }
  }, []);

  // The host mounts one occupant per request: opening once is enough.
  const opening = host?.opening;
  useEffect(() => {
    if (opening) void land(opening);
    return () => { generation.current += 1; };
  }, [opening, land]);

  if (!host) return null;
  const fileMode = host.mode === 'file';
  // File mode words its own strings; the shared ones (Up, Home…) stay.
  const k = (key: string): string => (fileMode ? `directoryBrowser.file.${key}` : `directoryBrowser.${key}`);
  const errorKey = (code: DirectoryListError): string => (
    fileMode && (code === 'forbidden' || code === 'outdated') ? `directoryBrowser.file.errors.${code}` : `directoryBrowser.errors.${code}`
  );
  const go = (path: string | null) => { void land(() => host.read(path)); };
  const entries = listing ? listing.entries.filter((entry) => showHidden || !entry.hidden) : [];
  const files = fileMode && listing ? (listing.files ?? []).filter((entry) => showHidden || !entry.hidden || entry.path === selected) : [];
  const blocking = error === 'forbidden' || error === 'outdated';
  const nothing = entries.length === 0 && files.length === 0;

  return (
    <>
      {/* The host names the dialog for assistive technology; this is what the eye reads. */}
      <div aria-hidden className="flex flex-col gap-1.5 pr-6">
        <h2 className="m-0 text-lg font-semibold leading-none tracking-tight">{t(k('title'))}</h2>
        <p className="m-0 text-sm text-muted-foreground">{t(k('description'))}</p>
      </div>

      <form
        className="flex items-center gap-2"
        onSubmit={(event) => { event.preventDefault(); if (typed.trim()) go(typed.trim()); }}
      >
        <Input
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          aria-label={t(k('pathLabel'))}
          className="h-8 flex-1 text-[12px]"
          disabled={blocking}
        />
        <Button type="submit" variant="outline" size="sm" className="h-8 text-[12px]" disabled={blocking || !typed.trim()}>
          {t('directoryBrowser.go')}
        </Button>
      </form>

      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="ghost" size="sm" className="h-7 gap-1.5 text-[12px]"
          disabled={!listing?.parent || loading}
          onClick={() => go(listing?.parent ?? null)}
        >
          <ArrowUp className="size-3.5" aria-hidden />
          {t('directoryBrowser.up')}
        </Button>
        <Button
          variant="ghost" size="sm" className="h-7 gap-1.5 text-[12px]"
          disabled={!listing || loading}
          onClick={() => go(listing?.home ?? null)}
        >
          <Home className="size-3.5" aria-hidden />
          {t('directoryBrowser.home')}
        </Button>
        {(listing?.roots.length ?? 0) > 1 && listing?.roots.map((root) => (
          <Button
            key={root} variant="ghost" size="sm" className="h-7 gap-1.5 text-[12px]"
            disabled={loading} onClick={() => go(root)}
          >
            <HardDrive className="size-3.5" aria-hidden />
            {root}
          </Button>
        ))}
        <label className="ml-auto flex items-center gap-2 text-[12px] text-muted-foreground">
          <Switch checked={showHidden} onCheckedChange={setShowHidden} />
          {t(k('showHidden'))}
        </label>
      </div>

      {error && (
        <p role="alert" className="m-0 text-[12px] text-destructive">{t(errorKey(error))}</p>
      )}

      <div className="min-h-[200px] flex-1 overflow-y-auto rounded-md bg-muted/30 p-1" aria-busy={loading}>
        {loading && !listing && (
          <div className="flex h-full items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-label={t(k('loading'))} />
          </div>
        )}
        {listing && nothing && (
          <p className="m-0 px-3 py-6 text-center text-[12px] text-muted-foreground">{t(k('empty'))}</p>
        )}
        <ul className="m-0 list-none p-0" aria-label={t(k('listLabel'))}>
          {entries.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                disabled={loading}
                onClick={() => go(entry.path)}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-muted/70 disabled:opacity-60',
                  entry.hidden && 'text-muted-foreground',
                )}
              >
                <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate">{entry.name}</span>
              </button>
            </li>
          ))}
        </ul>
        {/* Set apart by spacing alone: no rule between folders and files. */}
        {files.length > 0 && (
          <ul className="m-0 mt-2 list-none p-0" aria-label={t('directoryBrowser.file.filesLabel')}>
            {files.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  disabled={loading}
                  aria-pressed={entry.path === selected}
                  onClick={() => setSelected(entry.path)}
                  onDoubleClick={() => host.choose(entry.path)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-muted/70 disabled:opacity-60',
                    entry.hidden && 'text-muted-foreground',
                    entry.path === selected && 'bg-primary/10 text-foreground hover:bg-primary/15',
                  )}
                >
                  <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate">{entry.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {listing?.truncated && (
          <p className="m-0 px-3 py-2 text-[11px] text-muted-foreground">{t(k('truncated'))}</p>
        )}
      </div>

      {fileMode && selected && (
        <p className="m-0 break-all text-[12px] text-muted-foreground">{t('directoryBrowser.file.selected', { path: selected })}</p>
      )}

      <DialogFooter className="gap-2">
        <Button variant="outline" size="sm" onClick={host.cancel}>{t('directoryBrowser.cancel')}</Button>
        <Button
          size="sm"
          disabled={!listing || loading || (fileMode && !selected)}
          onClick={() => {
            if (fileMode) { if (selected) host.choose(selected); } else if (listing) host.choose(listing.path);
          }}
        >
          {t(k('choose'))}
        </Button>
      </DialogFooter>
    </>
  );
}

type Request = { id: number; initialPath: string; mode: DirectoryPickMode };

/**
 * The frame of one folder request: a dialog named by the host whatever paints
 * inside, and the occupant of `directory.picker` — or the product's browser
 * while the slot is empty (settings module off, a page outside the bundled
 * halves), so a form never loses its picker.
 */
function DirectoryPickerHost({
  request, onChoose, onCancel,
}: {
  request: Request | null;
  onChoose: (id: number, path: string) => void;
  onCancel: (id: number) => void;
}): ReactElement {
  const claimed = useSlotEntries(DIRECTORY_PICKER_SLOT).length > 0;
  // The closing dialog keeps its last content through its exit animation; its
  // gestures no longer answer anything (`close` checks the open request).
  const last = useRef<Request | null>(null);
  if (request) last.current = request;
  const shown = request ?? last.current;
  const id = shown?.id ?? 0;
  const initialPath = shown?.initialPath ?? '';
  const mode = shown?.mode ?? DIRECTORY_MODE;
  // Bound to this request: a late call from an occupant of a request since
  // replaced must not answer the one now open.
  // File mode hands back only a file the daemon served for this request: an
  // occupant written for folders cannot answer a file request with a folder.
  // Kept by request id, not in the memo, which React may recompute at will.
  const servedRef = useRef<{ id: number; files: Set<string> }>({ id: 0, files: new Set() });
  if (servedRef.current.id !== id) servedRef.current = { id, files: new Set() };
  const value = useMemo<DirectoryBrowserValue>(() => {
    const served = servedRef.current.id === id ? servedRef.current.files : new Set<string>();
    const note = (out: DirectoryRead): DirectoryRead => {
      if (out.ok) {
        for (const file of out.listing.files ?? []) served.add(file.path);
        if (out.listing.selected) served.add(out.listing.selected);
      }
      return out;
    };
    return {
      mode: mode.kind,
      accept: mode.kind === 'file' ? mode.accept : [],
      initialPath,
      opening: () => openingListing(initialPath, fetch, mode).then(note),
      read: (path) => readDirectories(path, fetch, mode).then(note),
      choose: (path) => { if (mode.kind !== 'file' || served.has(path)) onChoose(id, path); },
      cancel: () => onCancel(id),
    };
  }, [id, initialPath, mode, onChoose, onCancel]);
  const fileMode = mode.kind === 'file';

  return (
    <Dialog open={request !== null} onOpenChange={(next) => { if (!next) onCancel(id); }}>
      <DialogContent className="flex max-h-[85vh] max-w-xl flex-col gap-3">
        <DialogTitle className="sr-only">{t(fileMode ? 'directoryBrowser.file.title' : 'directoryBrowser.title')}</DialogTitle>
        <DialogDescription className="sr-only">{t(fileMode ? 'directoryBrowser.file.description' : 'directoryBrowser.description')}</DialogDescription>
        {/* React bubbles through the portal: a form around the host (a project
            form) must not be submitted from inside the browser, whoever paints it. */}
        <div
          className="contents"
          onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); }}
        >
          {shown && (
            <DirectoryBrowserProvider key={shown.id} value={value}>
              {claimed ? <SlotSingle name={DIRECTORY_PICKER_SLOT} /> : <ProductDirectoryBrowser />}
            </DirectoryBrowserProvider>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

type Pending = Request & { resolve: (pick: DirectoryPick) => void };

/**
 * `pick(current)` asks for a folder where the active daemon reads it; the
 * caller renders `dialog` once, anywhere in its tree (the dialog portals out).
 *
 * `pickFile(current, accept)` asks for a file of the active daemon's disk,
 * always through its browser: the native file dialogs are specific to their
 * form (an archive, an executable), so a caller that can use one on this
 * computer's daemon opens it itself and calls `pickFile` otherwise. `accept`
 * lists endings (`.tgz`), `[]` takes any file.
 *
 * One request at a time: a second `pick` while the browser is open settles the
 * first as `cancelled` and takes its place, and an unmount settles the open one
 * the same way — a caller awaiting a pick is never left hanging.
 */
export function useDirectoryPicker(): {
  pick: (current: string) => Promise<DirectoryPick>;
  pickFile: (current: string, accept?: readonly string[]) => Promise<DirectoryPick>;
  dialog: ReactElement;
} {
  const [request, setRequest] = useState<Request | null>(null);
  const pending = useRef<Pending | null>(null);
  const sequence = useRef(0);

  const settle = useCallback((outcome: DirectoryPick) => {
    const open = pending.current;
    if (!open) return;
    pending.current = null;
    open.resolve(outcome);
  }, []);

  useEffect(() => () => settle({ status: 'cancelled' }), [settle]);

  const open = useCallback((current: string, mode: DirectoryPickMode): Promise<DirectoryPick> => {
    settle({ status: 'cancelled' });
    return new Promise<DirectoryPick>((resolve) => {
      const next: Request = { id: ++sequence.current, initialPath: current, mode };
      pending.current = { ...next, resolve };
      setRequest(next);
    });
  }, [settle]);

  const pick = useCallback(async (current: string): Promise<DirectoryPick> => {
    const bridge = desktopBridge();
    if (directoryPickSource(bridge, activeMachineId()) === 'native') return pickDirectory(bridge, current);
    return open(current, DIRECTORY_MODE);
  }, [open]);

  const pickFile = useCallback(
    (current: string, accept: readonly string[] = []): Promise<DirectoryPick> => open(current, { kind: 'file', accept }),
    [open],
  );

  const close = useCallback((id: number, outcome: DirectoryPick) => {
    if (pending.current?.id !== id) return;
    settle(outcome);
    setRequest(null);
  }, [settle]);
  const onChoose = useCallback((id: number, path: string) => close(id, { status: 'chosen', path }), [close]);
  const onCancel = useCallback((id: number) => close(id, { status: 'cancelled' }), [close]);

  const dialog = <DirectoryPickerHost request={request} onChoose={onChoose} onCancel={onCancel} />;
  return { pick, pickFile, dialog };
}

/** The toast every caller shows for a pick that did not land. */
export function reportDirectoryPick(pick: DirectoryPick): void {
  if (pick.status === 'unavailable') toast(t('editPage.directoryPickerUnavailable'));
  else if (pick.status === 'failed') toast.error(t('editPage.directoryPickerFailed'));
}
