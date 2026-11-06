'use client';

/**
 * Settings › Missions: which model names the conversations of the signed-in
 * account (TODO #358, part D). A graft of the native Missions category
 * (`settings.missions`), registered by the client half of `@timon/missions`
 * like any plugin would.
 *
 * The list of backends and models comes from the daemon
 * (`GET /api/mission-titles/model`), with its own verdict on eligibility: it
 * becomes the `filter` of the product's ModelPicker, and a backend served
 * remotely (which cannot run the one-shot) is named under it with the reason.
 * The choices that name no model (instance setting, automatic, off) stay in a
 * select above the picker. The choice is the account's own — nobody else's is
 * read or written — and `null` follows the instance setting again.
 */

import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type ReactElement } from 'react';
import { toast } from 'sonner';
import { ModelPickerPopover, type ModelPickerFilter } from '@/components/model-picker';
import { t } from '@/lib/i18n';
import { apiErrorMessage } from '@/lib/api-error';

type Choice = { kind: 'auto' } | { kind: 'off' } | { kind: 'model'; backend: string; model: string };
type BackendView = {
  id: string;
  label: string;
  eligible: boolean;
  reason?: 'remote' | 'session' | 'unavailable';
  auto: { model: string; reason: 'tier' | 'default' } | null;
  models: Array<{ slug: string; label: string; tier?: string }>;
};
type View = {
  value: Choice | null;
  instance: Choice;
  instance_source: 'env' | 'config' | 'db' | 'default';
  effective: Choice;
  backends: BackendView[];
};

/** The select: the three choices that name no model, and "a model" which opens the picker. */
type Mode = 'inherit' | 'auto' | 'off' | 'model';

const field = 'h-8 w-full max-w-md rounded-md border border-border bg-background px-2 text-[12.5px]';

function modeOf(choice: Choice | null): Mode {
  return choice === null ? 'inherit' : choice.kind;
}

/** The body the daemon expects for a mode that names no model; `undefined` for "model", which waits for a pick. */
export function choiceFromMode(mode: string): Choice | null | undefined {
  if (mode === 'inherit') return null;
  if (mode === 'auto' || mode === 'off') return { kind: mode };
  return undefined;
}

/**
 * Only what the daemon says can title: an eligible backend, and a model it
 * lists for it. The picker's rail, favourites and search all follow this.
 */
export function titleModelFilter(backends: readonly BackendView[]): ModelPickerFilter {
  return (backend, model) => backends.some((b) => b.id === backend.id && b.eligible && b.models.some((m) => m.slug === model.slug));
}

function describe(choice: Choice, backends: BackendView[]): string {
  if (choice.kind === 'auto') return t('missionTitles.autoShort');
  if (choice.kind === 'off') return t('missionTitles.offShort');
  const backend = backends.find((b) => b.id === choice.backend);
  const model = backend?.models.find((m) => m.slug === choice.model);
  return `${backend?.label ?? choice.backend} · ${model?.label ?? choice.model}`;
}

export function MissionTitleModelSettings(): ReactElement | null {
  const [view, setView] = useState<View | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  /** "A model" chosen in the select, no model picked yet: nothing is written until a pick. */
  const [picking, setPicking] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/ui/mission-titles/model', { cache: 'no-store' });
      if (!r.ok) { setFailed(true); return; }
      setView(await r.json() as View);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const backends = view?.backends;
  const filter = useMemo(() => titleModelFilter(backends ?? []), [backends]);

  const save = async (choice: Choice | null) => {
    if (!view) return;
    const previous = view;
    setView({ ...view, value: choice });
    setSaving(true);
    try {
      const r = await fetch('/api/ui/mission-titles/model', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: choice === null ? null : choice.kind === 'model' ? { backend: choice.backend, model: choice.model } : choice.kind }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as { error?: string };
        toast.error(apiErrorMessage(err, t('missionTitles.saveError')));
        setView(previous);
        return;
      }
      const saved = await r.json() as { value: Choice | null; effective: Choice };
      setView({ ...previous, value: saved.value, effective: saved.effective });
      toast.success(t('missionTitles.saved'));
    } catch {
      toast.error(t('missionTitles.saveError'));
      setView(previous);
    } finally {
      setSaving(false);
    }
  };

  const onMode = (e: ChangeEvent<HTMLSelectElement>) => {
    const mode = e.target.value;
    if (mode === 'model') {
      if (view?.value?.kind !== 'model') { setPicking(true); setOpen(true); }
      return;
    }
    const choice = choiceFromMode(mode);
    if (choice === undefined) return;
    setPicking(false);
    void save(choice);
  };

  // No account behind the request (first run, operator token): the choice is
  // per account, there is nothing to paint.
  if (failed) return null;
  if (!view) return <p role="status" className="py-4 text-[12px] text-muted-foreground">{t('missionTitles.loading')}</p>;

  const mode: Mode = picking ? 'model' : modeOf(view.value);
  const unavailable = view.backends.filter((b) => !b.eligible);

  return (
    <section className="space-y-2 py-4" aria-label={t('missionTitles.title')} aria-busy={saving}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
        <div className="min-w-0 flex-1">
          <span className="text-[13px] font-medium leading-snug">{t('missionTitles.title')}</span>
          <p className="mt-0.5 max-w-[65ch] text-[12px] leading-snug text-muted-foreground">{t('missionTitles.description')}</p>
          <p className="mt-1 max-w-[65ch] text-[12px] leading-snug text-muted-foreground">{t('missionTitles.quotaNote')}</p>
        </div>
        <div className="w-full shrink-0 space-y-2 sm:w-80">
          <select
            aria-label={t('missionTitles.mode')}
            className={field}
            value={mode}
            disabled={saving}
            onChange={onMode}
          >
            <option value="inherit">{t('missionTitles.inherit', { value: describe(view.instance, view.backends) })}</option>
            <option value="auto">{t('missionTitles.auto')}</option>
            <option value="off">{t('missionTitles.off')}</option>
            <option value="model">{t('missionTitles.specific')}</option>
          </select>
          {mode === 'model' && (
            <>
              <ModelPickerPopover
                value={view.value?.kind === 'model' ? { backend: view.value.backend, model: view.value.model } : null}
                onChange={(pick) => {
                  if (!pick) return;
                  setPicking(false);
                  void save({ kind: 'model', backend: pick.backend, model: pick.model });
                }}
                filter={filter}
                disabled={saving}
                open={open}
                onOpenChange={(next) => {
                  setOpen(next);
                  // Closed without a pick: the select goes back to what is stored.
                  if (!next) setPicking(false);
                }}
                label={t('missionTitles.model')}
                triggerClassName="w-full max-w-md"
              />
              {unavailable.map((backend) => (
                <p key={backend.id} className="text-[11.5px] leading-snug text-muted-foreground">
                  {t('missionTitles.unavailable', { backend: backend.label, reason: t(`missionTitles.reason.${backend.reason ?? 'unavailable'}`) })}
                </p>
              ))}
            </>
          )}
          <p className="text-[11.5px] text-muted-foreground">
            {t('missionTitles.effective', { value: describe(view.effective, view.backends) })}
          </p>
        </div>
      </div>
    </section>
  );
}
