/**
 * The sound a user imported for an event: picked in the browser, decoded and
 * checked here (the browser's own decoder is what defines "every common
 * format"), then stored on the account's daemon so every device plays it.
 * The preference only says `custom` (`notification-sounds.ts`).
 */
import { CUSTOM_MAX_SECONDS, forgetCustomSound, hasCustomSound, loadCustomSound } from './notification-sound-player';
import { isSoundEvent, type SoundEvent } from './notification-sounds';

export const CUSTOM_MAX_BYTES = 1024 * 1024;

/** What the file picker offers: the containers the daemon accepts. */
export const CUSTOM_ACCEPT = 'audio/*,.mp3,.wav,.ogg,.oga,.opus,.flac,.m4a,.aac,.webm';

export type CustomSoundInfo = { name: string; size: number };
export type CustomSounds = Partial<Record<SoundEvent, CustomSoundInfo>>;

export type ImportOutcome =
  | { ok: true; name: string }
  | { ok: false; reason: 'too_large' | 'too_long' | 'unsupported' | 'no_audio' | 'failed' };

const URL_OF = (event: SoundEvent): string => `/api/ui/notifications/sounds/${event}`;

/** Which events have an imported sound on this account. */
export async function listCustomSounds(): Promise<CustomSounds> {
  try {
    const r = await fetch('/api/ui/notifications/sounds', { cache: 'no-store' });
    if (!r.ok) return {};
    const body = await r.json() as { sounds?: Record<string, Partial<CustomSoundInfo>> };
    const out: CustomSounds = {};
    for (const [event, info] of Object.entries(body.sounds ?? {})) {
      if (isSoundEvent(event)) {
        out[event] = { name: typeof info.name === 'string' ? info.name : '', size: Number(info.size) || 0 };
      }
    }
    return out;
  } catch {
    return {};
  }
}

const inflight = new Set<SoundEvent>();

/** Fetches and decodes the stored sound once; a no-op when already decoded. */
export async function restoreCustomSound(event: SoundEvent): Promise<boolean> {
  if (hasCustomSound(event)) return true;
  if (inflight.has(event)) return false;
  inflight.add(event);
  try {
    const r = await fetch(URL_OF(event), { cache: 'no-store' });
    if (!r.ok) return false;
    return (await loadCustomSound(event, await r.arrayBuffer())).ok;
  } catch {
    return false;
  } finally {
    inflight.delete(event);
  }
}

/** Checks the file by decoding it, then stores it. Nothing is stored on a refusal. */
export async function importCustomSound(event: SoundEvent, file: File): Promise<ImportOutcome> {
  if (file.size > CUSTOM_MAX_BYTES) return { ok: false, reason: 'too_large' };
  const bytes = await file.arrayBuffer();
  const decoded = await loadCustomSound(event, bytes);
  if (!decoded.ok) return { ok: false, reason: decoded.reason };
  try {
    const r = await fetch(URL_OF(event), {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'x-sound-name': encodeURIComponentSafe(file.name) },
      body: bytes,
    });
    if (!r.ok) {
      forgetCustomSound(event);
      return { ok: false, reason: r.status === 413 ? 'too_large' : r.status === 415 ? 'unsupported' : 'failed' };
    }
    return { ok: true, name: file.name };
  } catch {
    forgetCustomSound(event);
    return { ok: false, reason: 'failed' };
  }
}

export async function clearCustomSound(event: SoundEvent): Promise<boolean> {
  forgetCustomSound(event);
  try {
    return (await fetch(URL_OF(event), { method: 'DELETE' })).ok;
  } catch {
    return false;
  }
}

/** Header values are ASCII: keep the readable part of the name, bounded. */
function encodeURIComponentSafe(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, '_').slice(0, 80);
}

export { CUSTOM_MAX_SECONDS };
