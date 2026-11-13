'use client';

import dynamic from 'next/dynamic';
import { toast } from 'sonner';
import { currentNotificationSoundPrefs, subscribeNotificationSoundPrefs } from '@/hooks/use-notification-sound-prefs';
import { isPageSurfaceAllowed } from '@/lib/capabilities';
import { t } from '@/lib/i18n';
import { audioUnlocked, browserClaimEnv, installAudioUnlock, playSound } from '@/lib/notification-sound-player';
import { restoreCustomSound } from '@/lib/notification-custom-sounds';
import { CUSTOM_SOUND, SOUND_EVENTS } from '@/lib/notification-sounds';
import { sseOn } from '@/lib/sse-stream';
import { startNotificationSounds } from './notifications/notification-sounds';
import type { BundledClientPlugin } from './types';

// Loaded on demand (docs/BUNDLE-SIZE.md): statically imported, every page of the app paid for it.
const NotificationSoundSettings = dynamic(() => import('./notifications/notification-sound-settings').then((m) => m.NotificationSoundSettings), { ssr: false });

/** Sound notifications: a behavior (listen, play once across tabs) and its
 *  settings, grafted in the Notifications pane. A half of the notifications
 *  module, so switching that module off silences them too. */
export const notificationSoundsClient: BundledClientPlugin = {
  module: '@rooks/notifications',
  apply(ctx) {
    if (isPageSurfaceAllowed(ctx.caps, '/settings')) {
      ctx.register({ slot: 'settings.notifications', key: 'sounds' }, NotificationSoundSettings);
    }
    // Keeps the settings loaded for the behavior, which reads them outside React.
    // …and decodes the imported files an event points at, so the first sound is not the default.
    ctx.onDispose(subscribeNotificationSoundPrefs(() => {
      const prefs = currentNotificationSoundPrefs();
      if (!prefs) return;
      for (const event of SOUND_EVENTS) {
        if (prefs.events[event].sound === CUSTOM_SOUND) void restoreCustomSound(event);
      }
    }));
    ctx.onDispose(installAudioUnlock());
    ctx.onDispose(startNotificationSounds({
      on: sseOn,
      prefs: currentNotificationSoundPrefs,
      canPlay: audioUnlocked,
      visible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
      claimEnv: browserClaimEnv,
      play: playSound,
      toast: (title) => { toast(t('notifications.sounds.toast.taskStarted'), title ? { description: title } : undefined); },
      wait: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    }));
  },
};
