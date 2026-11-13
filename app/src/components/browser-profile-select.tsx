'use client';

import { useEffect, useState } from 'react';
import { t } from '@/lib/i18n';
import { nativeBrowserRequest, type BrowserProfile } from '@/lib/native-browser';

/** Unset inherits; null explicitly denies browser access. Never convert one into the other. */
export function BrowserProfileSelect({ value, onChange, disabled = false }: {
  value: string | null | undefined; onChange: (value: string | null | undefined) => void; disabled?: boolean;
}) {
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void nativeBrowserRequest<{ profiles: BrowserProfile[] }>('profiles', undefined, controller.signal)
      .then((result) => setProfiles(result.profiles))
      .catch((err) => { if (!controller.signal.aborted) setError((err as Error).message); });
    return () => controller.abort();
  }, []);
  return <div className="space-y-1">
    <select aria-label={t('browserPanel.native.profile')} disabled={disabled} className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs" value={value === null ? '__none__' : value ?? '__inherit__'} onChange={(event) => onChange(event.target.value === '__none__' ? null : event.target.value === '__inherit__' ? undefined : event.target.value)}>
      <option value="__inherit__">{t('browserPanel.native.inherit')}</option>
      <option value="__none__">{t('browserPanel.native.noAccess')}</option>
      {value && !profiles.some((profile) => profile.id === value) && <option value={value}>{value}</option>}
      {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
    </select>
    <p className="text-[10px] text-muted-foreground">{t('browserPanel.native.profileHint')}</p>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>;
}
