'use client';

/**
 * A file of an agent's folder as a content of the island workspace
 * (`@timon/files-widget:file`, `docs/ISLAND-WORKSPACE.md` §7).
 *
 * It reads its file with its own params. A file renamed, moved or deleted
 * from the tree closes its tab, through `onFilesGone` (`lib/file-viewer.ts`).
 * A tab the user closes with unsaved changes asks first (`confirmDocumentClose`).
 */

import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useIslandContent } from '@/components/islands/island-content';
import { t } from '@/lib/i18n';
import type { IslandParams, TabId } from '@/lib/island-tree';
import { previewKindFor } from '@/lib/file-preview/kind';
import { galleryOf, isUnderPath, onFilesGone, readAgentFile } from '@/lib/file-viewer';
import { FileEditorPane, saveAgentFile, type EditorMode } from './file-editor-overlay';
import { FilePreviewActions, FilePreviewBody, focusedWithin } from './file-preview-overlay';
import { askToSaveDocument } from './unsaved-document-dialog';
import type { FileBody } from './chat-types';

export { FILE_ISLAND_KEY, FILE_ISLAND_TYPE, fileIslandContent, parseFileIslandParams, normalizeFilePath } from '@/lib/file-island-content';

const baseName = (path: string): string => path.split(/[\\/]/).pop() || path;

// Unsaved text per tab. An inactive tab is unmounted (§8): switching to the
// next tab and back must not lose what was typed, and closing it must still
// know what to save and where — hence the loaded file and its source beside
// the text. Not stored: a reload loses it, after the browser's own warning.
type Draft = { text: string; file: FileBody; source: TextDocumentSource; name: string };
const drafts = new Map<TabId, Draft>();

/** Tests only: a draft as typing in the editor leaves it, for a tab mounted or not. */
export function putDocumentDraftForTests(tabId: TabId, draft: Draft | null): void { putDraft(tabId, draft); }
export function documentDraftForTests(tabId: TabId): string | null { return drafts.get(tabId)?.text ?? null; }

const isDirty = (draft: Draft): boolean => draft.text !== draft.file.content;

function putDraft(tabId: TabId, draft: Draft | null): void {
  if (draft) drafts.set(tabId, draft);
  else drafts.delete(tabId);
  syncUnloadGuard();
}

// Leaving the page (reload, closing the window) while a document has unsaved
// changes: the browser's own question, the only one it lets a page ask.
let unloadGuard: ((e: BeforeUnloadEvent) => void) | null = null;
function syncUnloadGuard(): void {
  if (typeof window === 'undefined') return;
  const needed = [...drafts.values()].some(isDirty);
  if (needed && !unloadGuard) {
    unloadGuard = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', unloadGuard);
  } else if (!needed && unloadGuard) {
    window.removeEventListener('beforeunload', unloadGuard);
    unloadGuard = null;
  }
}

/**
 * `beforeClose` of a content that shows a `TextDocumentIsland`: a tab with
 * unsaved changes asks Save / Don't save / Cancel, and closes only once they
 * are saved or given up. Works for an inactive tab, unmounted: the draft
 * keeps what it needs. "Don't save" leaves the draft in place: closing an
 * island asks its tabs one by one, and a Cancel on a later one keeps them
 * all — `forgetDocumentDraft` drops it once the tab is really gone.
 */
export function confirmDocumentClose(_params: IslandParams, tabId: TabId): boolean | Promise<boolean> {
  const draft = drafts.get(tabId);
  if (!draft || !isDirty(draft)) return true;
  return askToSaveDocument(draft.name, () => draft.source.save(draft.file, draft.text)).then((choice) => {
    if (choice === 'cancelled') return false;
    // Written to disk: nothing left to lose, whether the tab closes or stays.
    if (choice === 'saved') putDraft(tabId, null);
    return true;
  });
}

/** `onClose` of the same contents: the tab is gone, and its unsaved text with it. */
export function forgetDocumentDraft(_params: IslandParams, tabId: TabId): void {
  putDraft(tabId, null);
}

export function FileIsland(): ReactElement {
  const { tabId, params, setParams, setTitle, close } = useIslandContent();
  const agentId = typeof params.agentId === 'string' ? params.agentId : '';
  const path = typeof params.path === 'string' ? params.path : '';
  const external = params.external === true;
  const kind = previewKindFor(path);

  useEffect(() => { setTitle(baseName(path)); }, [path, setTitle]);

  useEffect(() => onFilesGone((gone) => {
    if (!external && gone.agentId === agentId && isUnderPath(path, gone.path)) {
      putDraft(tabId, null);
      close();
    }
  }), [agentId, path, external, tabId, close]);

  if (kind) {
    // The folder's pictures, when the tree opened this one: the arrows turn through them.
    const images = kind === 'image' ? galleryOf(agentId, path) : undefined;
    const onNavigate = images ? (next: string) => setParams({ ...params, path: next }) : undefined;
    return (
      <div className="relative flex h-full min-h-0 flex-col bg-popover">
        <div className="flex shrink-0 items-center gap-1.5 px-3 py-1 text-[11.5px] text-muted-foreground">
          <span className="min-w-0 flex-1 truncate" title={path}>{path}</span>
          <FilePreviewActions agentId={agentId} path={path} kind={kind} external={external} images={images} onNavigate={onNavigate} />
        </div>
        <div className="relative min-h-0 flex-1">
          <FilePreviewBody agentId={agentId} path={path} kind={kind} external={external} images={images} onNavigate={onNavigate} autoFocus={false} />
        </div>
      </div>
    );
  }
  return (
    <TextDocumentIsland
      key={`${agentId}:${path}`}
      tabId={tabId}
      source={agentFileSource(agentId, path, external)}
      mode={params.mode === 'edit' ? 'edit' : 'view'}
      onMode={(next) => setParams({ ...params, mode: next === 'edit' ? 'edit' : 'preview' })}
    />
  );
}

