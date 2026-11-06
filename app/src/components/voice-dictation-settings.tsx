'use client';

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Mic } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { DICTEE_GRACE_MS } from '@/lib/stt-dictee';
import {
  chargerPushToTalk,
  enregistrerPushToTalk,
  libelleTouche,
  toucheAutorisee,
  type PushToTalkPrefs,
} from '@/lib/push-to-talk';

/**
 * Voice dictation preferences of THIS device: hold-to-talk and its key.
 *
 * Device-local, like the push subscription next door: a keyboard shortcut does
 * not travel from a desktop to a phone, so it lives in `localStorage` and not
 * in the daemon's settings table.
 */
export function VoiceDictationSettings(): ReactElement {
  const [prefs, setPrefs] = useState<PushToTalkPrefs | null>(null);
  const [capture, setCapture] = useState(false);
  const [refus, setRefus] = useState('');

  // Read after mount: `localStorage` doesn't exist while the page is rendered
  // on the server, and a first paint from the default would flip the switch
  // under the user's eyes.
  useEffect(() => { setPrefs(chargerPushToTalk()); }, []);

  const appliquer = useCallback((suivant: PushToTalkPrefs) => {
    setPrefs(suivant);
    enregistrerPushToTalk(suivant);
  }, []);

  useEffect(() => {
    if (!capture || !prefs) return;
    const surTouche = (event: KeyboardEvent) => {
      event.preventDefault();
      if (event.key === 'Escape') { setCapture(false); return; }
      if (!toucheAutorisee(event.code)) {
        setRefus(t('voiceSettings.keyRefused', { key: libelleTouche(event.code) || event.key }));
        return;
      }
      setRefus('');
      setCapture(false);
      appliquer({ ...prefs, code: event.code });
    };
    window.addEventListener('keydown', surTouche, true);
    return () => window.removeEventListener('keydown', surTouche, true);
  }, [capture, prefs, appliquer]);

  if (!prefs) return <section className="max-w-2xl" aria-busy="true" />;

  return (
    <section className="max-w-2xl space-y-5">
      <div>
        <h3 className="text-[13px] font-semibold tracking-[-0.01em]">{t('voiceSettings.title')}</h3>
        <p className="mt-1 max-w-[65ch] text-[12px] leading-snug text-muted-foreground">
          {t('voiceSettings.graceHint', { seconds: String(Math.round(DICTEE_GRACE_MS / 1000)) })}
        </p>
      </div>

      <label className="flex cursor-pointer items-start justify-between gap-6 rounded-lg border border-border p-4">
        <span>
          <span className="block text-[13px] font-medium leading-snug">{t('voiceSettings.pushToTalk')}</span>
          <span className="mt-0.5 block max-w-[65ch] text-[12px] leading-snug text-muted-foreground">
            {t('voiceSettings.pushToTalkDescription')}
          </span>
        </span>
        <input
          type="checkbox"
          checked={prefs.actif}
          onChange={(event) => appliquer({ ...prefs, actif: event.target.checked })}
          className="mt-1 size-4 shrink-0 accent-primary"
          aria-label={t('voiceSettings.pushToTalk')}
        />
      </label>

      <div className="rounded-lg border border-border p-4">
        <p className="text-[13px] font-medium leading-snug">{t('voiceSettings.key')}</p>
        <p className="mt-0.5 max-w-[65ch] text-[12px] leading-snug text-muted-foreground">{t('voiceSettings.keyDescription')}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <kbd className="rounded-md border border-border bg-muted px-2 py-1 text-xs">
            {libelleTouche(prefs.code)}
          </kbd>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[12px]"
            onClick={() => { setRefus(''); setCapture((v) => !v); }}
          >
            <Mic className="mr-1.5 size-3.5" aria-hidden />
            {capture ? t('voiceSettings.capturing') : t('voiceSettings.changeKey')}
          </Button>
        </div>
        {refus && <p role="alert" className="mt-2 text-[12px] text-destructive">{refus}</p>}
      </div>
    </section>
  );
}
