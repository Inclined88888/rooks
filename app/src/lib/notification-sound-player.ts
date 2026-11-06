/**
 * Plays the notification sounds, and decides which tab plays them.
 *
 * Autoplay. Browsers and Electron keep an `AudioContext` suspended until the
 * page has seen a gesture. The context is therefore created, and resumed, from
 * a click or a key press only (`installAudioUnlock`); a tab nobody has touched
 * yet stays silent and leaves the sound to another tab rather than trying a
 * `play()` the browser would refuse.
 *
 * One tab. Every tab of the account receives the same stream message. The
 * first tab to write the message's key under a cross-tab lock plays it; a
 * hidden tab waits a little first, so a visible one wins when there is one,
 * and a hidden one still plays when Timon sits behind another window — which
 * is the point of a sound. The same store spaces two sounds of one kind
 * (`SOUND_GAP_MS`): ten tasks closing together give one chime, not ten.
 */
import {
  CUSTOM_SOUND,
  DEFAULT_NOTIFICATION_SOUND_PREFS,
  type SoundChoice,
  type SoundEvent,
  type SoundId,
} from './notification-sounds';
import { renderSound } from './notification-sound-synth';
import { machineLocalStorage } from '@/lib/machines/machine-storage';

type AudioContextCtor = new () => AudioContext;

let context: AudioContext | null = null;
const buffers = new Map<SoundId, AudioBuffer>();
/** The files the user imported, decoded once per event. */
const customBuffers = new Map<SoundEvent, AudioBuffer>();
/** Longest imported sound: a notification, not a track. */
export const CUSTOM_MAX_SECONDS = 10;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const legacy = (window as Window & { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  return window.AudioContext ?? legacy ?? null;
}

function ensureContext(): AudioContext | null {
  if (context && context.state !== 'closed') return context;
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  try {
    context = new Ctor();
    buffers.clear();
    customBuffers.clear();
  } catch {
    context = null;
  }
  return context;
}

/** This tab can make a sound right now. */
export function audioUnlocked(): boolean {
  return context?.state === 'running';
}

const GESTURES = ['pointerdown', 'keydown', 'touchend'] as const;

/**
 * Creates or resumes the context on every gesture while it is not running.
 * Kept installed: Safari suspends a running context again after an
 * interruption (a call, another app taking the audio).
 */
export function installAudioUnlock(): () => void {
  if (typeof window === 'undefined') return () => {};
  const onGesture = (): void => {
    if (context?.state === 'running') return;
    const ctx = ensureContext();
    if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => { /* refused: the next gesture retries */ });
  };
  for (const name of GESTURES) window.addEventListener(name, onGesture, { capture: true, passive: true });
  return () => {
    for (const name of GESTURES) window.removeEventListener(name, onGesture, { capture: true });
  };
}

/** The slider is linear to the eye; the ear is not. */
export function volumeGain(volume: number): number {
  const v = Math.min(100, Math.max(0, volume)) / 100;
  return v * v;
}

function startBuffer(ctx: AudioContext, buffer: AudioBuffer, volume: number): void {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = volumeGain(volume);
  source.connect(gain).connect(ctx.destination);
  source.start();
}

function start(ctx: AudioContext, id: SoundId, volume: number): void {
  let buffer = buffers.get(id);
  if (!buffer) {
    const samples = renderSound(id, ctx.sampleRate);
    buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buffer.getChannelData(0).set(samples);
    buffers.set(id, buffer);
  }
  startBuffer(ctx, buffer, volume);
}

export type CustomDecode =
  | { ok: true; seconds: number }
  | { ok: false; reason: 'unsupported' | 'too_long' | 'no_audio' };

/**
 * Decodes an imported file with the browser's own decoder — which is what
 * makes "every common format" mean the formats this browser plays — and keeps
 * it for `event`. Nothing is kept on a refusal.
 */
export async function loadCustomSound(event: SoundEvent, bytes: ArrayBuffer): Promise<CustomDecode> {
  const ctx = ensureContext();
  if (!ctx) return { ok: false, reason: 'no_audio' };
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(bytes.slice(0));
  } catch {
    return { ok: false, reason: 'unsupported' };
  }
  if (!(decoded.duration > 0) || decoded.duration > CUSTOM_MAX_SECONDS) return { ok: false, reason: 'too_long' };
  customBuffers.set(event, decoded);
  return { ok: true, seconds: decoded.duration };
}

export function forgetCustomSound(event: SoundEvent): void {
  customBuffers.delete(event);
}

export function hasCustomSound(event: SoundEvent): boolean {
  return customBuffers.has(event);
}

