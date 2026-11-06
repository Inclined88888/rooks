import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_NOTIFICATION_SOUND_PREFS,
  readNotificationSoundPrefs,
  setEventSound,
  type NotificationSoundPrefs,
  type SoundChoice,
  type SoundEvent,
} from '@/lib/notification-sounds';
import { HIDDEN_TAB_DELAY_MS } from '@/lib/notification-sound-player';
import { startNotificationSounds, type SoundBehaviorDeps } from './notification-sounds';

/**
 * The behavior listens to the stream every tab already shares, and plays one
 * sound per event in ONE tab — preferring a visible one.
 */

type Listener = (event: MessageEvent) => void;

function fakeStream() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    on(type: string, listener: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
      return () => { listeners.get(type)?.delete(listener); };
    },
    emit(type: string, body: unknown) {
      for (const listener of listeners.get(type) ?? []) listener({ data: JSON.stringify(body) } as MessageEvent);
    },
    count: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  };
}

function sharedStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
}

type Tab = { played: Array<[SoundChoice, number]>; toasts: string[]; waits: number[]; stop: () => void };

function tab(
  stream: ReturnType<typeof fakeStream>,
  opts: { prefs?: NotificationSoundPrefs | null; canPlay?: boolean; visible?: boolean; storage?: ReturnType<typeof sharedStorage>; clock?: () => number } = {},
): Tab {
  const played: Array<[SoundChoice, number]> = [];
  const toasts: string[] = [];
  const waits: number[] = [];
  const storage = opts.storage ?? sharedStorage();
  const deps: SoundBehaviorDeps = {
    on: stream.on,
    prefs: () => (opts.prefs === undefined ? DEFAULT_NOTIFICATION_SOUND_PREFS : opts.prefs),
    canPlay: () => opts.canPlay ?? true,
    visible: () => opts.visible ?? true,
    claimEnv: () => ({ storage, locks: null, now: opts.clock ?? (() => Date.now()) }),
    play: (sound, volume) => { played.push([sound, volume]); return true; },
    toast: (title) => { toasts.push(title); },
    wait: async (ms) => { waits.push(ms); },
  };
  return { played, toasts, waits, stop: startNotificationSounds(deps) };
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });
const permission = (id: string) => ({ kind: 'event', missionId: 'm1', type: 'permission_request', timestamp: 1, payload: { id, tool_name: 'ask_user' } });

test('each event plays its own sound at the global volume', async () => {
  const stream = fakeStream();
  let now = 0;
  const t = tab(stream, { clock: () => (now += 10_000) });
  stream.emit('task_done', { kind: 'task_done', taskId: 't1' });
  stream.emit('task_blocked', { kind: 'task_blocked', taskId: 't2' });
  stream.emit('event', permission('p1'));
  await settle();
  assert.deepEqual(t.played, [['chime', 60], ['fall', 60], ['rise', 60]]);
  t.stop();
});

test('a disabled event, a muted volume or unknown settings play nothing', async () => {
  const stream = fakeStream();
  const off = tab(stream, { prefs: setEventSound(DEFAULT_NOTIFICATION_SOUND_PREFS, 'taskDone', { enabled: false }) });
  const muted = tab(stream, { prefs: { ...DEFAULT_NOTIFICATION_SOUND_PREFS, volume: 0 } });
  const loading = tab(stream, { prefs: null });
  stream.emit('task_done', { kind: 'task_done', taskId: 't1' });
  await settle();
  assert.deepEqual([off.played, muted.played, loading.played], [[], [], []]);
  for (const t of [off, muted, loading]) t.stop();
});

test('two tabs receive the message; only one plays it', async () => {
  const stream = fakeStream();
  const storage = sharedStorage();
  const a = tab(stream, { storage });
  const b = tab(stream, { storage });
  stream.emit('event', permission('p2'));
  await settle();
  assert.equal(a.played.length + b.played.length, 1);
  a.stop(); b.stop();
});

test('a hidden tab leaves the sound to a visible one, and still plays when alone', async () => {
  const stream = fakeStream();
  const storage = sharedStorage();
  const hidden = tab(stream, { storage, visible: false });
  const visible = tab(stream, { storage, visible: true });
  stream.emit('task_done', { kind: 'task_done', taskId: 't3' });
  await settle();
  assert.deepEqual(hidden.waits, [HIDDEN_TAB_DELAY_MS]);
  assert.equal(visible.played.length, 1);
  assert.equal(hidden.played.length, 0);
  visible.stop(); hidden.stop();

  const solo = fakeStream();
  const lone = tab(solo, { visible: false });
  solo.emit('task_done', { kind: 'task_done', taskId: 't4' });
  await settle();
  assert.equal(lone.played.length, 1);
  lone.stop();
});

