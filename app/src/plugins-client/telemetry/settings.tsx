'use client';

/**
 * Settings › System › Privacy, the own category of `@timon/telemetry`: the
 * "Share anonymous usage statistics" switch, what it sends and what it never
 * sends. When the environment (`TIMON_TELEMETRY`) or `timon.config.json`
 * decides, the switch is shown as it stands and cannot be moved from here.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { ShieldCheck } from 'lucide-react';
import { BRAND } from '@/lib/brand';
import { t } from '@/lib/i18n';
import {
  TELEMETRY_PREFERENCE_URL, parseTelemetryPreference, telemetryLockKey, type TelemetryPreferenceView,
} from '@/lib/telemetry-preference';

const PRIVACY_DOCS_URL = `https://docs.${BRAND.domain}/usage/privacy`;

export function TelemetrySettings(): ReactElement | null {
  const [pref, setPref] = useState<TelemetryPreferenceView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch(TELEMETRY_PREFERENCE_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      setPref(parseTelemetryPreference(await res.json()));
    } catch {
      setError(t('telemetrySettings.loadFailed'));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggle = async (enabled: boolean) => {
    setBusy(true); setError('');
    try {
      const res = await fetch(TELEMETRY_PREFERENCE_URL, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (res.status === 403) { setError(t('telemetrySettings.forbidden')); return; }
      if (!res.ok) throw new Error(String(res.status));
      setPref(parseTelemetryPreference(await res.json()));
    } catch {
      setError(t('telemetrySettings.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const lock = pref ? telemetryLockKey(pref) : null;

  return (
    <section className="max-w-2xl space-y-5">
      <div>
        <h3 className="flex items-center gap-2 text-[13px] font-semibold tracking-[-0.01em]">
          <ShieldCheck className="size-4" aria-hidden />
          {t('telemetrySettings.title')}
        </h3>
        <p className="mt-1 max-w-[65ch] text-[12px] leading-snug text-muted-foreground">
          {t('telemetrySettings.description')}
        </p>
      </div>

      <label className="flex cursor-pointer items-start justify-between gap-6 rounded-lg border border-border p-4">
        <span>
          <span className="block text-[13px] font-medium leading-snug">{t('telemetrySettings.share')}</span>
          <span className="mt-0.5 block max-w-[65ch] text-[12px] leading-snug text-muted-foreground">
            {t('telemetrySettings.shareDescription')}
          </span>
          {lock && <span className="mt-2 block text-[12px] leading-snug text-amber-600">{t(lock)}</span>}
          {pref && !pref.active && (
            <span className="mt-2 block text-[12px] leading-snug text-muted-foreground">{t('telemetrySettings.inactiveBuild')}</span>
          )}
        </span>
        <input
          type="checkbox"
          checked={pref?.enabled ?? false}
          disabled={busy || !pref || !pref.editable}
          onChange={(event) => { void toggle(event.target.checked); }}
          className="mt-1 size-4 shrink-0 accent-primary"
          aria-label={t('telemetrySettings.share')}
        />
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg bg-muted/40 p-4">
          <p className="text-[12.5px] font-medium">{t('telemetrySettings.sentTitle')}</p>
          <p className="mt-1 text-[12px] leading-snug text-muted-foreground">{t('telemetrySettings.sent')}</p>
        </div>
        <div className="rounded-lg bg-muted/40 p-4">
          <p className="text-[12.5px] font-medium">{t('telemetrySettings.neverTitle')}</p>
          <p className="mt-1 text-[12px] leading-snug text-muted-foreground">{t('telemetrySettings.never')}</p>
        </div>
      </div>

      <p className="text-[12px] text-muted-foreground">
        <a href={PRIVACY_DOCS_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
          {t('telemetrySettings.learnMore')}
        </a>
      </p>

      {error && <p role="alert" className="text-[12px] text-destructive">{error}</p>}
    </section>
  );
}
