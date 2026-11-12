'use client';

import { useEffect, useId, useState } from 'react';
import { Input } from '@/components/ui/input';
import { t } from '@/lib/i18n';
import { useNotificationPrefs } from '@/hooks/use-notification-prefs';
import {
  FEED_MAX_MAX,
  FEED_MAX_MIN,
  NOTIFICATION_TYPES,
  clampFeedMax,
  toggleNotificationType,
  type NotificationType,
} from '@/lib/notification-prefs';

const TYPE_LABEL: Record<NotificationType, string> = {
  action_required: 'notifications.prefs.type.action_required',
  alert: 'notifications.prefs.type.alert',
  report: 'notifications.prefs.type.report',
};

/** What the bell's dropdown and the "Notifications" widget list. Lives on the
 *  archive page, next to the push switch: the page the rail reaches in one tap. */
export function NotificationFeedSettings() {
  const { prefs, ready, setPrefs } = useNotificationPrefs();
  const maxId = useId();
  // The field is a draft: committing every keystroke would store 5 on the
  // way to typing 25 (the "2" clamped up).
  const [draft, setDraft] = useState(String(prefs.max));
  useEffect(() => { setDraft(String(prefs.max)); }, [prefs.max]);

  const commit = () => {
    const max = clampFeedMax(draft);
    setDraft(String(max));
    if (max !== prefs.max) setPrefs({ ...prefs, max });
  };

  return (
    <section
      data-notification-feed-settings
      aria-labelledby={`${maxId}-title`}
      className="rounded-xl border border-border/60 bg-card/80 px-4 py-3"
    >
      <h2 id={`${maxId}-title`} className="text-sm font-semibold">{t('notifications.prefs.title')}</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">{t('notifications.prefs.hint')}</p>
      <fieldset className="mt-3" disabled={!ready}>
        <legend className="text-xs font-medium text-muted-foreground">{t('notifications.prefs.types')}</legend>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
          {NOTIFICATION_TYPES.map((type) => {
            const on = prefs.types.includes(type);
            // The last ticked kind stays ticked: an empty dropdown would read
            // as a broken one.
            const last = on && prefs.types.length === 1;
            return (
              <label key={type} className="flex items-center gap-2 text-sm" title={last ? t('notifications.prefs.lastType') : undefined}>
                <input
                  type="checkbox"
                  data-notification-type={type}
                  checked={on}
                  disabled={last}
                  onChange={() => setPrefs(toggleNotificationType(prefs, type))}
                  className="size-4 accent-primary disabled:opacity-60"
                />
                {t(TYPE_LABEL[type])}
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label htmlFor={maxId} className="text-xs font-medium text-muted-foreground">{t('notifications.prefs.max')}</label>
        <Input
          id={maxId}
          type="number"
          inputMode="numeric"
          min={FEED_MAX_MIN}
          max={FEED_MAX_MAX}
          step={1}
          value={draft}
          disabled={!ready}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
          className="h-8 w-20 tabular-nums"
        />
        <span className="text-xs text-muted-foreground">
          {t('notifications.prefs.maxRange', { min: FEED_MAX_MIN, max: FEED_MAX_MAX })}
        </span>
      </div>
    </section>
  );
}
