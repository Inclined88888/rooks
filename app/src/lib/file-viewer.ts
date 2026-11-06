import { toast } from 'sonner';
import type { FileBody } from '@/components/chat/chat-types';
import type { PreviewKind } from '@/lib/file-preview/kind';
import { t } from '@/lib/i18n';
import { fileIslandContent } from '@/lib/file-island-content';
import { hljsLanguageFor } from '@/lib/file-icons';
import { openInIsland } from '@/lib/island-bus';

/**
 * Where the Files tree, the Git panel and links in the chat open a file: in
 * the island workspace of the view, as a popup — or a tab of the island that
 * already holds files (`groupBy`). A file is an island like any other
 * (`components/chat/file-island.tsx`), so there is no viewer window and no
 * store of open files: the tabs are the workspace's.
 */
export type Preview = { path: string; kind: PreviewKind; images?: readonly string[]; external?: boolean };

/** A file or folder renamed, moved or deleted, in an agent's folder. */
export type FilesGone = { agentId: string | null; path: string };
const goneListeners = new Set<(gone: FilesGone) => void>();

/** `path` is `root` or lies under it. */
export function isUnderPath(path: string, root: string): boolean {
  return path === root || path.startsWith(root + '/');
}

/**
 * Told whenever `closeUnder` runs. The island workspace's file tabs listen: a
 * renamed, moved or deleted file must close its tab (`docs/ISLAND-WORKSPACE.md` §7).
 */
export function onFilesGone(listener: (gone: FilesGone) => void): () => void {
  goneListeners.add(listener);
  return () => { goneListeners.delete(listener); };
}

/**
 * The pictures of the folder a picture was opened from, in listing order, by
 * `agentId` and path: params are flat primitives, so the list cannot ride in
 * the tab; the island that shows the picture asks for it here.
 */
const galleries = new Map<string, readonly string[]>();
const galleryKey = (agentId: string, path: string): string => `${agentId}\u0000${path}`;

export function galleryOf(agentId: string, path: string): readonly string[] | undefined {
  return galleries.get(galleryKey(agentId, path));
}

function show(agentId: string, path: string, options: { external?: boolean; mode: 'preview' | 'edit' }): void {
  if (!openInIsland(fileIslandContent(agentId, path, options), { edge: 'float' })) {
    toast.error(t('fileLink.noWorkspace'));
  }
}

export const fileViewer = {
  /**
   * A text file: in the editor, which reads it from the disk (unsaved text is
   * the tab's own). Markdown opens on its preview, wherever it is opened from
   * (tree, Git panel, chat link); `mode` overrides it — a file just created
   * is there to be written.
   */
  openText(agentId: string, file: FileBody, mode?: 'preview' | 'edit'): void {
    const name = file.path.split(/[\\/]/).pop() || file.path;
    const shown = mode ?? (hljsLanguageFor(name) === 'markdown' ? 'preview' : 'edit');
    show(agentId, file.path, { external: file.external === true, mode: shown });
  },
  openPreview(agentId: string, preview: Preview): void {
    if (preview.images && preview.images.length > 1) {
      for (const image of preview.images) galleries.set(galleryKey(agentId, image), preview.images);
    }
    show(agentId, preview.path, { external: preview.external === true, mode: 'preview' });
  },
  /** A deleted, renamed or moved file or folder: the tabs that hold what sat under it close. */
  closeUnder(path: string, agentId: string | null): void {
    for (const listener of goneListeners) listener({ agentId, path });
  },
};

/** Reads a text file of the agent's folder; null when it cannot be read. */
export async function loadAgentFile(agentId: string, rel: string, external = false): Promise<FileBody | null> {
  const r = await readAgentFile(agentId, rel, external);
  return 'file' in r ? r.file : null;
}

/** Like `loadAgentFile`, but says why it failed: a refused permission reads differently from a missing file. */
export async function readAgentFile(agentId: string, rel: string, external = false): Promise<{ file: FileBody } | { status: number; error: string }> {
  try {
    const r = await fetch('/api/ui/agents/' + encodeURIComponent(agentId) + (external ? '/files/external' : '/files') + '?path=' + encodeURIComponent(rel));
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.kind === 'file') return { file: external ? { ...(j as FileBody), external: true } : (j as FileBody) };
    return { status: r.status, error: typeof j.error === 'string' ? j.error : '' };
  } catch (e) { return { status: 0, error: String(e) }; }
}
