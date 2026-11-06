'use client';

/**
 * What the Skills page and the skill island say of a `claude-user` / `plugin`
 * skill: missions never see it, and an explicit import copies it into the
 * Timon skills folder, where it becomes attachable.
 */

import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { Ban } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { BRAND } from '@/lib/brand';
import { t } from '@/lib/i18n';
import { defaultImportId, requestSkillImport, type ImportableSource, type SkillImportError } from '@/lib/skill-import';
import { cn } from '@/lib/utils';

const IMPORT_PATH = '~/.timon/skills/<id>/';

export function SkillMissionBadge({ className }: { className?: string }): ReactElement {
  const brand = { brand: BRAND.displayName };
  return (
    <Badge
      variant="outline"
      title={t('skillMission.unavailableHint', brand)}
      className={cn('gap-1 border-dashed font-normal text-muted-foreground', className)}
    >
      <Ban className="size-3" aria-hidden />
      {t('skillMission.unavailable')}
    </Badge>
  );
}

/** Names the copy (the source id, namespace folded, by default) and imports it. */
export function ImportSkillDialog({ open, onOpenChange, sourceId, source, onImported }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceId: string;
  source: ImportableSource;
  onImported: (id: string) => void;
}): ReactElement {
  const [id, setId] = useState('');
  const [error, setError] = useState<SkillImportError | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const brand = { brand: BRAND.displayName };

  useEffect(() => {
    if (!open) return;
    setId(defaultImportId(sourceId));
    setError(null);
    const timer = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, [open, sourceId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const result = await requestSkillImport(sourceId, source, id);
      if (result.ok) onImported(result.id);
      else setError(result.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[460px]">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('skillMission.importTitle', { ...brand, id: sourceId })}</DialogTitle>
            <DialogDescription>
              {t('skillMission.importHint', { ...brand, path: IMPORT_PATH })}
              {source === 'plugin' && <> {t('skillMission.importPluginHint')}</>}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Input
              ref={inputRef}
              aria-label={t('skillMission.idLabel')}
              aria-invalid={!!error}
              aria-describedby={error ? 'import-skill-error' : undefined}
              value={id}
              onChange={(e) => setId(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            {error && (
              <p id="import-skill-error" role="alert" className="text-sm text-destructive">
                {t(`skillMission.${error}`, brand)}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('skillMission.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t('skillMission.importing') : t('skillMission.import', brand)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
