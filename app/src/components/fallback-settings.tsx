'use client';

/**
 * Fallback pane of the Models settings (the "Auto switch" tab).
 *
 * It replaces the two free-text rows that used to ask for the fallback
 * backend and its exact model slug by hand — a pair written from memory that
 * broke as soon as a provider renamed a slug. The control now shows the
 * current pair (logo, model, backend) and opens the composer's own model menu;
 * a pick writes BOTH `ROOKS_FALLBACK_BACKEND` and `ROOKS_FALLBACK_MODEL` so the
 * pair can never disagree.
 *
 * The on/off switch and the two cooldowns stay ordinary settings rows: they
 * are single values, no pairing to protect.
 */

import { useCallback, useContext, useEffect, useMemo, useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { ChevronDown } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BrandMark } from '@/components/brand-mark';
import { LlmMenu } from '@/components/chat/llm-menu';
import { SettingsRow, type Setting } from '@/components/settings/settings-row';
import { AccountStateBadge } from '@/components/account-state-badge';
import { backendLabel, useBackendCatalog, type BackendName } from '@/lib/backends';
import { NativeSettingsContext } from '@/lib/plugin-host/settings-graft';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { apiErrorMessage } from '@/lib/api-error';

const KEY_PREFERRED = 'ROOKS_PREFERRED_BACKEND';
const KEY_ENABLED = 'ROOKS_FALLBACK_ENABLED';
const KEY_BACKEND = 'ROOKS_FALLBACK_BACKEND';
const KEY_MODEL = 'ROOKS_FALLBACK_MODEL';
const KEY_COOLDOWN = 'ROOKS_FALLBACK_COOLDOWN_MS';
const KEY_EXHAUSTED = 'ROOKS_BACKEND_EXHAUSTED_COOLDOWN_MS';