/**
 * Where a text document of an island is read from and written to. The file
 * island reads an agent's folder; another content (a skill) brings its own,
 * and the editor, the draft and Cmd+S stay the same.
 */
export type TextDocumentSource = {
  load(): Promise<{ file: FileBody } | { error: string }>;
  /** Writes `text` over `file`; says so in a toast either way. */
  save(file: FileBody, text: string): Promise<boolean>;
};

export function agentFileSource(agentId: string, path: string, external: boolean): TextDocumentSource {
  return {
    load: async () => {
      const r = await readAgentFile(agentId, path, external);
      if ('file' in r) return { file: r.file };
      return { error: r.status === 403 ? t('fileLink.forbidden') : t('fileLink.openFailed', { path }) };
    },
    save: (file, text) => saveAgentFile(agentId, file, text),
  };
}

type Loaded = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; file: FileBody };

/**
 * A text document in an island: previewed or edited, its unsaved text kept
 * per tab. The parent keys it by what it reads: a new source is a new document.
 */
export function TextDocumentIsland({ tabId, source, mode, onMode, readOnly = false, header, name }: {
  tabId: TabId;
  source: TextDocumentSource;
  mode: EditorMode;
  onMode: (mode: EditorMode) => void;
  /** Previewed only, whatever `mode` says: params may come from an agent's proposal. */
  readOnly?: boolean;
  /** What the content says about its document, above the toolbar. */
  header?: ReactNode;
  /** How the unsaved-changes question names the document. Default: the file's name. */
  name?: string;
}): ReactElement {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [draft, setDraftState] = useState<string | null>(() => drafts.get(tabId)?.text ?? null);
  const [saving, setSaving] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // Rebuilt at each render of the parent: only the first one is read, the key
  // above stands for its identity.
  const src = useRef(source).current;

  useEffect(() => {
    let alive = true;
    void src.load().then((r) => {
      if (!alive) return;
      if ('file' in r) {
        // A draft kept from before is judged, and saved, against what is on disk now.
        const kept = drafts.get(tabId);
        if (kept) putDraft(tabId, { ...kept, file: r.file, source: src });
        setLoaded({ status: 'ok', file: r.file });
      } else setLoaded({ status: 'error', message: r.error });
    });
    return () => { alive = false; };
  }, [src, tabId]);

  const file = loaded.status === 'ok' ? loaded.file : null;
  const label = name ?? (file ? baseName(file.path) : '');

  const setDraft = useCallback((text: string | null) => {
    putDraft(tabId, text === null || !file ? null : { text, file, source: src, name: label });
    setDraftState(text);
  }, [tabId, file, src, label]);
  const text = draft ?? file?.content ?? '';
  const dirty = !!file && draft !== null && draft !== file.content;

  const save = useCallback(async () => {
    if (!file || !dirty) return;
    setSaving(true);
    try {
      if (!(await src.save(file, text))) return;
      const fresh = await src.load();
      if ('file' in fresh) setLoaded({ status: 'ok', file: fresh.file });
      setDraft(null);
    } finally {
      setSaving(false);
    }
  }, [file, dirty, src, text, setDraft]);

  // Cmd+S / Ctrl+S while the focus is in this island: beside other islands,
  // keys typed elsewhere are not ours.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!focusedWithin(box.current)) return;
      if ((e.metaKey || e.ctrlKey) && e.key === 's' && mode === 'edit' && !readOnly) {
        e.preventDefault();
        void save();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, readOnly, save]);

  if (!file) {
    return (
      <div className="grid h-full place-items-center bg-popover p-8 text-center text-[12.5px] text-muted-foreground">
        {loaded.status === 'error' ? loaded.message : t('filePreview.checking')}
      </div>
    );
  }
  return (
    <div ref={box} tabIndex={-1} className="absolute inset-0 flex flex-col bg-popover outline-none">
      {header}
      <FileEditorPane
        file={file}
        draft={text}
        onDraft={setDraft}
        mode={mode}
        onMode={onMode}
        dirty={dirty}
        saving={saving}
        onSave={() => void save()}
        readOnly={readOnly}
      />
    </div>
  );
}