test('a tab nobody has clicked yet never takes the sound from one that can play', async () => {
  const stream = fakeStream();
  const storage = sharedStorage();
  const locked = tab(stream, { storage, canPlay: false });
  const unlocked = tab(stream, { storage, visible: false });
  stream.emit('task_done', { kind: 'task_done', taskId: 't5' });
  await settle();
  assert.equal(locked.played.length, 0);
  assert.equal(unlocked.played.length, 1);
  locked.stop(); unlocked.stop();
});

test('stopping the behavior unsubscribes from the stream', () => {
  const stream = fakeStream();
  const t = tab(stream);
  assert.equal(stream.count(), 5);
  t.stop();
  assert.equal(stream.count(), 0);
});

test('the event travels with the sound, so an imported file is the event\'s own', async () => {
  const stream = fakeStream();
  const prefs = readNotificationSoundPrefs({ events: { taskDone: { sound: 'custom' } } });
  const seen: Array<[SoundChoice, SoundEvent]> = [];
  const deps: SoundBehaviorDeps = {
    on: stream.on,
    prefs: () => prefs,
    canPlay: () => true,
    visible: () => true,
    claimEnv: () => ({ storage: sharedStorage(), locks: null, now: () => Date.now() }),
    play: (sound, _volume, event) => { seen.push([sound, event]); return true; },
    toast: () => {},
    wait: async () => {},
  };
  const stop = startNotificationSounds(deps);
  stream.emit('task_done', { kind: 'task_done', taskId: 't-custom' });
  await settle();
  stop();
  assert.deepEqual(seen, [['custom', 'taskDone']]);
});

const started = (taskId: string, title = 'Ship it') => ({ kind: 'task_started', taskId, title });
const startOn = (toast: boolean) => ({
  ...setEventSound(DEFAULT_NOTIFICATION_SOUND_PREFS, 'taskStarted', { enabled: true }),
  taskStartedToast: toast,
});

test('a task start is silent and shows nothing by default', async () => {
  const stream = fakeStream();
  const t = tab(stream);
  stream.emit('task_started', started('s0'));
  await settle();
  assert.deepEqual([t.played, t.toasts], [[], []]);
  t.stop();
});

test('a task start, switched on, plays its sound and shows its toast once across tabs', async () => {
  const stream = fakeStream();
  const storage = sharedStorage();
  let now = 0;
  const clock = () => (now += 10_000);
  const a = tab(stream, { storage, prefs: startOn(true), clock });
  const b = tab(stream, { storage, prefs: startOn(true), clock });
  stream.emit('task_started', started('s1'));
  await settle();
  assert.deepEqual([...a.played, ...b.played], [['pop', 60]]);
  assert.deepEqual([...a.toasts, ...b.toasts], ['Ship it'], 'the toast does not take the sound\'s claim, nor the reverse');
  a.stop(); b.stop();
});

test('the toast of a task start shows with the volume at zero, the sound off, or audio still locked', async () => {
  const stream = fakeStream();
  const muted = tab(stream, { prefs: { ...startOn(true), volume: 0 } });
  const soundOff = tab(stream, { prefs: { ...DEFAULT_NOTIFICATION_SOUND_PREFS, taskStartedToast: true } });
  const locked = tab(stream, { prefs: startOn(true), canPlay: false });
  stream.emit('task_started', started('s2', 'Quiet'));
  await settle();
  for (const t of [muted, soundOff, locked]) {
    assert.deepEqual(t.played, []);
    assert.deepEqual(t.toasts, ['Quiet']);
    t.stop();
  }
});

test('the same start received twice plays and shows once', async () => {
  const stream = fakeStream();
  let now = 0;
  const t = tab(stream, { prefs: startOn(true), clock: () => (now += 10_000) });
  stream.emit('task_started', started('s3'));
  stream.emit('task_started', started('s3'));
  await settle();
  assert.equal(t.played.length, 1);
  assert.equal(t.toasts.length, 1);
  t.stop();
});
