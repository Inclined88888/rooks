import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUILTIN_SOUNDS,
  DEFAULT_NOTIFICATION_SOUND_PREFS,
  clampVolume,
  readNotificationSoundPrefs,
  setEventSound,
  soundTriggerOf,
  writeNotificationSoundPrefs,
} from './notification-sounds';
import { renderSound } from './notification-sound-synth';
import { CLAIM_TTL_MS, SOUND_GAP_MS, claimInStorage, claimSound, volumeGain, type ClaimLocks } from './notification-sound-player';

/**
 * A sound when a Kanban task is done, when one stops, and when an agent waits
 * on an approval — each with its own setting, one global volume.
 */

test('nothing stored, or garbage: the defaults, every event on but a task start', () => {
  for (const raw of [null, undefined, 'x', [], { v: 1 }, { events: 'nope' }]) {
    assert.deepEqual(readNotificationSoundPrefs(raw), DEFAULT_NOTIFICATION_SOUND_PREFS);
  }
  const { events } = DEFAULT_NOTIFICATION_SOUND_PREFS;
  assert.ok(events.taskDone.enabled && events.taskBlocked.enabled && events.approval.enabled);
  assert.notEqual(events.taskDone.sound, events.taskBlocked.sound, 'done and blocked do not sound the same');
  assert.equal(events.taskStarted.enabled, false, 'a task start is opt-in');
  assert.equal(DEFAULT_NOTIFICATION_SOUND_PREFS.taskStartedToast, false, 'its toast too');
});

test('a row stored before the task-start event reads it off, sound and toast', () => {
  const prefs = readNotificationSoundPrefs({ v: 1, volume: 80, events: { taskDone: { enabled: true, sound: 'bell' } } });
  assert.deepEqual(prefs.events.taskStarted, { enabled: false, sound: 'pop' });
  assert.equal(prefs.taskStartedToast, false);
  assert.equal(readNotificationSoundPrefs({ taskStartedToast: 'yes' }).taskStartedToast, false, 'only a real true opts in');
});

test('a stored row is read field by field: an unknown sound falls back, the rest stays', () => {
  const prefs = readNotificationSoundPrefs({
    v: 1,
    volume: 140,
    events: { taskDone: { enabled: false, sound: 'bell' }, approval: { sound: 'kazoo' } },
  });
  assert.equal(prefs.volume, 100);
  assert.deepEqual(prefs.events.taskDone, { enabled: false, sound: 'bell' });
  assert.deepEqual(prefs.events.approval, DEFAULT_NOTIFICATION_SOUND_PREFS.events.approval);
  assert.deepEqual(prefs.events.taskBlocked, DEFAULT_NOTIFICATION_SOUND_PREFS.events.taskBlocked);
});

test('volume is 0–100, rounded; garbage is the default', () => {
  assert.equal(clampVolume(-4), 0);
  assert.equal(clampVolume('35'), 35);
  assert.equal(clampVolume(33.6), 34);
  assert.equal(clampVolume('loud'), DEFAULT_NOTIFICATION_SOUND_PREFS.volume);
  assert.equal(volumeGain(0), 0);
  assert.equal(volumeGain(100), 1);
  assert.ok(volumeGain(50) < 0.5, 'the curve is perceptual, not linear');
});

test('what is written reads back the same', () => {
  const prefs = setEventSound(setEventSound(DEFAULT_NOTIFICATION_SOUND_PREFS, 'approval', { sound: 'ping' }), 'taskDone', { enabled: false });
  const row = writeNotificationSoundPrefs({ ...prefs, volume: 25, taskStartedToast: true });
  assert.equal(row.v, 1);
  assert.deepEqual(readNotificationSoundPrefs(JSON.parse(JSON.stringify(row))), { ...prefs, volume: 25, taskStartedToast: true });
});

test('stream messages map to an event and a cross-tab key', () => {
  assert.deepEqual(soundTriggerOf('task_done', '{"kind":"task_done","taskId":"t1"}'), { event: 'taskDone', key: 'task_done:t1' });
  assert.deepEqual(soundTriggerOf('task_blocked', '{"kind":"task_blocked","taskId":"t2"}'), { event: 'taskBlocked', key: 'task_blocked:t2' });
  const permission = JSON.stringify({ kind: 'event', missionId: 'm', type: 'permission_request', timestamp: 1, payload: { id: 'p9', tool_name: 'ask_user' } });
  assert.deepEqual(soundTriggerOf('event', permission), { event: 'approval', key: 'permission:p9' });
  assert.deepEqual(
    soundTriggerOf('task_started', '{"kind":"task_started","taskId":"t3","title":"Ship it"}'),
    { event: 'taskStarted', key: 'task_started:t3', title: 'Ship it' },
  );
  assert.equal(soundTriggerOf('task_started', '{"kind":"task_started"}'), null);
});

