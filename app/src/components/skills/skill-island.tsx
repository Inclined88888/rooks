'use client';

/**
 * A skill's markdown file as a content of the island workspace
 * (`@rooks/agents:skill`): the same previewer and editor as an agent's file,
 * fed by the skills API instead of an agent's folder.
 *
 * A Rooks skill also says who receives it (`SkillRecipients`).
 *
 * The tab holds the skill's id only. The daemon resolves it to its file, and
 * a save writes back to the path the daemon itself returned, which it checks
 * again (managed roots only, the caller's rights).
 */

import { useEffect, useState, type ReactElement } from 'react';
import { Copy, Download, Lock, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TextDocumentIsland, type TextDocumentSource } from '@/components/chat/file-island';
import type { FileBody } from '@/components/chat/chat-types';
import { useIslandContent } from '@/components/islands/island-content';
import { ImportSkillDialog, SkillMissionBadge } from '@/components/skills/skill-import';
import { SkillRecipients } from '@/components/skills/skill-recipients';
import { BRAND } from '@/lib/brand';
import { copyToClipboard } from '@/lib/clipboard';
import { t } from '@/lib/i18n';
import type { IslandParams } from '@/lib/island-tree';
import { prepareSkillWrite } from '@/lib/skill-save';
import { notifySkillsChanged, skillIslandOrigin, type SkillIslandOrigin } from '@/lib/skill-island-content';
import { isImportableSource } from '@/lib/skill-import';
import { SKILL_SOURCE_CLASS, skillSourceLabel, type SkillDetail } from '@/lib/skill-sources';
import { cn } from '@/lib/utils';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';

export { SKILL_ISLAND_KEY, SKILL_ISLAND_TYPE, parseSkillIslandParams, skillIslandContent } from '@/lib/skill-island-content';

function skillUrl(id: string, path?: string): string {
  return `/api/ui/skills/${encodeURIComponent(id)}${path ? `?path=${encodeURIComponent(path)}` : ''}`;
}

/** The read of one entry: the winner of `id`, or the entry of `origin` (a masked skill). */
export function skillReadUrl(id: string, origin?: SkillIslandOrigin): string {
  const query = new URLSearchParams();
  if (origin) {
    query.set('source', origin.source);
    if (origin.format) query.set('format', origin.format);
  }
  const qs = query.toString();
  return `/api/ui/skills/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`;
}

/** Reads and writes one skill through the skills API; `onDetail` gets what the file alone does not say. */
export function skillSource(id: string, onDetail: (detail: SkillDetail) => void, origin?: SkillIslandOrigin): TextDocumentSource {
  return {
    async load() {
      try {
        const r = await fetch(skillReadUrl(id, origin), { cache: 'no-store' });
        if (!r.ok) return { error: r.status === 404 ? t('skillIsland.notFound', { id }) : t('skillIsland.loadFailed') };
        const detail = await r.json() as SkillDetail;
        onDetail(detail);
        const file: FileBody = {
          kind: 'file',
          path: detail.path,
          size: detail.size,
          modified: detail.updated_at,
          binary: false,
          truncated: false,
          content: detail.content,
        };
        return { file };
      } catch {
        return { error: t('skillIsland.loadFailed') };
      }
    },
    async save(file, text) {
      const prepared = prepareSkillWrite({ id, content: text }, file.path);
      if (!prepared.ok) {
        toast.error(t('skillForm.contentError'));
        return false;
      }
      try {
        const r = await fetch('/api/ui/skills', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(prepared.payload),
        });
        if (!r.ok) {
          toast.error(t(r.status === 401 ? 'skillForm.unauthorized' : r.status === 403 ? 'skillForm.forbidden' : 'skillForm.failed'));
          return false;
        }
      } catch {
        toast.error(t('skillForm.network'));
        return false;
      }
      toast.success(t('skillIsland.saved', { id }));
      notifySkillsChanged();
      return true;
    },
  };
}