/** Plays if the tab is unlocked; `false` when it could not. An imported sound
 *  that is not decoded (yet) plays the event's built-in default instead. */
export function playSound(choice: SoundChoice, volume: number, event?: SoundEvent): boolean {
  if (!context || context.state !== 'running') return false;
  try {
    if (choice === CUSTOM_SOUND) {
      const custom = event ? customBuffers.get(event) : undefined;
      if (custom) { startBuffer(context, custom, volume); return true; }
      start(context, event ? DEFAULT_NOTIFICATION_SOUND_PREFS.events[event].sound as SoundId : 'chime', volume);
      return true;
    }
    start(context, choice, volume);
    return true;
  } catch {
    return false;
  }
}

/** The settings' "listen" button: called from a click, so it may unlock. */
export function previewSound(id: SoundChoice, volume: number, event?: SoundEvent): void {
  const ctx = ensureContext();
  if (!ctx) return;
  if (ctx.state === 'running') { playSound(id, volume, event); return; }
  void ctx.resume().then(() => { playSound(id, volume, event); }).catch(() => { /* no audio device */ });
}

// ── Cross-tab claim ──────────────────────────────────────────────────────

export const CLAIM_STORAGE_KEY = 'timon.notification-sounds.claims';
const CLAIM_LOCK = 'timon.notification-sounds';
/** How long a played key is remembered: longer than any stream delay. */
export const CLAIM_TTL_MS = 120_000;
/** Minimum spacing between two sounds of the same kind, across tabs. */
export const SOUND_GAP_MS = 1_500;
/** How long a hidden tab leaves a visible one to claim first. */
export const HIDDEN_TAB_DELAY_MS = 400;

/** What two claims are spaced within: an event's sound, or the toast of a
 *  task start — which must not take the spacing of the sound it goes with. */
export type ClaimBucket = SoundEvent | 'taskStartedToast';

type Claims = { keys: Record<string, number>; last: Partial<Record<ClaimBucket, number>> };

type ClaimStorage = Pick<Storage, 'getItem' | 'setItem'>;

export type ClaimLocks = {
  request(name: string, callback: () => boolean): Promise<boolean>;
};

export type ClaimEnv = {
  /** `null`: no shared storage, the tab plays alone. */
  storage: ClaimStorage | null;
  /** `null`: no Web Locks (old Safari); the claim is then best effort. */
  locks: ClaimLocks | null;
  now: () => number;
};

function readClaims(storage: ClaimStorage): Claims {
  try {
    const raw: unknown = JSON.parse(storage.getItem(CLAIM_STORAGE_KEY) ?? 'null');
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const { keys, last } = raw as Partial<Claims>;
      return {
        keys: typeof keys === 'object' && keys !== null ? keys : {},
        last: typeof last === 'object' && last !== null ? last : {},
      };
    }
  } catch { /* unreadable: start over */ }
  return { keys: {}, last: {} };
}

/** The decision, made while holding the lock. */
export function claimInStorage(storage: ClaimStorage, key: string, event: ClaimBucket, now: number): boolean {
  const claims = readClaims(storage);
  for (const [k, at] of Object.entries(claims.keys)) {
    if (typeof at !== 'number' || now - at > CLAIM_TTL_MS) delete claims.keys[k];
  }
  if (claims.keys[key] !== undefined) return false;
  claims.keys[key] = now;
  const last = claims.last[event];
  const spaced = typeof last !== 'number' || now - last >= SOUND_GAP_MS;
  if (spaced) claims.last[event] = now;
  try {
    storage.setItem(CLAIM_STORAGE_KEY, JSON.stringify(claims));
  } catch {
    // Storage full or refused: playing beats staying silent.
    return true;
  }
  return spaced;
}

export async function claimSound(key: string, event: ClaimBucket, env: ClaimEnv): Promise<boolean> {
  const { storage } = env;
  if (!storage) return true;
  const decide = (): boolean => claimInStorage(storage, key, event, env.now());
  if (!env.locks) return decide();
  try {
    return await env.locks.request(CLAIM_LOCK, decide);
  } catch {
    return decide();
  }
}

/** The browser's own claim environment. */
export function browserClaimEnv(): ClaimEnv {
  let storage: ClaimStorage | null = null;
  try { storage = machineLocalStorage(); } catch { storage = null; }
  const locks = typeof navigator !== 'undefined' && navigator.locks
    ? { request: (name: string, callback: () => boolean) => navigator.locks.request(name, callback) }
    : null;
  return { storage, locks, now: () => Date.now() };
}

/** Test hook: forget the context of a previous test. */
export function resetNotificationSoundPlayerForTest(): void {
  context = null;
  buffers.clear();
  customBuffers.clear();
}
