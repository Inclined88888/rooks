'use client';

import { useState, type ReactElement } from 'react';
import { AudioLines, KeyRound } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { t } from '@/lib/i18n';
import { notifyGptLiveChanged, useGptLiveStatus } from '@/lib/gpt-live/status';

const SETTING_KEY = 'TIMON_GPT_LIVE_ENABLED';

type PublicSecretRow = { id: string; name: string };

/**
 * GPT-Live in the Voice pane: the on/off switch and the API key it uses.
 *
 * The key is written to the secrets vault with no grant, so no agent ever
 * receives it in its environment — only the daemon reads it to open a
 * session. Like every vault value, it is never shown again once stored.
 */
export function GptLiveSettings(): ReactElement | null {
  const { status, refresh } = useGptLiveStatus();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  // Module disabled, or a caller without access: the section simply isn't there.
  if (!status) return null;

  const toggle = async (enabled: boolean) => {
    setBusy(true); setError(''); setSaved('');
    try {
      const res = await fetch('/api/ui/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: SETTING_KEY, value: enabled ? '1' : '0' }),
      });
      if (!res.ok) throw new Error(String(res.status));
      await refresh();
      notifyGptLiveChanged();
    } catch {
      setError(t('gptLiveSettings.toggleFailed'));
    } finally {
      setBusy(false);
    }
  };

  const saveKey = async () => {
    const value = draft.trim();
    if (!value) return;
    setBusy(true); setError(''); setSaved('');
    try {
      const list = await fetch('/api/ui/secrets', { cache: 'no-store' });
      if (!list.ok) throw new Error(String(list.status));
      const { secrets = [] } = (await list.json()) as { secrets?: PublicSecretRow[] };
      const existing = secrets.find((row) => row.name === status.secretName);
      const res = existing
        ? await fetch(`/api/ui/secrets/${encodeURIComponent(existing.id)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value }),
        })
        : await fetch('/api/ui/secrets', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: status.secretName, value, grants: [], note: 'GPT-Live voice (daemon only)' }),
        });
      if (!res.ok) throw new Error(String(res.status));
      setDraft('');
      setSaved(t('gptLiveSettings.keySaved'));
      await refresh();
      notifyGptLiveChanged();
    } catch (e) {
      setError((e as Error).message === '403' ? t('gptLiveSettings.keyForbidden') : t('gptLiveSettings.keyFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-8 max-w-2xl space-y-5">
      <div>
        <h3 className="flex items-center gap-2 text-[13px] font-semibold tracking-[-0.01em]">
          <AudioLines className="size-4" aria-hidden />
          {t('gptLiveSettings.title')}
        </h3>
        <p className="mt-1 max-w-[65ch] text-[12px] leading-snug text-muted-foreground">
          {t('gptLiveSettings.description')}
        </p>
      </div>

      <label className="flex cursor-pointer items-start justify-between gap-6 rounded-lg border border-border p-4">
        <span>
          <span className="block text-[13px] font-medium leading-snug">{t('gptLiveSettings.enable')}</span>
          <span className="mt-0.5 block max-w-[65ch] text-[12px] leading-snug text-muted-foreground">
            {t('gptLiveSettings.enableDescription')}
          </span>
        </span>
        <input
          type="checkbox"
          checked={status.enabled}
          disabled={busy}
          onChange={(event) => { void toggle(event.target.checked); }}
          className="mt-1 size-4 shrink-0 accent-primary"
          aria-label={t('gptLiveSettings.enable')}
        />
      </label>

      <div className="rounded-lg border border-border p-4">
        <p className="flex items-center gap-2 text-[13px] font-medium leading-snug">
          <KeyRound className="size-3.5" aria-hidden />
          {t('gptLiveSettings.key')}
          <span className={status.hasKey ? 'text-[12px] font-normal text-emerald-600' : 'text-[12px] font-normal text-muted-foreground'}>
            {status.hasKey ? t('gptLiveSettings.keyPresent') : t('gptLiveSettings.keyMissing')}
          </span>
        </p>
        <p className="mt-0.5 max-w-[65ch] text-[12px] leading-snug text-muted-foreground">
          {t('gptLiveSettings.keyDescription', { name: status.secretName })}
        </p>
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(event) => { event.preventDefault(); void saveKey(); }}
        >
          <Input
            type="password"
            autoComplete="off"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={status.hasKey ? t('gptLiveSettings.keyReplacePlaceholder') : 'sk-…'}
            aria-label={t('gptLiveSettings.key')}
            className="h-7 max-w-xs text-[12px]"
          />
          <Button type="submit" variant="outline" size="sm" className="h-7 text-[12px]" disabled={busy || !draft.trim()}>
            {status.hasKey ? t('gptLiveSettings.replaceKey') : t('gptLiveSettings.saveKey')}
          </Button>
        </form>
        {saved && <p role="status" className="mt-2 text-[12px] text-emerald-600">{saved}</p>}
        {error && <p role="alert" className="mt-2 text-[12px] text-destructive">{error}</p>}
        {status.enabled && !status.hasKey && (
          <p className="mt-2 text-[12px] text-amber-600">{t('gptLiveSettings.needsKey')}</p>
        )}
      </div>
    </section>
  );
}