export function SkillIsland(): ReactElement {
  const { tabId, params, setParams, setTitle } = useIslandContent();
  const id = typeof params.id === 'string' ? params.id : '';
  const origin = skillIslandOrigin(params);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  // An import under the same id makes that id resolve to the Rooks copy: read it again.
  const [epoch, setEpoch] = useState(0);

  useEffect(() => { setTitle(id); }, [id, setTitle]);

  function onImported(next: string) {
    setDetail(null);
    // The Rooks copy is the winner of its id: no source to name any more.
    setParams({ id: next, mode: 'preview' });
    setEpoch((n) => n + 1);
  }

  return (
    <TextDocumentIsland
      key={`${id}:${origin?.source ?? ''}:${origin?.format ?? ''}:${epoch}`}
      tabId={tabId}
      name={id}
      source={skillSource(id, setDetail, origin)}
      // Until the daemon says it may be written, it is not: an agent's proposal may ask for `edit`.
      readOnly={!detail?.editable}
      mode={params.mode === 'edit' ? 'edit' : 'view'}
      onMode={(next) => setParams({ ...params, mode: next === 'edit' ? 'edit' : 'preview' })}
      header={detail ? (
        <>
          <SkillHeader detail={detail} onImported={onImported} />
          {/* Only a Rooks skill can be attached: the others are not loaded by missions. */}
          {detail.source === 'rooks' && <SkillRecipients skill={detail.id} defaultOpen={params.section === 'recipients'} />}
        </>
      ) : null}
    />
  );
}

function SkillHeader({ detail, onImported }: { detail: SkillDetail; onImported: (id: string) => void }): ReactElement {
  const { close } = useIslandContent();
  const [deleting, setDeleting] = useState(false);
  const [importing, setImporting] = useState(false);
  const importable = isImportableSource(detail.source) ? detail.source : null;
  const importLabel = t('skillMission.import', { brand: BRAND.displayName });

  async function copyPath() {
    if (await copyToClipboard(detail.path)) toast.success(t('skillIsland.pathCopied'));
    else toast.error(t('skillIsland.copyFailed'));
  }

  async function remove() {
    if (deleting || !(await confirmAction({ title: t('skillIsland.deleteConfirm', { id: detail.id, path: detail.path }), confirmLabel: t('confirmDialog.delete'), destructive: true }))) return;
    setDeleting(true);
    try {
      const r = await fetch(skillUrl(detail.id, detail.path), { method: 'DELETE' });
      if (!r.ok) {
        toast.error(t(r.status === 403 ? 'skillForm.forbidden' : 'skillIsland.deleteFailed'));
        return;
      }
      toast.success(t('skillIsland.deleted', { id: detail.id }));
      notifySkillsChanged();
      close();
    } catch {
      toast.error(t('skillForm.network'));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-3 pb-1 pt-2 text-[11.5px] text-muted-foreground">
      <Badge variant="outline" className={cn('font-normal', SKILL_SOURCE_CLASS[detail.source])}>{skillSourceLabel(detail.source)}</Badge>
      <Badge variant="secondary" className="font-normal">
        {t(detail.format === 'claude-cmd' ? 'skillIsland.command' : 'skillIsland.skill')}
      </Badge>
      {!detail.editable && (
        <Badge variant="outline" className="gap-1 font-normal">
          <Lock className="size-3" />
          {t('skillIsland.readOnly')}
        </Badge>
      )}
      {importable && <SkillMissionBadge />}
      <span className="min-w-0 flex-1 truncate" title={detail.path}>
        {t('skillIsland.storedAt', { path: detail.path })}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={() => void copyPath()}
        aria-label={t('skillIsland.copyPath')}
        title={t('skillIsland.copyPath')}
      >
        <Copy className="size-3.5" />
      </Button>
      {importable && (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-[11.5px]"
            onClick={() => setImporting(true)}
            title={t('skillMission.unavailableHint', { brand: BRAND.displayName })}
          >
            <Download className="size-3.5" aria-hidden />
            {importLabel}
          </Button>
          <ImportSkillDialog
            open={importing}
            onOpenChange={setImporting}
            sourceId={detail.id}
            source={importable}
            onImported={(id) => {
              setImporting(false);
              toast.success(t('skillMission.imported', { id }));
              notifySkillsChanged();
              onImported(id);
            }}
          />
        </>
      )}
      {detail.editable && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={deleting}
          onClick={() => void remove()}
          aria-label={t('skillIsland.delete')}
          title={t('skillIsland.delete')}
        >
          <Trash2 className="size-3.5" />
        </Button>
      )}
    </div>
  );
}
