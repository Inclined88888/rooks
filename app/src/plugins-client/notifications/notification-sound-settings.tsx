'use client';

import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { FolderOpen, Play, X } from 'lucide-react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { t } from '@/lib/i18n';
import { useNotificationSoundPrefs } from '@/hooks/use-notification-sound-prefs';
import { previewSound } from '@/lib/notification-sound-player';
import {
  CUSTOM_ACCEPT,
  CUSTOM_MAX_BYTES,
  CUSTOM_MAX_SECONDS,
  clearCustomSound,
  importCustomSound,
  listCustomSounds,
  type CustomSounds,
} from '@/lib/notification-custom-sounds';
import {
  BUILTIN_SOUNDS,
  SOUND_EVENTS,
  clampVolume,
  DEFAULT_NOTIFICATION_SOUND_PREFS,
  CUSTOM_SOUND,
  isSoundChoice,
  setEventSound,
  type SoundChoice,
  type SoundEvent,
} from '@/lib/notification-sounds';

const SELECT = 'h-8 rounded-md border border-border bg-background px-2 text-[13px] focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60';

/** Grafted in the Notifications pane of the settings (`settings.notifications`). */
export function NotificationSoundSettings(): ReactElement {
  const { prefs, ready, setPrefs } = useNotificationSoundPrefs();
  const id = useId();
  // The slider is a draft: storing every step of a drag would send a write
  // per pixel.
  const [volume, setVolume] = useState(prefs.volume);
  useEffect(() => { setVolume(prefs.volume); }, [prefs.volume]);
  // The files this account imported: which events have one, and how it is called.
  const [custom, setCustom] = useState<CustomSounds>({});
  useEffect(() => {
    let alive = true;
    void listCustomSounds().then((found) => { if (alive) setCustom(found); });
    return () => { alive = false; };
  }, []);
  const commitVolume = (): void => {
    const next = clampVolume(volume);
    if (next !== prefs.volume) setPrefs({ ...prefs, volume: next });
  };

  return (
    <section
      data-notification-sound-settings
      aria-labelledby={`${id}-title`}
      className="mt-4 max-w-2xl rounded-xl border border-border/60 bg-card/80 px-4 py-3"
    >
      <h2 id={`${id}-title`} className="text-sm font-semibold">{t('notifications.sounds.title')}</h2>
      <p className="mt-0.5 max-w-[65ch] text-xs text-muted-foreground">{t('notifications.sounds.hint')}</p>

      <label className="mt-3 flex flex-col gap-1.5 text-xs" htmlFor={`${id}-volume`}>
        <span className="flex justify-between font-medium text-muted-foreground">
          {t('notifications.sounds.volume')}
          <output className="tabular-nums">{volume === 0 ? t('notifications.sounds.muted') : `${volume} %`}</output>
        </span>
        <input
          id={`${id}-volume`}
          type="range"
          min={0}
          max={100}
          step={5}
          value={volume}
          disabled={!ready}
          onChange={(e) => setVolume(clampVolume(e.target.value))}
          onPointerUp={commitVolume}
          onKeyUp={commitVolume}
          onBlur={commitVolume}
          className="w-full accent-primary disabled:opacity-60"
        />
      </label>

      <ul className="mt-3 space-y-2">
        {SOUND_EVENTS.map((event) => (
          <EventRow
            key={event}
            event={event}
            enabled={prefs.events[event].enabled}
            sound={prefs.events[event].sound}
            volume={volume}
            disabled={!ready}
            customName={custom[event]?.name ?? null}
            toast={event === 'taskStarted'
              ? { enabled: prefs.taskStartedToast, onChange: (taskStartedToast) => setPrefs({ ...prefs, taskStartedToast }) }
              : null}
            onEnabled={(enabled) => setPrefs(setEventSound(prefs, event, { enabled }))}
            onSound={(sound) => setPrefs(setEventSound(prefs, event, { sound }))}
            onImported={(name) => {
              setCustom((c) => ({ ...c, [event]: { name, size: 0 } }));
              setPrefs(setEventSound(prefs, event, { sound: CUSTOM_SOUND }));
            }}
            onCleared={() => {
              setCustom((c) => { const { [event]: _gone, ...rest } = c; return rest; });
              if (prefs.events[event].sound === CUSTOM_SOUND) {
                setPrefs(setEventSound(prefs, event, { sound: DEFAULT_NOTIFICATION_SOUND_PREFS.events[event].sound }));
              }
            }}
          />
        ))}
      </ul>
    </section>
  );
}

