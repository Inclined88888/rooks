'use client';

import { useContext, useState } from 'react';
import { Button } from '@/components/ui/button';
import { NativeSettingsContext } from '@/lib/plugin-host/settings-graft';
import { t } from '@/lib/i18n';

export function ResourceMemoryPresets() {
  const settings = useContext(NativeSettingsContext);
  const [saving, setSaving] = useState<number | null>(null);
  const [message, setMessage] = useState<'saved' | 'error' | null>(null);
  if (!settings?.resourceMemory) return null;
  const { resourceMemory, refresh } = settings;

  async function apply(ramGb: number) {
    setSaving(ramGb);
    setMessage(null);
    try {
      const response = await fetch('/api/ui/settings/resource-memory-preset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ramGb }),
      });
      if (!response.ok) throw new Error('Preset request failed');
      if (!await refresh()) throw new Error('Settings refresh failed');
      setMessage('saved');
    } catch {
      setMessage('error');
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="space-y-3 py-4" aria-label={t('resourceMemory.title')} aria-busy={saving !== null}>
      <h3 className="text-[13px] font-medium">{t('resourceMemory.title')}</h3>
      <p className="text-xs text-muted-foreground">
        {t('resourceMemory.detected', { ram: resourceMemory.detectedRamGb.toFixed(1), tier: resourceMemory.autoClassGb })}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full max-w-xl text-left text-xs tabular-nums">
          <thead>
            <tr className="text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">{t('resourceMemory.class')}</th>
              <th scope="col" className="py-2 pr-3 font-medium">{t('resourceMemory.mission')}</th>
              <th scope="col" className="py-2 pr-3 font-medium">{t('resourceMemory.day')}</th>
              <th scope="col" className="py-2 font-medium">{t('resourceMemory.night')}</th>
            </tr>
          </thead>
          <tbody>
            {resourceMemory.presets.map((preset) => (
              <tr key={preset.ramGb}>
                <th scope="row" className="py-1 pr-3 font-normal">
                  <Button variant="outline" size="sm" disabled={saving !== null}
                    aria-label={t('resourceMemory.apply', { ram: preset.ramGb })}
                    onClick={() => void apply(preset.ramGb)}>
                    {saving === preset.ramGb ? t('resourceMemory.saving') : t('resourceMemory.gb', { value: preset.ramGb })}
                  </Button>
                </th>
                <td className="pr-3">{t('resourceMemory.gb', { value: preset.missionGb })}</td>
                <td className="pr-3">{t('resourceMemory.gb', { value: preset.dayGb })}</td>
                <td>{t('resourceMemory.gb', { value: preset.nightGb })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="max-w-[65ch] text-xs text-muted-foreground">{t('resourceMemory.help')}</p>
      {message && <p role={message === 'error' ? 'alert' : 'status'} className="text-xs">{t(`resourceMemory.${message}`)}</p>}
    </section>
  );
}
