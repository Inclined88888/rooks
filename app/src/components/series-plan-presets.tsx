'use client';

/**
 * The model presets bar of the series planner (`series-plan-form.tsx`): one
 * at the head of the general role matrix, one in each group's panel.
 *
 * ONE CHIP PER PRESET, THE COLUMN ASKED AT APPLY TIME. A chip opens a choice
 * "Primary / Fallback" (straight to the only column a mode leaves), so what a
 * click does is always said where it is done. Saving lives on the column it
 * reads: a floppy button beside the MODEL and FALLBACK headers
 * (`PresetSaveButton`), not a switch somewhere else in the bar. A menu per
 * chip (rename, delete) keeps the chip itself a single gesture.
 *
 * Not a slot. It lives in this form only — its data are typed on the series
 * roles, and no other screen picks a role matrix — so there is no second host
 * to justify a frozen Client API contract. What a plugin may want to replace,
 * the model choice itself, is already the `model.picker` slot, which every
 * cell of the matrix paints (`docs/MODEL-PICKER.md` §7).
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import { Check, MoreHorizontal, Pencil, Save, Trash2, X } from 'lucide-react';
import { AnchoredPopover } from '@/components/anchored-popover';
import { usePlanPresets } from '@/hooks/use-plan-presets';
import { modelLabel, type BackendCatalog } from '@/lib/backends';
import {
  PLAN_PRESET_NAME_MAX, planPresetNameKey, presetPairsFor, validPlanPresetName,
  type PlanPreset, type PlanPresetPair, type PlanPresetRoles, type PresetOrphan,
} from '@/lib/plan-presets';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { SeriesPlanRole } from '@/components/series-plan-form';

export type PresetColumn = 'main' | 'fallback';

const VEIL = 'bg-foreground/[0.04] dark:bg-foreground/[0.07]';
const VEIL_HOVER = 'hover:bg-foreground/[0.07] dark:hover:bg-foreground/[0.12]';
const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-primary/50';
const ACTIVE = 'bg-primary text-primary-foreground dark:bg-primary/20 dark:text-foreground';
const SMALL_BUTTON = cn('flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 text-[11px] transition-colors disabled:cursor-default disabled:opacity-50', FOCUS_RING);
const ICON_BUTTON = cn('flex size-6 shrink-0 items-center justify-center cursor-pointer rounded text-muted-foreground transition-colors hover:text-foreground disabled:cursor-default disabled:opacity-50', FOCUS_RING);

function roleLabel(role: SeriesPlanRole): string {
  return t(`taskForm.seriesPlan.roles.${role}`);
}

/** "Coder · Opus, Docs · Sonnet", in the order of `roles`. */
function describe(catalog: BackendCatalog, roles: readonly SeriesPlanRole[], pairs: PlanPresetRoles): string {
  return roles.flatMap((role) => {
    const pair = pairs[role];
    return pair ? [`${roleLabel(role)} · ${modelLabel(catalog, pair.backend, pair.model)}`] : [];
  }).join(', ');
}

type Notice =
  | { kind: 'applied' | 'none'; name: string; column: PresetColumn; orphans: PresetOrphan[] }
  | null;

const ALL_ROLES: readonly SeriesPlanRole[] = ['orchestrator', 'mission', 'code', 'review', 'merge', 'doc'];

type BarPopover =
  | { kind: 'apply'; id: string }
  | { kind: 'menu'; id: string; step: 'actions' | 'rename' | 'delete' }
  | null;

