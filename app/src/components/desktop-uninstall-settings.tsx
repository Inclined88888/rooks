'use client';

import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { desktopBridge } from '@/lib/desktop';
import { getLocale, t } from '@/lib/i18n';
import { Button } from '@/components/ui/button';

export function DesktopUninstallSettings() {
  const [info, setInfo] = useState<{ home: string; platform: string; appImage: string | null } | null>(null);
  const [mode, setMode] = useState<'keep' | 'delete'>('keep');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    desktopBridge()?.uninstall?.info().then(value => { if (active) setInfo(value); })
      .catch((error: Error) => { if (active) setError(error.message); });
    return () => { active = false; };
  }, []);
  const uninstall = async () => {
    const bridge = desktopBridge()?.uninstall;
    if (!bridge || busy) return;
    setBusy(true); setError('');
    // The shell words its boxes in the app's language, negotiated among the ones it ships.
    try { await bridge.run({ mode, confirmation, locale: getLocale() }); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <section className="max-w-2xl space-y-5">
      <div>
        <h3 className="text-base font-medium">{t('desktopUninstall.title')}</h3>
        <p className="mt-2 text-sm text-muted-foreground">{t('desktopUninstall.description')}</p>
      </div>
      {info && <div className="rounded-lg border border-border p-3 text-sm">
        <p className="text-muted-foreground">{t('desktopUninstall.dataPath')}</p>
        <p /* code-font: file path */ className="mt-1 break-all font-mono text-xs">{info.home}</p>
      </div>}
      <fieldset disabled={busy} className="space-y-3">
        <legend className="mb-2 text-sm font-medium">{t('desktopUninstall.dataChoice')}</legend>
        {(['keep', 'delete'] as const).map(value => <label key={value}
          className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-4 has-[:checked]:border-primary">
          <input type="radio" name="uninstall-data" value={value} checked={mode === value}
            onChange={() => { setMode(value); setConfirmation(''); }} className="mt-1 accent-primary" />
          <span><span className="block text-sm font-medium">{t(`desktopUninstall.${value}`)}</span>
            <span className="mt-1 block text-sm text-muted-foreground">{t(`desktopUninstall.${value}Description`)}</span></span>
        </label>)}
      </fieldset>
      <p className="text-sm text-muted-foreground">{t('desktopUninstall.external')}</p>
      {mode === 'delete' && <label className="block text-sm">
        {t('desktopUninstall.confirmation')}
        <input value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy}
          autoComplete="off" spellCheck={false}
          className="mt-2 block h-9 w-full rounded-md border border-destructive/50 bg-background px-3"
          aria-label={t('desktopUninstall.confirmation')} />
      </label>}
      {info && <p className="text-sm text-muted-foreground">{t(`desktopUninstall.finish.${info.platform === 'darwin' ? 'mac' : info.platform === 'win32' ? 'windows' : info.appImage ? 'appimage' : 'linux'}`)}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button variant="destructive" disabled={!info || busy || (mode === 'delete' && confirmation !== 'SUPPRIMER')}
        onClick={() => void uninstall()}>
        <Trash2 className="mr-2 h-4 w-4" />{t(busy ? 'desktopUninstall.busy' : 'desktopUninstall.action')}
      </Button>
    </section>
  );
}