function EventRow({
  event,
  enabled,
  sound,
  volume,
  disabled,
  customName,
  toast: toastSetting,
  onEnabled,
  onSound,
  onImported,
  onCleared,
}: {
  event: SoundEvent;
  enabled: boolean;
  sound: SoundChoice;
  volume: number;
  disabled: boolean;
  /** Name of the file imported for this event; `null` when none. */
  customName: string | null;
  /** The on-screen notice this event may show besides its sound; `null` when none. */
  toast: { enabled: boolean; onChange: (enabled: boolean) => void } | null;
  onEnabled: (enabled: boolean) => void;
  onSound: (sound: SoundChoice) => void;
  onImported: (name: string) => void;
  onCleared: () => void;
}): ReactElement {
  const id = useId();
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const label = t(`notifications.sounds.event.${event}.label`);
  const soundName = sound === CUSTOM_SOUND
    ? (customName || t('notifications.sounds.custom.option'))
    : t(`notifications.sounds.name.${sound}`);

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file || busy) return;
    setBusy(true);
    try {
      const outcome = await importCustomSound(event, file);
      if (outcome.ok) { onImported(outcome.name); return; }
      toast.error(t(`notifications.sounds.custom.error.${outcome.reason}`, {
        seconds: CUSTOM_MAX_SECONDS,
        kib: CUSTOM_MAX_BYTES / 1024,
      }));
    } finally {
      setBusy(false);
      if (picker.current) picker.current.value = '';
    }
  };
  return (
    <li data-sound-event={event} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-foreground/[0.03] px-3 py-2.5">
      <Switch
        id={`${id}-on`}
        checked={enabled}
        disabled={disabled}
        onCheckedChange={onEnabled}
        aria-label={t('notifications.sounds.enable', { event: label })}
      />
      <label htmlFor={`${id}-on`} className="min-w-0 flex-1 cursor-pointer">
        <span className="block text-[13px] font-medium leading-snug">{label}</span>
        <span className="block text-[12px] leading-snug text-muted-foreground">
          {t(`notifications.sounds.event.${event}.description`)}
        </span>
      </label>
      <div className="flex items-center gap-2">
        <select
          aria-label={t('notifications.sounds.sound')}
          value={sound}
          disabled={disabled || !enabled}
          onChange={(e) => { if (isSoundChoice(e.target.value)) onSound(e.target.value); }}
          className={SELECT}
        >
          {BUILTIN_SOUNDS.map((option) => (
            <option key={option} value={option}>{t(`notifications.sounds.name.${option}`)}</option>
          ))}
          {customName !== null && (
            <option value={CUSTOM_SOUND}>{customName || t('notifications.sounds.custom.option')}</option>
          )}
        </select>
        <input
          ref={picker}
          type="file"
          accept={CUSTOM_ACCEPT}
          hidden
          data-sound-file={event}
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <button
          type="button"
          data-sound-browse={event}
          disabled={disabled || busy}
          onClick={() => picker.current?.click()}
          aria-label={t('notifications.sounds.custom.browse', { event: label })}
          title={t('notifications.sounds.custom.browse', { event: label })}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40"
        >
          <FolderOpen className="size-3.5" aria-hidden />
        </button>
        {customName !== null && (
          <button
            type="button"
            data-sound-clear={event}
            disabled={disabled || busy}
            onClick={() => { void clearCustomSound(event).then((ok) => { if (ok) onCleared(); }); }}
            aria-label={t('notifications.sounds.custom.clear', { name: customName || t('notifications.sounds.custom.option') })}
            title={t('notifications.sounds.custom.clear', { name: customName || t('notifications.sounds.custom.option') })}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        )}
        <button
          type="button"
          data-sound-preview={event}
          disabled={volume === 0}
          onClick={() => previewSound(sound, volume, event)}
          aria-label={t('notifications.sounds.listen', { sound: soundName })}
          title={t('notifications.sounds.listen', { sound: soundName })}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40"
        >
          <Play className="size-3.5" aria-hidden />
        </button>
      </div>
      {toastSetting && (
        <div className="flex basis-full items-center gap-x-4 pt-1">
          <Switch
            id={`${id}-toast`}
            checked={toastSetting.enabled}
            disabled={disabled}
            onCheckedChange={toastSetting.onChange}
            data-sound-toast={event}
          />
          <label htmlFor={`${id}-toast`} className="min-w-0 flex-1 cursor-pointer">
            <span className="block text-[13px] font-medium leading-snug">{t(`notifications.sounds.event.${event}.toast`)}</span>
            <span className="block text-[12px] leading-snug text-muted-foreground">
              {t(`notifications.sounds.event.${event}.toastDescription`)}
            </span>
          </label>
        </div>
      )}
    </li>
  );
}