test('anything else plays nothing', () => {
  assert.equal(soundTriggerOf('event', JSON.stringify({ kind: 'event', type: 'assistant', payload: { text: '"type":"permission_request"' } })), null);
  assert.equal(soundTriggerOf('event', JSON.stringify({ kind: 'event', type: 'permission_resolved', payload: { id: 'p9' } })), null);
  assert.equal(soundTriggerOf('event', '{"kind":"event","type":"permission_request","payload":{}}'), null);
  assert.equal(soundTriggerOf('task_done', '{"kind":"task_done"}'), null);
  assert.equal(soundTriggerOf('task_done', 'not json'), null);
  assert.equal(soundTriggerOf('mission_complete', '{"taskId":"t1"}'), null);
});

test('every built-in sound renders short, bounded, and starts and ends silent', () => {
  for (const id of BUILTIN_SOUNDS) {
    const samples = renderSound(id, 22050);
    assert.ok(samples.length > 2000 && samples.length < 22050 * 1.5, `${id} lasts under 1.5 s`);
    let peak = 0;
    for (const s of samples) peak = Math.max(peak, Math.abs(s));
    assert.ok(peak > 0.1 && peak <= 1, `${id} is audible and never clips (${peak})`);
    assert.ok(Math.abs(samples[0]!) < 0.01, `${id} has no click at the start`);
    assert.ok(Math.abs(samples[samples.length - 1]!) < 0.01, `${id} has no click at the end`);
  }
});

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}

test('two tabs, one message: one plays', () => {
  const shared = memoryStorage();
  assert.equal(claimInStorage(shared, 'task_done:t1', 'taskDone', 1_000), true);
  assert.equal(claimInStorage(shared, 'task_done:t1', 'taskDone', 1_010), false);
});

test('a burst of one kind gives one sound; another kind still plays', () => {
  const shared = memoryStorage();
  assert.equal(claimInStorage(shared, 'task_done:a', 'taskDone', 1_000), true);
  assert.equal(claimInStorage(shared, 'task_done:b', 'taskDone', 1_200), false);
  assert.equal(claimInStorage(shared, 'permission:p', 'approval', 1_300), true);
  assert.equal(claimInStorage(shared, 'task_done:c', 'taskDone', 1_000 + SOUND_GAP_MS), true);
});

test('played keys are forgotten after the TTL, and garbage in storage is survived', () => {
  const shared = memoryStorage();
  claimInStorage(shared, 'task_done:old', 'taskDone', 0);
  claimInStorage(shared, 'task_done:new', 'taskDone', CLAIM_TTL_MS + 10);
  assert.ok(!shared.data.get('timon.notification-sounds.claims')!.includes('task_done:old'));
  shared.data.set('timon.notification-sounds.claims', '{oops');
  assert.equal(claimInStorage(shared, 'task_done:x', 'taskDone', 5), true);
});

test('the claim runs under the cross-tab lock when there is one, and plays alone without storage', async () => {
  const names: string[] = [];
  const locks: ClaimLocks = { request: async (name, callback) => { names.push(name); return callback(); } };
  const shared = memoryStorage();
  assert.equal(await claimSound('k', 'taskDone', { storage: shared, locks, now: () => 1 }), true);
  assert.equal(await claimSound('k', 'taskDone', { storage: shared, locks, now: () => 2 }), false);
  assert.deepEqual(names, ['timon.notification-sounds', 'timon.notification-sounds']);
  assert.equal(await claimSound('k', 'taskDone', { storage: null, locks: null, now: () => 3 }), true);
  const broken: ClaimLocks = { request: async () => { throw new Error('no locks here'); } };
  assert.equal(await claimSound('k2', 'approval', { storage: shared, locks: broken, now: () => 4 }), true, 'a failing lock falls back to the storage alone');
});

test('an imported sound is a choice a stored row may name, an unknown one still falls back', () => {
  const prefs = readNotificationSoundPrefs({
    events: { taskDone: { sound: 'custom' }, taskBlocked: { sound: 'file:///etc/passwd' } },
  });
  assert.equal(prefs.events.taskDone.sound, 'custom');
  assert.equal(prefs.events.taskBlocked.sound, DEFAULT_NOTIFICATION_SOUND_PREFS.events.taskBlocked.sound);
  assert.equal(writeNotificationSoundPrefs(prefs).events.taskDone.sound, 'custom');
});

test('a finished turn is its own event, one key per turn', () => {
  const a = soundTriggerOf('mission_turn_done', JSON.stringify({ kind: 'mission_turn_done', missionId: 'm1', at: 1 }));
  const b = soundTriggerOf('mission_turn_done', JSON.stringify({ kind: 'mission_turn_done', missionId: 'm1', at: 2 }));
  assert.equal(a?.event, 'missionDone');
  assert.notEqual(a?.key, b?.key, 'two turns of one mission both sound');
  assert.equal(soundTriggerOf('mission_turn_done', JSON.stringify({ missionId: 'm1' })), null);
  assert.equal(DEFAULT_NOTIFICATION_SOUND_PREFS.events.missionDone.enabled, true);
});
