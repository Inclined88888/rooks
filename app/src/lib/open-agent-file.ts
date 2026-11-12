import { toast } from 'sonner';
import { t } from '@/lib/i18n';
import { previewKindFor } from '@/lib/file-preview/kind';
import { fileViewer, readAgentFile } from '@/lib/file-viewer';

/**
 * Opens a file in the Files viewer window (a tab for text, the viewer for the
 * rest). `external`: a file outside the agent's folder the user agreed to open,
 * named by its absolute path; the daemon asks for the `files:external` permission.
 */
export async function openAgentFile(agentId: string, path: string, external = false): Promise<void> {
  const kind = previewKindFor(path);
  if (kind) {
    fileViewer.openPreview(agentId, { path, kind, ...(external ? { external } : {}) });
    return;
  }
  const r = await readAgentFile(agentId, path, external);
  if ('file' in r) fileViewer.openText(agentId, r.file);
  else if (r.status === 403) toast.error(t('fileLink.forbidden'));
  else toast.error(t('fileLink.openFailed', { path }));
}
