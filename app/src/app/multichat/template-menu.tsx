'use client';

/**
 * Saved multichat setups, at the top of the side bar next to the grid picker
 * (an icon of the folded rail when the side bar is closed).
 *
 * A template recalls the grid size and the agents, not their conversations
 * (`lib/multichat-templates.ts`). The list is read from the daemon, so a setup
 * saved in the browser is offered in the desktop client too.
 */

import { useCallback, useMemo, useState } from 'react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Bookmark, Check, ChevronDown, Pencil, Plus, Save, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';

import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useStoredLayout } from '@/hooks/use-stored-layout';
import {
  MAX_NAME_LENGTH,
  TEMPLATES_SCOPE,
  addTemplate,
  matchesTemplate,
  readTemplates,
  removeTemplate,
  renameTemplate,
  replaceTemplate,
  writeTemplates,
  type MultichatGrid,
  type MultichatTemplate,
  type TemplateError,
  type TemplateResult,
} from '@/lib/multichat-templates';
import { RAIL_CONTROL, RAIL_ICON_BUTTON, type ControlVariant } from './controls';
import { NativeViewCover } from '@/lib/native-view-cover';

const ITEM = 'flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-xs outline-none focus:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50';
const ICON_BUTTON = 'rounded p-1 text-muted-foreground/70 outline-none transition-colors hover:text-primary focus-visible:text-primary disabled:pointer-events-none disabled:opacity-50';

