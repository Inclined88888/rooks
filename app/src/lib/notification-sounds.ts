/**
 * Sound notifications: which event plays which built-in sound, at what volume.
 *
 * Stored like the feed's settings (`notification-prefs.ts`): one `ui_layout`
 * row of the account, so every client of the account plays the same sounds.
 * Read defensively: a row from a later version, or garbage, falls back field
 * by field to the defaults rather than silencing everything.
 */

/** Events that play a sound. A blocked task gets its own entry, and by
 *  default its own sound: "it finished" and "it stopped" must not sound the
 *  same. Rooks has no FAILED status — `kanban_mark_as_failed` closes a task
 *  as BLOCKED — so `taskBlocked` covers failures too. */
export type SoundEvent = 'taskStarted' | 'taskDone' | 'taskBlocked' | 'approval' | 'missionDone';

/** Display order of the settings: a task's life, then the rest. */
export const SOUND_EVENTS: readonly SoundEvent[] = ['taskStarted', 'taskDone', 'taskBlocked', 'approval', 'missionDone'];

/** Built-in sounds, synthesized in the browser (`notification-sound-synth.ts`). */
export type SoundId = 'chime' | 'bell' | 'pop' | 'ping' | 'rise' | 'fall';

export const BUILTIN_SOUNDS: readonly SoundId[] = ['chime', 'bell', 'pop', 'ping', 'rise', 'fall'];

/** The file the user imported for an event (`notification-custom-sounds.ts`):
 *  the preference only names it, the bytes live on the account's daemon. */
export const CUSTOM_SOUND = 'custom';
export type SoundChoice = SoundId | typeof CUSTOM_SOUND;

/** Daemon layout scope (`^[a-z0-9][a-z0-9._-]{0,63}$`). */
export const NOTIFICATION_SOUNDS_SCOPE = 'notifications.sounds';

export type EventSound = { enabled: boolean; sound: SoundChoice };

export type NotificationSoundPrefs = {
  /** 0–100, applied to every event. */
  volume: number;
  events: Readonly<Record<SoundEvent, EventSound>>;
  /** An on-screen toast when a task starts, independent of its sound. */
  taskStartedToast: boolean;
};

export const DEFAULT_NOTIFICATION_SOUND_PREFS: NotificationSoundPrefs = {
  volume: 60,
  events: {
    // Off: a series starts dozens of tasks, the tester asked to be told, not
    // every account (SUG-0075).
    taskStarted: { enabled: false, sound: 'pop' },
    taskDone: { enabled: true, sound: 'chime' },
    taskBlocked: { enabled: true, sound: 'fall' },
    approval: { enabled: true, sound: 'rise' },
    missionDone: { enabled: true, sound: 'ping' },
  },
  taskStartedToast: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSoundEvent(value: unknown): value is SoundEvent {
  return typeof value === 'string' && (SOUND_EVENTS as readonly string[]).includes(value);
}

export function isSoundId(value: unknown): value is SoundId {
  return typeof value === 'string' && (BUILTIN_SOUNDS as readonly string[]).includes(value);
}

export function isSoundChoice(value: unknown): value is SoundChoice {
  return value === CUSTOM_SOUND || isSoundId(value);
}

/** A typed volume brought back to 0–100; anything else is the default. */
export function clampVolume(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_NOTIFICATION_SOUND_PREFS.volume;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function readEvent(raw: unknown, fallback: EventSound): EventSound {
  if (!isRecord(raw)) return fallback;
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
    sound: isSoundChoice(raw.sound) ? raw.sound : fallback.sound,
  };
}

export function readNotificationSoundPrefs(raw: unknown): NotificationSoundPrefs {
  if (!isRecord(raw)) return DEFAULT_NOTIFICATION_SOUND_PREFS;
  const events = isRecord(raw.events) ? raw.events : {};
  return {
    volume: raw.volume === undefined ? DEFAULT_NOTIFICATION_SOUND_PREFS.volume : clampVolume(raw.volume),
    events: {
      taskStarted: readEvent(events.taskStarted, DEFAULT_NOTIFICATION_SOUND_PREFS.events.taskStarted),
      taskDone: readEvent(events.taskDone, DEFAULT_NOTIFICATION_SOUND_PREFS.events.taskDone),
      taskBlocked: readEvent(events.taskBlocked, DEFAULT_NOTIFICATION_SOUND_PREFS.events.taskBlocked),
      approval: readEvent(events.approval, DEFAULT_NOTIFICATION_SOUND_PREFS.events.approval),
      missionDone: readEvent(events.missionDone, DEFAULT_NOTIFICATION_SOUND_PREFS.events.missionDone),
    },
    taskStartedToast: raw.taskStartedToast === true,
  };
}

export function writeNotificationSoundPrefs(prefs: NotificationSoundPrefs): {
  v: 1;
  volume: number;
  events: Record<SoundEvent, EventSound>;
  taskStartedToast: boolean;
} {
  const clean = readNotificationSoundPrefs(prefs);
  return { v: 1, volume: clean.volume, events: { ...clean.events }, taskStartedToast: clean.taskStartedToast };
}

export function setEventSound(
  prefs: NotificationSoundPrefs,
  event: SoundEvent,
  patch: Partial<EventSound>,
): NotificationSoundPrefs {
  return { ...prefs, events: { ...prefs.events, [event]: { ...prefs.events[event], ...patch } } };
}

/** What a stream message means for the sounds: which event, and the key that
 *  identifies it across tabs (two tabs receive the same message). `null` for
 *  anything that plays nothing. */
export type SoundTrigger = {
  event: SoundEvent;
  key: string;
  /** The task's title, for the toast of a start. */
  title?: string;
};

export function soundTriggerOf(streamEvent: string, data: string): SoundTrigger | null {
  // `event` carries every mission event of the account, transcripts included:
  // parsing each one to find the rare permission request would cost a JSON
  // parse per streamed message.
  if (streamEvent === 'event' && !data.includes('"type":"permission_request"')) return null;
  let body: unknown;
  try { body = JSON.parse(data); } catch { return null; }
  if (!isRecord(body)) return null;
  if (streamEvent === 'task_done' || streamEvent === 'task_blocked') {
    if (typeof body.taskId !== 'string' || !body.taskId) return null;
    return {
      event: streamEvent === 'task_done' ? 'taskDone' : 'taskBlocked',
      key: `${streamEvent}:${body.taskId}`,
    };
  }
  if (streamEvent === 'task_started') {
    // The daemon sends it once per task, at its first dispatch: a requeue or a
    // restart of the same task never comes back here.
    if (typeof body.taskId !== 'string' || !body.taskId) return null;
    return {
      event: 'taskStarted',
      key: `task_started:${body.taskId}`,
      title: typeof body.title === 'string' ? body.title : '',
    };
  }
  if (streamEvent === 'mission_turn_done') {
    // One sound per turn: the daemon stamps it, two turns of a mission are two keys.
    if (typeof body.missionId !== 'string' || !body.missionId || typeof body.at !== 'number') return null;
    return { event: 'missionDone', key: `mission_turn_done:${body.missionId}:${body.at}` };
  }
  // A `question` / `kanban_plan` card is a permission request too: one
  // event covers every card an agent waits on.
  if (streamEvent === 'event' && body.type === 'permission_request') {
    const id = isRecord(body.payload) ? body.payload.id : undefined;
    if (typeof id !== 'string' || !id) return null;
    return { event: 'approval', key: `permission:${id}` };
  }
  return null;
}