export function FallbackSettings(): ReactElement {
  const { includeAdvanced } = useContext(NativeSettingsContext) ?? {};
  const [settings, setSettings] = useState<Setting[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch('/api/ui/settings', { cache: 'no-store' });
    if (!r.ok) return false;
    const data = (await r.json()) as { settings?: Setting[] };
    setSettings(data.settings ?? []);
    setDrafts({});
    return true;
  }, []);
  useEffect(() => { void load(); }, [load]);

  const byKey = useMemo(() => new Map(settings.map((s) => [s.key, s])), [settings]);

  const save = useCallback(async (key: string, value: string | null) => {
    setSaving(key);
    const r = await fetch('/api/ui/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
    setSaving(null);
    if (!r.ok) {
      const err = (await r.json().catch(() => ({}))) as { error?: string };
      toast.error(apiErrorMessage(err, t('settingsPage.saveError')));
      return;
    }
    toast.success(value === null ? t('settingsPage.resetToDefault') : t('settingsPage.saved'));
    await load();
  }, [load]);

  const onDraft = useCallback((key: string, value: string) => {
    setDrafts((d) => ({ ...d, [key]: value }));
  }, []);

  const preferred = byKey.get(KEY_PREFERRED);
  const enabled = byKey.get(KEY_ENABLED);
  const backendRow = byKey.get(KEY_BACKEND);
  const modelRow = byKey.get(KEY_MODEL);
  const cooldown = byKey.get(KEY_COOLDOWN);
  const exhausted = byKey.get(KEY_EXHAUSTED);

  const backend = String(backendRow?.value ?? '');
  const model = String(modelRow?.value ?? '');
  const locked = [backendRow, modelRow].some((row) => row?.source === 'env' || row?.source === 'config');
  const lockedBy = [backendRow, modelRow].find((row) => row?.source === 'env' || row?.source === 'config')?.source ?? null;
  const overridden = !!(backendRow?.overridden || modelRow?.overridden);

  // Sequential on purpose: a failure on the first key leaves the old pair
  // whole instead of a new backend next to the previous provider's model.
  // `null` resets both keys to their defaults.
  const savePair = useCallback(async (b: string | null, m: string | null): Promise<boolean> => {
    setSaving(KEY_BACKEND);
    const put = (key: string, value: string | null) => fetch('/api/ui/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
    try {
      const first = await put(KEY_BACKEND, b);
      const second = first.ok ? await put(KEY_MODEL, m) : null;
      if (!first.ok || !second?.ok) {
        toast.error(t('fallbackSettings.saveFailed'));
        return false;
      }
      toast.success(b === null ? t('settingsPage.resetToDefault') : t('settingsPage.saved'));
      return true;
    } catch {
      toast.error(t('fallbackSettings.saveFailed'));
      return false;
    } finally {
      setSaving(null);
      await load();
    }
  }, [load]);

  return (
    <div className="space-y-5">
      <p className="max-w-[65ch] text-[13px] leading-snug text-muted-foreground">
        {t('fallbackSettings.description')}
      </p>

      <div className="space-y-1">
        {preferred && (
          <div className="pb-4">
            <PreferredProviderRow setting={preferred} busy={saving === KEY_PREFERRED} onSave={save} />
          </div>
        )}
        {enabled && (
          <SettingsRow
            setting={enabled}
            draft={drafts[enabled.key]}
            saving={saving === enabled.key}
            onDraft={onDraft}
            onSave={save}
          />
        )}

        <div className="py-4">
          <FallbackModelRow
            backend={backend}
            model={model}
            locked={locked}
            lockedBy={lockedBy}
            overridden={overridden}
            busy={saving === KEY_BACKEND}
            onPick={(b, m) => void savePair(b, m)}
            onClear={() => void savePair('', '')}
            onReset={() => void savePair(null, null)}
          />
        </div>

        {includeAdvanced && cooldown && (
          <SettingsRow
            setting={cooldown}
            draft={drafts[cooldown.key]}
            saving={saving === cooldown.key}
            onDraft={onDraft}
            onSave={save}
          />
        )}
        {includeAdvanced && exhausted && (
          <SettingsRow
            setting={exhausted}
            draft={drafts[exhausted.key]}
            saving={saving === exhausted.key}
            onDraft={onDraft}
            onSave={save}
          />
        )}
      </div>

    </div>
  );
}

/** The fallback pair as a settings row: the control IS the current choice,
 *  so it reads at a glance and one click opens the composer's model menu. */
function FallbackModelRow({
  backend,
  model,
  locked,
  lockedBy,
  overridden,
  busy,
  onPick,
  onClear,
  onReset,
}: {
  backend: string;
  model: string;
  locked: boolean;
  lockedBy: Setting['source'] | null;
  overridden: boolean;
  busy: boolean;
  onPick: (backend: BackendName, model: string) => void;
  onClear: () => void;
  onReset: () => void;
}): ReactElement {
  const catalog = useBackendCatalog();
  const entry = catalog.backends.find((b) => b.id === backend);
  const resolvedModel = model || entry?.defaultModel || '';
  const found = entry?.models.find((m) => m.slug === resolvedModel);
  const modelName = found ? (found.presetLabel ?? found.label) : resolvedModel;
  // An account the catalogue no longer lists reads as unavailable, not as
  // its raw instance id.
  const backendName = backendLabel(catalog, backend);

  const trigger = (
    <button
      type="button"
      disabled={locked || busy}
      aria-label={t('fallbackSettings.change')}
      className={cn(
        'flex h-9 w-72 max-w-full items-center gap-2.5 rounded-lg border border-border bg-background px-2.5 text-left transition-colors',
        'hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-60',
      )}
    >
      {backend ? (
        <>
          <BrandMark
            icon={found?.icon}
            brand={found?.brand}
            slug={resolvedModel || undefined}
            fallbackIcon={entry?.icon}
            fallbackBrand={entry?.brand}
            className="size-4"
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-medium text-foreground">
              {modelName || t('fallbackSettings.defaultModel')}
            </span>
            <span className="block truncate text-[10.5px] text-muted-foreground">
              {model ? backendName : t('fallbackSettings.backendDefault', { backend: backendName })}
            </span>
          </span>
          <AccountStateBadge backend={entry} />
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">
          {t('fallbackSettings.noneShort')}
        </span>
      )}
      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  );

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium leading-snug">
            {t('fallbackSettings.model')}
          </span>
          {overridden && !locked && (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
              {t('settingsPage.modified')}
            </span>
          )}
          {locked && (
            <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400">
              {lockedBy === 'config' ? t('settingsPage.definedInConfig') : t('settingsPage.forcedByEnv')}
            </span>
          )}
        </div>
        <p className="mt-0.5 max-w-[65ch] text-[12px] leading-snug text-muted-foreground">
          {t('fallbackSettings.modelDescription')}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 self-start">
        {locked ? trigger : (
          <LlmMenu
            backend={backend}
            model={resolvedModel}
            reasoningEffort={null}
            onPick={(b, m) => onPick(b, m)}
            busy={busy}
            align="end"
            confirm={false}
          >
            {trigger}
          </LlmMenu>
        )}
        {!locked && (backend || overridden) && (
          <div className="flex items-center gap-1">
            {backend && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px] text-muted-foreground"
                disabled={busy}
                onClick={onClear}
              >
                {t('fallbackSettings.clear')}
              </Button>
            )}
            {overridden && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px] text-muted-foreground"
                disabled={busy}
                onClick={onReset}
              >
                {t('settingsPage.defaultBtn')}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const AUTO = '__auto__';

/** The provider a blank agent, mission or chat runs on. Backend only: each
 *  provider keeps its own default model. */
function PreferredProviderRow({ setting, busy, onSave }: {
  setting: Setting;
  busy: boolean;
  onSave: (key: string, value: string | null) => void;
}): ReactElement {
  const catalog = useBackendCatalog();
  const locked = setting.source === 'env' || setting.source === 'config';
  const value = String(setting.value ?? '');
  // Accounts are a choice of subscription made per agent, never a machine-wide default.
  const providers = catalog.backends.filter((b) => !b.account);
  const known = providers.some((b) => b.id === value);
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium leading-snug">{t('fallbackSettings.preferred')}</span>
          {locked && (
            <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400">
              {setting.source === 'config' ? t('settingsPage.definedInConfig') : t('settingsPage.forcedByEnv')}
            </span>
          )}
        </div>
        <p className="mt-0.5 max-w-[65ch] text-[12px] leading-snug text-muted-foreground">
          {t('fallbackSettings.preferredDescription')}
        </p>
      </div>
      <Select
        value={value && known ? value : AUTO}
        disabled={locked || busy}
        onValueChange={(next) => onSave(KEY_PREFERRED, next === AUTO ? null : next)}
      >
        <SelectTrigger className="h-9 w-72 max-w-full text-[12.5px]" aria-label={t('fallbackSettings.preferred')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTO}>{t('fallbackSettings.preferredAuto')}</SelectItem>
          {providers.map((b) => (
            <SelectItem key={b.id} value={b.id}>
              <span className="flex items-center gap-2">
                <BrandMark brand={b.brand} fallbackIcon={b.icon} className="size-4" />
                {b.label}
                <AccountStateBadge backend={b} />
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