export function TemplateMenu({
  grid,
  onRecall,
  variant = 'full',
}: {
  grid: MultichatGrid;
  onRecall: (template: MultichatTemplate) => void;
  variant?: ControlVariant;
}) {
  const { raw, update, ready } = useStoredLayout(TEMPLATES_SCOPE);
  const templates = useMemo(() => readTemplates(raw), [raw]);
  const active = useMemo(() => templates.find((tpl) => matchesTemplate(tpl, grid)) ?? null, [templates, grid]);

  // `null` = no form open, `''` = saving a new one, an id = renaming that one.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [managing, setManaging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TemplateError | null>(null);

  /** The rollback matters: `update` paints the new list before the request
   *  leaves, so a refused write would leave a template on screen that nobody
   *  stored (`undoOnFailure`). `edit` is checked against the list on screen,
   *  then applied again to the stored list when written: replayed over a
   *  template another window saved meanwhile (TODO #647), it keeps that one. */
  const apply = useCallback(async (edit: (list: readonly MultichatTemplate[]) => TemplateResult): Promise<boolean> => {
    const first = edit(templates);
    if (!first.ok) { setError(first.error); return false; }
    const ok = await update((stored) => {
      const next = edit(readTemplates(stored));
      return next.ok ? writeTemplates(next.templates) : stored;
    }, true, { undoOnFailure: true });
    setError(ok ? null : 'write-failed');
    return ok;
  }, [templates, update]);

  const closeForm = useCallback(() => { setEditing(null); setDraft(''); }, []);

  const run = useCallback(async (job: () => Promise<void>) => {
    setBusy(true);
    try { await job(); } finally { setBusy(false); }
  }, []);

  const onSave = () => run(async () => {
    if (await apply((list) => addTemplate(list, draft, grid))) closeForm();
  });
  const onRename = (id: string) => run(async () => {
    if (await apply((list) => renameTemplate(list, id, draft))) closeForm();
  });
  const onOverwrite = (tpl: MultichatTemplate) => run(async () => {
    if (await apply((list) => replaceTemplate(list, tpl.id, grid))) {
      toast.success(t('multichat.templates.overwritten', { name: tpl.name }));
    }
  });
  const onDelete = (tpl: MultichatTemplate) => run(async () => {
    if (await apply((list) => ({ ok: true, templates: removeTemplate(list, tpl.id), template: tpl }))) {
      toast.success(t('multichat.templates.deleted', { name: tpl.name }));
    }
  });

  const triggerLabel = active
    ? t('multichat.templates.triggerActive', { name: active.name })
    : t('multichat.templates.title');

  const form = (onConfirm: () => void) => (
    <div className="flex items-center gap-1 px-2 py-1.5" onKeyDown={(e) => e.stopPropagation()}>
      <input
        autoFocus
        value={draft}
        maxLength={MAX_NAME_LENGTH}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
          if (e.key === 'Escape') { e.preventDefault(); closeForm(); }
        }}
        placeholder={t('multichat.templates.namePlaceholder')}
        aria-label={t('multichat.templates.namePlaceholder')}
        className="min-w-0 flex-1 rounded border border-border bg-surface-2 px-2 py-1 text-xs outline-none focus:border-primary"
      />
      <button type="button" disabled={busy} onClick={onConfirm} aria-label={t('multichat.templates.confirm')} title={t('multichat.templates.confirm')} className={ICON_BUTTON}>
        <Check className="size-3.5" />
      </button>
      <button type="button" onClick={closeForm} aria-label={t('multichat.templates.cancel')} title={t('multichat.templates.cancel')} className={ICON_BUTTON}>
        <X className="size-3.5" />
      </button>
    </div>
  );

  return (
    <Dropdown.Root onOpenChange={(open) => { if (!open) { closeForm(); setManaging(false); setError(null); } }}>
      <Dropdown.Trigger asChild>
        {variant === 'icon' ? (
          <button
            type="button"
            aria-label={triggerLabel}
            title={triggerLabel}
            className={RAIL_ICON_BUTTON}
          >
            <Bookmark className={cn('size-3.5', active && 'fill-primary/20 text-primary')} />
          </button>
        ) : (
          <button
            type="button"
            aria-label={triggerLabel}
            title={triggerLabel}
            className={cn(RAIL_CONTROL, 'min-w-0 flex-1')}
          >
            <Bookmark className={cn('size-3 shrink-0', active ? 'fill-primary/20 text-primary' : 'text-muted-foreground')} />
            <span className={cn('min-w-0 flex-1 truncate text-left', !active && 'text-muted-foreground')}>
              {active ? active.name : t('multichat.templates.title')}
            </span>
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          </button>
        )}
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content side={variant === 'icon' ? 'right' : 'bottom'} align="start" sideOffset={6} className="z-50 w-64 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-elev-2">
          <NativeViewCover />
          <div className="flex items-center gap-2 px-3 py-2">
            <span className="flex-1 text-xs font-medium">{t('multichat.templates.title')}</span>
            {templates.length > 0 && (
              <button
                type="button"
                onClick={() => { setManaging((on) => !on); closeForm(); setError(null); }}
                aria-pressed={managing}
                className={cn(
                  'flex items-center gap-1 rounded px-1 py-0.5 text-[11px] outline-none transition-colors focus-visible:text-primary',
                  managing ? 'text-primary' : 'text-muted-foreground/70 hover:text-primary',
                )}
              >
                <SlidersHorizontal className="size-3.5" />
                <span>{managing ? t('multichat.templates.manageDone') : t('multichat.templates.manage')}</span>
              </button>
            )}
          </div>

          {error && (
            <p role="alert" className="px-3 pb-2 text-xs leading-snug text-destructive">
              {t(`multichat.templates.error.${error}`)}
            </p>
          )}

          {templates.length === 0 && (
            <p className="px-3 pb-2 text-xs leading-snug text-muted-foreground">
              {t('multichat.templates.empty')}
            </p>
          )}

          {templates.map((tpl) => (
            editing === tpl.id ? (
              <div key={tpl.id}>{form(() => void onRename(tpl.id))}</div>
            ) : managing ? (
              // Management rows are not menu items: a row whose click already
              // means "recall" cannot also mean "rename".
              <div key={tpl.id} className="flex items-center gap-1 px-3 py-1.5 text-xs">
                <span className="min-w-0 flex-1 truncate" title={tpl.name}>{tpl.name}</span>
                <button type="button" disabled={!ready || busy} onClick={() => { setError(null); setEditing(tpl.id); setDraft(tpl.name); }} aria-label={t('multichat.templates.rename', { name: tpl.name })} title={t('multichat.templates.rename', { name: tpl.name })} className={ICON_BUTTON}>
                  <Pencil className="size-3.5" />
                </button>
                <button type="button" disabled={!ready || busy} onClick={() => void onOverwrite(tpl)} aria-label={t('multichat.templates.overwrite', { name: tpl.name })} title={t('multichat.templates.overwrite', { name: tpl.name })} className={ICON_BUTTON}>
                  <Save className="size-3.5" />
                </button>
                <button type="button" disabled={!ready || busy} onClick={() => void onDelete(tpl)} aria-label={t('multichat.templates.delete', { name: tpl.name })} title={t('multichat.templates.delete', { name: tpl.name })} className={ICON_BUTTON}>
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ) : (
              <Dropdown.Item key={tpl.id} disabled={busy} onSelect={() => onRecall(tpl)} className={ITEM}>
                <span className="min-w-0 flex-1 truncate" title={tpl.name}>{tpl.name}</span>
                <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">
                  {tpl.rows}×{tpl.cols} · {tpl.agents.filter((a) => a !== null).length}
                </span>
                <Check className={cn('size-3.5 shrink-0 text-primary', tpl.id === active?.id ? 'opacity-100' : 'opacity-0')} />
              </Dropdown.Item>
            )
          ))}

          <Dropdown.Group className="mt-2">
            {editing === '' ? form(() => void onSave()) : (
              <Dropdown.Item
                disabled={!ready || busy}
                onSelect={(e) => { e.preventDefault(); setError(null); setManaging(false); setEditing(''); setDraft(''); }}
                className={ITEM}
              >
                <Plus className="size-4" />
                <span className="flex-1">{t('multichat.templates.save')}</span>
              </Dropdown.Item>
            )}
          </Dropdown.Group>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