export function PlanPresetBar({
  catalog,
  roles,
  onApply,
  disabled,
}: {
  catalog: BackendCatalog;
  /** The roles of the chosen mode each column can take. `main` leaves out a role whose primary model is not editable here. */
  roles: Record<PresetColumn, readonly SeriesPlanRole[]>;
  /** Puts `pairs` on `column`; a role absent from `pairs` keeps its value. */
  onApply: (column: PresetColumn, pairs: Partial<Record<SeriesPlanRole, PlanPresetPair>>) => void;
  disabled: boolean;
}) {
  const { presets, ready, rename, remove } = usePlanPresets();
  const [notice, setNotice] = useState<Notice>(null);
  const [popover, setPopover] = useState<BarPopover>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const columns = (['main', 'fallback'] as const).filter((c) => roles[c].length > 0);
  // What a chip can set here, whichever column it goes to: never a role this mode does not show.
  const shown = ALL_ROLES.filter((role) => roles.main.includes(role) || roles.fallback.includes(role));

  function close() {
    setPopover(null);
    setDraft('');
    setError(null);
  }

  function apply(preset: PlanPreset, column: PresetColumn) {
    close();
    const { pairs, orphans } = presetPairsFor(preset, roles[column], catalog);
    const applicable = Object.keys(pairs).length > 0;
    if (applicable) onApply(column, pairs);
    setNotice({ kind: applicable ? 'applied' : 'none', name: preset.name, column, orphans });
  }

  function submitRename(id: string) {
    if (!validPlanPresetName(draft)) return;
    if (!rename(id, draft)) {
      setError(t('taskForm.seriesPlan.presets.renameTaken'));
      return;
    }
    close();
  }

  const target = popover ? presets.find((p) => p.id === popover.id) : undefined;

  return (
    <div className="flex flex-col gap-1" data-testid="preset-bar">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{t('taskForm.seriesPlan.presets.label')}</span>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" data-testid="preset-chips">
          {ready && presets.length === 0 && (
            <span className="truncate text-[10.5px] text-muted-foreground">{t('taskForm.seriesPlan.presets.empty')}</span>
          )}
          {presets.map((preset) => (
            <span key={preset.id} className={cn('flex shrink-0 items-center rounded', VEIL)} data-preset-chip={preset.name}>
              <button
                type="button"
                disabled={disabled || columns.length === 0}
                aria-expanded={popover?.kind === 'apply' && popover.id === preset.id}
                onClick={(e) => {
                  if (columns.length === 1) { apply(preset, columns[0]!); return; }
                  anchor.current = e.currentTarget;
                  setError(null);
                  setPopover((prev) => (prev?.kind === 'apply' && prev.id === preset.id ? null : { kind: 'apply', id: preset.id }));
                }}
                title={t('taskForm.seriesPlan.presets.applyTitle', { name: preset.name, roles: describe(catalog, shown, preset.roles) })}
                className={cn(SMALL_BUTTON, 'max-w-[140px] pr-1', VEIL_HOVER)}
                data-preset-apply
              >
                <span className="truncate">{preset.name}</span>
              </button>
              <button
                type="button"
                disabled={disabled}
                aria-expanded={popover?.kind === 'menu' && popover.id === preset.id}
                aria-label={t('taskForm.seriesPlan.presets.menu', { name: preset.name })}
                title={t('taskForm.seriesPlan.presets.menu', { name: preset.name })}
                onClick={(e) => {
                  anchor.current = e.currentTarget;
                  setError(null);
                  setPopover((prev) => (prev?.kind === 'menu' && prev.id === preset.id ? null : { kind: 'menu', id: preset.id, step: 'actions' }));
                }}
                className={cn(ICON_BUTTON, 'w-5')}
                data-preset-menu
              >
                <MoreHorizontal aria-hidden className="size-3" />
              </button>
            </span>
          ))}
        </div>
      </div>

      {notice && (
        <div role="status" className="flex flex-col gap-0.5 px-0.5 text-[10.5px] leading-snug text-muted-foreground" data-testid="preset-notice">
          <span>{t(`taskForm.seriesPlan.presets.notice.${notice.kind}`, { name: notice.name, column: t(`taskForm.seriesPlan.presets.columnIn.${notice.column}`) })}</span>
          {notice.orphans.length > 0 && (
            <span
              data-testid="preset-orphans"
              title={notice.orphans.map((o) => `${roleLabel(o.role)} · ${o.backend} / ${o.model} — ${t(`taskForm.seriesPlan.presets.orphan.${o.reason}`)}`).join('\n')}
            >
              {t('taskForm.seriesPlan.presets.skipped', {
                roles: notice.orphans.map((o) => `${roleLabel(o.role)} (${o.backend} / ${o.model})`).join(', '),
              })}
            </span>
          )}
        </div>
      )}

      <AnchoredPopover
        open={popover?.kind === 'apply' && !!target}
        onClose={close}
        anchorRef={anchor as RefObject<HTMLElement | null>}
        align="start"
        width={200}
        maxHeight={160}
        sheet
        label={target ? t('taskForm.seriesPlan.presets.applyTo', { name: target.name }) : undefined}
        className="gap-1.5 p-2"
      >
        {popover?.kind === 'apply' && target && (
          <>
            <span className="truncate text-[10.5px] text-muted-foreground">{t('taskForm.seriesPlan.presets.applyTo', { name: target.name })}</span>
            <div className="flex gap-1">
              {columns.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => apply(target, c)}
                  title={describe(catalog, roles[c], presetPairsFor(target, roles[c], catalog).pairs)}
                  className={cn(SMALL_BUTTON, 'h-7 flex-1 justify-center font-medium', VEIL, VEIL_HOVER)}
                  data-preset-apply-to={c}
                >
                  {t(c === 'main' ? 'taskForm.seriesPlan.presets.columnMain' : 'taskForm.seriesPlan.presets.columnFallback')}
                </button>
              ))}
            </div>
          </>
        )}
      </AnchoredPopover>

      <AnchoredPopover
        open={popover?.kind === 'menu' && !!target}
        onClose={close}
        anchorRef={anchor as RefObject<HTMLElement | null>}
        align="start"
        width={220}
        maxHeight={200}
        sheet
        label={target ? t('taskForm.seriesPlan.presets.menu', { name: target.name }) : undefined}
        className="gap-1 p-1.5"
      >
        {popover?.kind === 'menu' && target && (
          popover.step === 'rename' ? (
            <NameField
              value={draft}
              onChange={setDraft}
              onConfirm={() => submitRename(target.id)}
              onCancel={close}
              confirmLabel={t('taskForm.seriesPlan.presets.confirmRename')}
            />
          ) : popover.step === 'delete' ? (
            <div className="flex flex-col gap-1.5 p-1" data-testid="preset-delete">
              <span className="text-[11.5px] leading-snug">{t('taskForm.seriesPlan.presets.deleteConfirm', { name: target.name })}</span>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => { remove(target.id); close(); }}
                  className={cn(SMALL_BUTTON, 'bg-destructive text-destructive-foreground')}
                  data-preset-delete-confirm
                >
                  {t('taskForm.seriesPlan.presets.delete')}
                </button>
                <button type="button" onClick={close} className={cn(SMALL_BUTTON, VEIL, VEIL_HOVER)}>
                  {t('taskForm.seriesPlan.presets.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                disabled={!ready}
                onClick={() => { setDraft(target.name); setPopover({ ...popover, step: 'rename' }); }}
                className={cn(SMALL_BUTTON, 'h-7 w-full', VEIL_HOVER)}
                data-preset-rename
              >
                <Pencil aria-hidden className="size-3" />
                <span>{t('taskForm.seriesPlan.presets.rename')}</span>
              </button>
              <button
                type="button"
                disabled={!ready}
                onClick={() => setPopover({ ...popover, step: 'delete' })}
                className={cn(SMALL_BUTTON, 'h-7 w-full text-destructive', VEIL_HOVER)}
                data-preset-delete
              >
                <Trash2 aria-hidden className="size-3" />
                <span>{t('taskForm.seriesPlan.presets.delete')}</span>
              </button>
            </>
          )
        )}
        {popover?.kind === 'menu' && error && <p role="alert" className="px-1 text-[10.5px] leading-snug text-destructive">{error}</p>}
      </AnchoredPopover>
    </div>
  );
}

