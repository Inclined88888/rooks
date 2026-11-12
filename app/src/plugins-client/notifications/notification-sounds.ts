/**
 * The behavior half of the sound notifications: listens to the global stream
 * the rest of the app already shares, and plays one sound per event, in one
 * tab. No channel of its own: `task_done` / `task_blocked` are the daemon's
 * task closures, `task_started` a task's first dispatch, `permission_request`
 * the card an agent waits on (a `question` card included).
 *
 * A task start may also show a toast. It has its own switch and its own
 * claim: it shows with the sound off or the volume at zero, and in a tab
 * nobody has clicked in yet.
 */
import {
  soundTriggerOf,
  type NotificationSoundPrefs,
  type SoundChoice,
  type SoundEvent,
  type SoundTrigger,
} from '@/lib/notification-sounds';
import { HIDDEN_TAB_DELAY_MS, type ClaimEnv, claimSound } from '@/lib/notification-sound-player';

export type SoundBehaviorDeps = {
  on: (type: string, listener: (event: MessageEvent) => void) => () => void;
  /** `null` while the account's settings are not known yet. */
  prefs: () => NotificationSoundPrefs | null;
  /** This tab has been unlocked by a gesture. */
  canPlay: () => boolean;
  visible: () => boolean;
  claimEnv: () => ClaimEnv;
  play: (sound: SoundChoice, volume: number, event: SoundEvent) => boolean;
  /** The on-screen notice of a task start. */
  toast: (title: string) => void;
  wait: (ms: number) => Promise<void>;
};

const STREAM_EVENTS = ['task_started', 'task_done', 'task_blocked', 'event', 'mission_turn_done'] as const;

export function startNotificationSounds(deps: SoundBehaviorDeps): () => void {
  let alive = true;

  const sound = async (trigger: SoundTrigger, prefs: NotificationSoundPrefs): Promise<void> => {
    if (prefs.volume === 0) return;
    const setting = prefs.events[trigger.event];
    if (!setting.enabled) return;
    // A tab that cannot play must not take the sound from one that can.
    if (!deps.canPlay()) return;
    if (!deps.visible()) await deps.wait(HIDDEN_TAB_DELAY_MS);
    if (!alive || !deps.canPlay()) return;
    if (!(await claimSound(trigger.key, trigger.event, deps.claimEnv()))) return;
    if (alive) deps.play(setting.sound, prefs.volume, trigger.event);
  };

  const toast = async (trigger: SoundTrigger, prefs: NotificationSoundPrefs): Promise<void> => {
    if (trigger.event !== 'taskStarted' || !prefs.taskStartedToast) return;
    if (!deps.visible()) await deps.wait(HIDDEN_TAB_DELAY_MS);
    if (!alive) return;
    if (!(await claimSound(`toast:${trigger.key}`, 'taskStartedToast', deps.claimEnv()))) return;
    if (alive) deps.toast(trigger.title ?? '');
  };

  const handle = async (streamEvent: string, data: string): Promise<void> => {
    const trigger = soundTriggerOf(streamEvent, data);
    if (!trigger) return;
    const prefs = deps.prefs();
    if (!prefs) return;
    await Promise.all([sound(trigger, prefs), toast(trigger, prefs)]);
  };

  const stops = STREAM_EVENTS.map((type) => deps.on(type, (event) => {
    if (typeof event.data === 'string') void handle(type, event.data);
  }));
  return () => {
    alive = false;
    for (const stop of stops) stop();
  };
}