/**
 * The floppy beside a column header: saves THAT column as a preset. Its
 * popover shows what will be stored, asks a name, and confirms before
 * replacing a preset of the same name (its id kept).
 */
export function PresetSaveButton({
  catalog,
  column,
  roles,
  picks,
  disabled,
}: {
  catalog: BackendCatalog;
  column: PresetColumn;
  /** The roles of the chosen mode this column takes. */
  roles: readonly SeriesPlanRole[];
  /** The matrix's selections, keyed `${role}:main` / `${role}:fallback`. */
  picks: Readonly<Record<string, PlanPresetPair>>;
  disabled: boolean;
}) {
  const { presets, ready, save } = usePlanPresets();
  const [open, setOpen] = useState<null | { confirm: boolean }>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(null), 2500);
    return () => clearTimeout(timer);
  }, [saved]);

  const columnName = t(`taskForm.seriesPlan.presets.columnIn.${column}`);
  const current: PlanPresetRoles = {};
  for (const role of roles) {
    const pair = picks[`${role}:${column}`];
    if (pair) current[role] = pair;
  }
  const hasCurrent = Object.keys(current).length > 0;

  function close() {
    setOpen(null);
    setDraft('');
    setError(null);
  }

  function submit(confirmed: boolean) {
    const name = validPlanPresetName(draft);
    if (!name) return;
    const taken = presets.some((p) => planPresetNameKey(p.name) === planPresetNameKey(name));
    if (taken && !confirmed) {
      setOpen({ confirm: true });
      return;
    }
    if (!save(name, current)) {
      setError(t('taskForm.seriesPlan.presets.saveRefused'));
      setOpen({ confirm: false });
      return;
    }
    close();
    setSaved(name);
  }

  const title = saved
    ? t('taskForm.seriesPlan.presets.notice.saved', { name: saved })
    : hasCurrent
      ? t('taskForm.seriesPlan.presets.saveTitle', { column: columnName })
      : t('taskForm.seriesPlan.presets.saveNothing', { column: columnName });

  return (
    <>
      <button
        ref={anchor}
        type="button"
        disabled={disabled || !ready || !hasCurrent}
        aria-expanded={!!open}
        aria-label={title}
        title={title}
        onClick={() => {
          setError(null);
          setDraft('');
          setOpen((prev) => (prev ? null : { confirm: false }));
        }}
        className={cn(ICON_BUTTON, 'size-5 normal-case tracking-normal', saved && 'text-primary')}
        data-preset-save={column}
      >
        {saved ? <Check aria-hidden className="size-3" /> : <Save aria-hidden className="size-3" />}
      </button>
      {saved && <span role="status" className="sr-only" data-testid="preset-saved">{title}</span>}
      <AnchoredPopover
        open={!!open}
        onClose={close}
        anchorRef={anchor}
        align="start"
        width={260}
        maxHeight={240}
        sheet
        label={t('taskForm.seriesPlan.presets.saveTitle', { column: columnName })}
        className="gap-2 p-2.5 normal-case tracking-normal"
      >
        <div className="text-[10.5px] font-medium text-foreground">{t('taskForm.seriesPlan.presets.saveTitle', { column: columnName })}</div>
        <div className="text-[10.5px] leading-snug text-muted-foreground" data-testid="preset-save-preview">
          {describe(catalog, roles, current)}
        </div>
        {open?.confirm ? (
          <div className="flex flex-col gap-1.5" data-testid="preset-overwrite">
            <span className="text-[11.5px] leading-snug">{t('taskForm.seriesPlan.presets.overwriteConfirm', { name: draft.trim() })}</span>
            <div className="flex gap-1.5">
              <button type="button" onClick={() => submit(true)} className={cn(SMALL_BUTTON, ACTIVE)} data-preset-overwrite-confirm>
                {t('taskForm.seriesPlan.presets.replace')}
              </button>
              <button type="button" onClick={() => setOpen({ confirm: false })} className={cn(SMALL_BUTTON, VEIL, VEIL_HOVER)}>
                {t('taskForm.seriesPlan.presets.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <NameField
            value={draft}
            onChange={setDraft}
            onConfirm={() => submit(false)}
            onCancel={close}
            confirmLabel={t('taskForm.seriesPlan.presets.confirmSave')}
          />
        )}
        {error && <p role="alert" className="text-[10.5px] leading-snug text-destructive">{error}</p>}
      </AnchoredPopover>
    </>
  );
}

function NameField({
  value,
  onChange,
  onConfirm,
  onCancel,
  confirmLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel: string;
}) {
  const valid = validPlanPresetName(value) !== null;
  return (
    <div className="flex items-center gap-1">
      <input
        autoFocus
        value={value}
        maxLength={PLAN_PRESET_NAME_MAX}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (valid) onConfirm(); }
        }}
        placeholder={t('taskForm.seriesPlan.presets.namePlaceholder')}
        aria-label={t('taskForm.seriesPlan.presets.namePlaceholder')}
        className={cn('h-7 min-w-0 flex-1 rounded px-2 text-[11.5px] placeholder:text-muted-foreground/60', VEIL, FOCUS_RING)}
        data-preset-name
      />
      <button type="button" disabled={!valid} onClick={onConfirm} aria-label={confirmLabel} title={confirmLabel} className={ICON_BUTTON} data-preset-name-confirm>
        <Check aria-hidden className="size-3.5" />
      </button>
      <button type="button" onClick={onCancel} aria-label={t('taskForm.seriesPlan.presets.cancel')} title={t('taskForm.seriesPlan.presets.cancel')} className={ICON_BUTTON}>
        <X aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}
